/**
 * Scanner breadcrumb wiring.
 *
 * `scannerBreadcrumbs.test.ts` proves the privacy rules and that a trail
 * reaches a crash report. This file proves the *screens* actually leave that
 * trail: both scanner screens are rendered and driven through real camera
 * callbacks, and the recorded events are asserted at the lifecycle points the
 * issue calls out (scan started, item deduped, item queued).
 *
 * The emitter is injected, so the Sentry SDK is never loaded here — the point
 * is the screens' wiring, not the reporter.
 */

import React from 'react';
import { Alert } from 'react-native';
import { act, render } from '@testing-library/react-native';

const mockQueueClaimConfirmation = jest.fn();

jest.mock('expo-camera', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  return {
    // Renders as a plain View so the test can invoke the scan callback the
    // screen hands to the camera.
    CameraView: (props: Record<string, unknown>) =>
      ReactModule.createElement(View, { testID: 'camera-view', ...props }),
  };
});

jest.mock('../hooks/useCameraPermission', () => ({
  useCameraPermission: () => ({
    permissionState: 'granted',
    isGranted: true,
    isDenied: false,
    isBlocked: false,
    isChecking: false,
    requestPermission: jest.fn(),
    openSettings: jest.fn(),
    statusMessage: '',
  }),
}));

jest.mock('../theme/ThemeContext', () => ({
  useTheme: () => ({
    colors: {
      background: '#000000',
      textPrimary: '#ffffff',
      success: '#00ff00',
      error: '#ff0000',
      warning: '#ffff00',
      brand: { primary: '#0000ff' },
    },
  }),
}));

jest.mock('../i18n/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

jest.mock('../contexts/SyncContext', () => ({
  useSync: () => ({
    queueClaimConfirmation: mockQueueClaimConfirmation,
    isConnected: true,
  }),
}));

jest.mock('../components/CameraPermissionDenied', () => ({
  CameraPermissionDenied: () => null,
}));

import { ScannerScreen } from '../screens/ScannerScreen';
import { BulkScannerScreen } from '../screens/BulkScannerScreen';
import {
  setScannerBreadcrumbEmitter,
  type ScannerBreadcrumbEmitter,
} from '../services/scannerBreadcrumbs';

interface RecordedBreadcrumb {
  category: string;
  message: string;
  data?: Record<string, unknown>;
}

let recorded: RecordedBreadcrumb[] = [];

const collectBreadcrumb: ScannerBreadcrumbEmitter = (category, message, data) => {
  recorded.push({ category, message, data });
};

const messages = () => recorded.map((breadcrumb) => breadcrumb.message);
const findBreadcrumb = (message: string) =>
  recorded.find((breadcrumb) => breadcrumb.message === message);

const createNavigation = () => ({ replace: jest.fn(), goBack: jest.fn() });

beforeEach(() => {
  recorded = [];
  mockQueueClaimConfirmation.mockReset();
  setScannerBreadcrumbEmitter(collectBreadcrumb);
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});

afterEach(() => {
  setScannerBreadcrumbEmitter(null);
  jest.restoreAllMocks();
});

describe('ScannerScreen breadcrumbs', () => {
  it('records session start, the scan, navigation, and the deduped repeat', () => {
    const navigation = createNavigation();
    const view = render(<ScannerScreen navigation={navigation as any} />);

    expect(findBreadcrumb('scan_session_started')?.data).toMatchObject({
      mode: 'single',
      screen: 'Scanner',
    });

    const camera = view.getByTestId('camera-view');

    act(() => {
      camera.props.onBarcodeScanned({ data: 'soter://package/aid-123' });
      // The camera fires again before React re-renders — the real dedupe path.
      camera.props.onBarcodeScanned({ data: 'soter://package/aid-123' });
    });

    expect(navigation.replace).toHaveBeenCalledWith('AidDetails', {
      aidId: 'aid-123',
    });
    expect(messages()).toEqual(
      expect.arrayContaining([
        'scan_received',
        'scan_navigated',
        'scan_deduplicated',
      ]),
    );
    expect(findBreadcrumb('scan_deduplicated')?.data).toMatchObject({
      mode: 'single',
      dedupeWindowMs: 1500,
    });

    view.unmount();

    expect(findBreadcrumb('scan_session_ended')?.data).toMatchObject({
      mode: 'single',
      scanned: 1,
      verified: 1,
      skipped: 1,
      failed: 0,
    });
  });

  it('records a parse failure without recording the scanned content', () => {
    const view = render(
      <ScannerScreen navigation={createNavigation() as any} />,
    );

    act(() => {
      view
        .getByTestId('camera-view')
        .props.onBarcodeScanned({ data: 'https://example.com/not-a-soter-link' });
    });

    expect(findBreadcrumb('scan_parse_failed')?.data).toMatchObject({
      mode: 'single',
      reason: 'invalid_soter_qr',
    });
    expect(Alert.alert).toHaveBeenCalled();

    // The trail must not be a transcript of what was scanned.
    const trail = JSON.stringify(recorded);
    expect(trail).not.toContain('example.com');
    expect(trail).not.toContain('not-a-soter-link');
  });
});

describe('BulkScannerScreen breadcrumbs', () => {
  it('records a queued package and a deduped repeat', async () => {
    mockQueueClaimConfirmation.mockResolvedValue({ status: 'queued' });

    const view = render(
      <BulkScannerScreen navigation={createNavigation() as any} />,
    );
    const camera = view.getByTestId('camera-view');

    expect(findBreadcrumb('scan_session_started')?.data).toMatchObject({
      mode: 'bulk',
      screen: 'BulkScanner',
    });

    await act(async () => {
      const firstScan = camera.props.onBarcodeScanned({
        data: 'soter://package/aid-9',
      });
      camera.props.onBarcodeScanned({ data: 'soter://package/aid-9' });
      await firstScan;
    });

    expect(findBreadcrumb('scan_queued')?.data).toMatchObject({
      mode: 'bulk',
      queueStatus: 'queued',
    });
    expect(findBreadcrumb('scan_deduplicated')?.data).toMatchObject({
      mode: 'bulk',
    });

    view.unmount();

    expect(findBreadcrumb('scan_session_ended')?.data).toMatchObject({
      mode: 'bulk',
      scanned: 1,
      verified: 1,
      skipped: 1,
    });
  });

  it('records a verification failure by error type only', async () => {
    mockQueueClaimConfirmation.mockRejectedValue(new TypeError('offline'));

    const view = render(
      <BulkScannerScreen navigation={createNavigation() as any} />,
    );

    await act(async () => {
      await view
        .getByTestId('camera-view')
        .props.onBarcodeScanned({ data: 'soter://package/aid-7' });
    });

    expect(findBreadcrumb('scan_failed')?.data).toMatchObject({
      mode: 'bulk',
      reason: 'verification_failed',
      errorType: 'TypeError',
    });

    view.unmount();
  });

  it('records an invalid code as a parse failure, not a verification failure', async () => {
    const view = render(
      <BulkScannerScreen navigation={createNavigation() as any} />,
    );

    await act(async () => {
      await view
        .getByTestId('camera-view')
        .props.onBarcodeScanned({ data: 'not-a-soter-code' });
    });

    expect(findBreadcrumb('scan_parse_failed')?.data).toMatchObject({
      mode: 'bulk',
      reason: 'invalid_soter_qr',
    });
    expect(findBreadcrumb('scan_failed')).toBeUndefined();
    expect(mockQueueClaimConfirmation).not.toHaveBeenCalled();

    view.unmount();
  });
});
