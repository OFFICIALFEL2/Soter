/**
 * Scanner breadcrumbs: privacy rules, and the crash report the trail lands in.
 *
 * The Sentry SDK boundary is faked (a real client needs a native module and a
 * live DSN), but everything this side of it is real: the breadcrumb builder,
 * `services/crashReporting`, its `beforeSend` scrubber, and the emit path the
 * scanner screens use. The simulated crash therefore travels the same route a
 * real one does.
 */

jest.mock('@sentry/react-native', () => {
  const breadcrumbs: Array<Record<string, unknown>> = [];
  const reports: Array<Record<string, any>> = [];
  let beforeSend: ((event: Record<string, any>) => Record<string, any>) | undefined;

  return {
    __esModule: true,
    __fakeSentry: {
      breadcrumbs,
      reports,
      reset(): void {
        breadcrumbs.length = 0;
        reports.length = 0;
      },
    },
    init: (options: { beforeSend?: typeof beforeSend }) => {
      beforeSend = options?.beforeSend;
    },
    addBreadcrumb: (breadcrumb: Record<string, unknown>) => {
      breadcrumbs.push(breadcrumb);
    },
    captureException: (error: Error) => {
      const event = {
        exception: { values: [{ type: 'Error', value: error?.message }] },
        // A real client attaches the buffer it has accumulated.
        breadcrumbs: { values: [...breadcrumbs] },
        extra: {},
        tags: {},
      };
      reports.push(beforeSend ? beforeSend(event) : event);
    },
    withScope: (callback: (scope: { setExtra: () => void }) => void) =>
      callback({ setExtra: () => {} }),
    setExtras: jest.fn(),
    enableSessionTracking: jest.fn(),
    close: jest.fn(),
    flush: jest.fn().mockResolvedValue(true),
  };
});

import {
  MAX_BREADCRUMB_VALUE_LENGTH,
  SCANNER_BREADCRUMB_CATEGORY,
  bucketContentLength,
  buildScannerBreadcrumb,
  isRecordableValue,
  sanitizeScannerBreadcrumbData,
  scannerBreadcrumbs,
  setScannerBreadcrumbEmitter,
} from '../services/scannerBreadcrumbs';
import {
  addBreadcrumb,
  captureError,
  initCrashReporting,
} from '../services/crashReporting';

const fakeSentry = (jest.requireMock('@sentry/react-native') as any)
  .__fakeSentry as {
  breadcrumbs: Array<Record<string, any>>;
  reports: Array<Record<string, any>>;
  reset: () => void;
};

const RAW_SCAN = 'soter://package/beneficiary-42-secret-package-id';
// A real Stellar public key is 56 characters (leading G + 55 base32 chars).
// The length is asserted below, because a 55-char fixture silently stops
// matching the scrubber pattern and makes the privacy test pass vacuously.
const STELLAR_KEY =
  'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

describe('scanner breadcrumb privacy', () => {
  it('drops data keys that are not on the event allowlist', () => {
    const { data, droppedFields } = sanitizeScannerBreadcrumbData(
      'scan_received',
      {
        mode: 'single',
        contentLengthBucket: '0-32',
        // All of these are the things this module exists to keep off the wire.
        data: RAW_SCAN,
        aidId: 'beneficiary-42',
        rawValue: RAW_SCAN,
      },
    );

    expect(data).toEqual({ mode: 'single', contentLengthBucket: '0-32' });
    expect(droppedFields).toBe(3);
    expect(JSON.stringify(data)).not.toContain('beneficiary-42');
  });

  it('omits a content-shaped value even under an allowlisted key', () => {
    const { data, droppedFields } = sanitizeScannerBreadcrumbData(
      'scan_navigated',
      {
        mode: 'single',
        // `target` is allowlisted, but a caller could still pass scan data.
        target: RAW_SCAN,
      },
    );

    expect(data.target).toBe('[omitted]');
    expect(droppedFields).toBe(1);
    expect(JSON.stringify(data)).not.toContain('package');
  });

  it('omits deep links, URLs, Stellar keys, and over-long values', () => {
    // Guard the fixture itself: a short "key" would pass vacuously.
    expect(STELLAR_KEY).toHaveLength(56);
    expect(isRecordableValue(RAW_SCAN)).toBe(false);
    expect(isRecordableValue('https://soter.app/package/abc')).toBe(false);
    expect(isRecordableValue(STELLAR_KEY)).toBe(false);
    expect(isRecordableValue('x'.repeat(MAX_BREADCRUMB_VALUE_LENGTH + 1))).toBe(
      false,
    );

    // Type names and enum values are exactly what should survive.
    expect(isRecordableValue('queued')).toBe(true);
    expect(isRecordableValue('TypeError')).toBe(true);
  });

  it('reports only a coarse bucket for scan length', () => {
    expect(bucketContentLength(0)).toBe('0-32');
    expect(bucketContentLength(32)).toBe('0-32');
    expect(bucketContentLength(33)).toBe('33-64');
    expect(bucketContentLength(64)).toBe('33-64');
    expect(bucketContentLength(128)).toBe('65-128');
    expect(bucketContentLength(129)).toBe('129+');

    const breadcrumb = buildScannerBreadcrumb('scan_received', {
      mode: 'bulk',
      contentLengthBucket: bucketContentLength(RAW_SCAN.length),
    });
    // The exact length must not be recoverable from the breadcrumb.
    expect(breadcrumb.data).not.toHaveProperty('contentLength');
  });

  it('does not report an unset optional key as a dropped field', () => {
    const { droppedFields } = sanitizeScannerBreadcrumbData('scan_failed', {
      mode: 'bulk',
      reason: 'verification_failed',
      errorType: undefined,
    });

    expect(droppedFields).toBe(0);
  });
});

describe('scanner breadcrumbs in a crash report', () => {
  beforeAll(() => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = 'https://example.invalid/1';
    initCrashReporting(true);
  });

  beforeEach(() => {
    fakeSentry.reset();
    // The real crash reporter's addBreadcrumb — the same function
    // CrashReportingProvider injects — so the trail is proven to reach the
    // report rather than a test double.
    setScannerBreadcrumbEmitter(addBreadcrumb);
  });

  afterAll(() => {
    delete process.env.EXPO_PUBLIC_SENTRY_DSN;
    setScannerBreadcrumbEmitter(null);
  });

  it('carries the scanner trail into a simulated crash during a bulk scan', () => {
    // A bulk session that queues a package, skips a repeat, then hits an
    // invalid code — the sequence a crash report needs to be interpretable.
    scannerBreadcrumbs.sessionStarted('bulk', 'BulkScanner');
    scannerBreadcrumbs.scanReceived('bulk', RAW_SCAN.length, 'deep_link');
    scannerBreadcrumbs.scanQueued('bulk', 'queued');
    scannerBreadcrumbs.scanDeduplicated('bulk', 1500);
    scannerBreadcrumbs.scanParseFailed('bulk', 'invalid_soter_qr', 18);

    captureError(new Error('simulated crash during scanning'));

    expect(fakeSentry.reports).toHaveLength(1);
    const report = fakeSentry.reports[0];
    const trail = (report.breadcrumbs?.values ?? []).map(
      (crumb: Record<string, any>) => crumb.message,
    );

    expect(trail).toEqual([
      'scan_session_started',
      'scan_received',
      'scan_queued',
      'scan_deduplicated',
      'scan_parse_failed',
    ]);
    expect(
      (report.breadcrumbs?.values ?? []).every(
        (crumb: Record<string, any>) =>
          crumb.category === SCANNER_BREADCRUMB_CATEGORY,
      ),
    ).toBe(true);

    // And the reason the trail exists: the report explains what was happening.
    expect(report.breadcrumbs.values[1].data).toEqual({
      mode: 'bulk',
      contentType: 'deep_link',
      contentLengthBucket: '0-32',
    });
  });

  it('never lets raw scanned content reach the crash report', () => {
    // Drive the trail with deliberately hostile payloads: the full scan string
    // under an allowlisted key, a Stellar key, and an unlisted `data` key.
    buildScannerBreadcrumbAndSend('scan_received', {
      mode: 'single',
      contentLengthBucket: bucketContentLength(RAW_SCAN.length),
      contentType: RAW_SCAN as unknown as string,
    });
    buildScannerBreadcrumbAndSend('scan_navigated', {
      mode: 'single',
      target: STELLAR_KEY as unknown as 'AidDetails',
    });
    scannerBreadcrumbs.scanReceived('single', 12, 'unknown');

    captureError(new Error('simulated crash after a scan'));

    const serialized = JSON.stringify(fakeSentry.reports[0]);
    expect(serialized).not.toContain('beneficiary-42');
    expect(serialized).not.toContain('soter://');
    expect(serialized).not.toContain(STELLAR_KEY);
  });

  it('is a no-op before a reporter is wired up, and never throws', () => {
    // Breadcrumbs are diagnostics: with no reporter attached they must vanish
    // quietly, and a reporter that fails must not throw into a scan handler.
    setScannerBreadcrumbEmitter(null);
    expect(() =>
      scannerBreadcrumbs.scanReceived('single', 10, 'deep_link'),
    ).not.toThrow();
    expect(fakeSentry.breadcrumbs).toHaveLength(0);

    setScannerBreadcrumbEmitter(() => {
      throw new Error('reporter unavailable');
    });
    expect(() =>
      scannerBreadcrumbs.scanReceived('single', 10, 'deep_link'),
    ).not.toThrow();
  });
});

/**
 * Emit one breadcrumb from a caller-supplied (potentially hostile) payload,
 * through the same builder and the same crash reporter the screens use.
 */
function buildScannerBreadcrumbAndSend(
  event: Parameters<typeof buildScannerBreadcrumb>[0],
  payload: Record<string, unknown>,
): void {
  const { category, message, data } = buildScannerBreadcrumb(event, payload);
  addBreadcrumb(category, message, data);
}
