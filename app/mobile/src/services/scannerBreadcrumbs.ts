/**
 * Scanner breadcrumbs.
 *
 * The scanner screens are the app's most failure-prone surface — the camera
 * pipeline, QR decoding, and the offline claim queue all run while the user is
 * standing in front of a beneficiary. A crash there currently reaches Sentry
 * with a stack trace and nothing about what the scanner was doing.
 *
 * This module records the scanner lifecycle (session start/end, scan received,
 * dedupe skip, parse failure, queue, verification, navigation) as breadcrumbs
 * so a crash report carries the trail that led to it.
 *
 * ## Privacy
 *
 * Scanned QR content is sensitive: a Soter package link identifies a
 * beneficiary's aid package, and a mis-scanned code could be anything. So
 * breadcrumbs carry **counts and types only** — never raw scan data. That is
 * enforced here rather than left to call-site discipline:
 *
 *   1. Every event has an explicit allowlist of data keys. Anything else is
 *      dropped, so a future caller cannot add `{ aidId }` or `{ data }` and
 *      have it ship silently.
 *   2. Allowlisted values must be primitives; strings are length-capped and
 *      rejected if they look like a URL, deep link, or Stellar key.
 *   3. Scan lengths are reported as a coarse bucket, not an exact length, so a
 *      breadcrumb cannot fingerprint a specific code.
 *
 * Whatever gets dropped is reported as a `droppedFields` count. A non-zero
 * value in a crash report is a bug in a caller, not noise — and it is visible
 * in the report precisely because the content is not.
 *
 * The crash reporter's `beforeSend` scrubber (`services/crashReporting.ts`)
 * still runs over these breadcrumbs as a second line of defence.
 *
 * ## Emitter
 *
 * Breadcrumbs are emitted through an injected function, so this module has no
 * dependency — at import time or at runtime — on the Sentry SDK, and the screens
 * stay importable in tests and in builds without crash reporting.
 * `CrashReportingProvider` injects the crash reporter's real `addBreadcrumb`
 * when the SDK initialises. With nothing injected, breadcrumbs are a no-op.
 */

/** Sentry breadcrumb category for every scanner event. */
export const SCANNER_BREADCRUMB_CATEGORY = 'scanner';

export type ScannerMode = 'single' | 'bulk';

/**
 * Lifecycle events. The name doubles as the breadcrumb `message`, so the trail
 * in a crash report reads as a sequence of actions.
 */
export type ScannerBreadcrumbEvent =
  | 'scan_session_started'
  | 'scan_session_ended'
  | 'scan_received'
  | 'scan_deduplicated'
  | 'scan_parse_failed'
  | 'scan_queued'
  | 'scan_verified'
  | 'scan_failed'
  | 'scan_navigated';

/**
 * The only keys any event may carry. Adding a key here is a privacy decision,
 * so each one must describe a count, a type, or a fixed enum — never content.
 */
const ALLOWED_KEYS: Record<ScannerBreadcrumbEvent, readonly string[]> = {
  scan_session_started: ['mode', 'screen'],
  scan_session_ended: [
    'mode',
    'scanned',
    'verified',
    'failed',
    'skipped',
    'durationMs',
  ],
  scan_received: ['mode', 'contentLengthBucket', 'contentType'],
  scan_deduplicated: ['mode', 'dedupeWindowMs'],
  scan_parse_failed: ['mode', 'reason', 'contentLengthBucket'],
  scan_queued: ['mode', 'queueStatus'],
  scan_verified: ['mode', 'queueStatus'],
  scan_failed: ['mode', 'reason', 'errorType'],
  scan_navigated: ['mode', 'target'],
};

/** Longest string that may survive into a breadcrumb value. */
export const MAX_BREADCRUMB_VALUE_LENGTH = 64;

/**
 * Value-level guard: even under an allowlisted key, a value shaped like scanned
 * content or a credential is omitted. Deliberately broader than "does it look
 * like a Soter link" — the point is that no code path can smuggle content
 * through a string.
 */
const CONTENT_LIKE_VALUE_PATTERNS: RegExp[] = [
  /soter:\/\//i,
  /stellar:\/\//i,
  /https?:\/\//i,
  /wc:[a-z0-9_-]+@/i,
  /G[A-Z2-7]{55}/,
  /^eyJ[A-Za-z0-9_-]*\./,
];

const OMITTED = '[omitted]';

export interface ScannerBreadcrumbData {
  data: Record<string, string | number | boolean>;
  /** Number of keys or values withheld from the breadcrumb. */
  droppedFields: number;
}

function isPrimitive(value: unknown): value is string | number | boolean {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

/**
 * Whether a string may be recorded verbatim, or must be omitted. Exported for
 * the test that proves raw scan content cannot reach a breadcrumb.
 */
export function isRecordableValue(value: string): boolean {
  if (value.length > MAX_BREADCRUMB_VALUE_LENGTH) return false;
  return !CONTENT_LIKE_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Reduce a scan's length to a coarse bucket. Bucketing keeps "how big was the
 * payload" useful for debugging while making it useless as a fingerprint.
 */
export function bucketContentLength(
  length: number,
): '0-32' | '33-64' | '65-128' | '129+' {
  if (length <= 32) return '0-32';
  if (length <= 64) return '33-64';
  if (length <= 128) return '65-128';
  return '129+';
}

/**
 * Apply the key allowlist and the value guard to a payload.
 *
 * Pure: no emitter, no SDK. Exported so the privacy rules are unit-testable on
 * their own.
 */
export function sanitizeScannerBreadcrumbData(
  event: ScannerBreadcrumbEvent,
  payload: Record<string, unknown> = {},
): ScannerBreadcrumbData {
  const allowed = ALLOWED_KEYS[event];
  const data: Record<string, string | number | boolean> = {};
  let droppedFields = 0;

  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null) {
      // An unset optional key is absent, not withheld — no drop to report.
      continue;
    }

    if (!allowed.includes(key)) {
      // Not on the allowlist: drop it and say so. This is the path a future
      // `{ data }` or `{ aidId }` would take.
      droppedFields += 1;
      continue;
    }

    if (!isPrimitive(value)) {
      droppedFields += 1;
      continue;
    }

    if (typeof value === 'string' && !isRecordableValue(value)) {
      data[key] = OMITTED;
      droppedFields += 1;
      continue;
    }

    if (typeof value === 'number' && !Number.isFinite(value)) {
      droppedFields += 1;
      continue;
    }

    data[key] = value;
  }

  return { data, droppedFields };
}

export interface ScannerBreadcrumb {
  category: string;
  message: string;
  data: Record<string, string | number | boolean>;
}

/**
 * Build the breadcrumb for an event. Pure and exported so a test can assert on
 * exactly what would leave the device.
 */
export function buildScannerBreadcrumb(
  event: ScannerBreadcrumbEvent,
  payload: Record<string, unknown> = {},
): ScannerBreadcrumb {
  const { data, droppedFields } = sanitizeScannerBreadcrumbData(event, payload);

  return {
    category: SCANNER_BREADCRUMB_CATEGORY,
    message: event,
    data: droppedFields > 0 ? { ...data, droppedFields } : data,
  };
}

export type ScannerBreadcrumbEmitter = (
  category: string,
  message: string,
  data?: Record<string, unknown>,
) => void;

let injectedEmitter: ScannerBreadcrumbEmitter | null = null;

/**
 * Set where breadcrumbs go. Called by `CrashReportingProvider` once the SDK is
 * up, and by tests to capture the trail without the SDK.
 *
 * Passing `null` detaches the reporter, making breadcrumbs a no-op.
 */
export function setScannerBreadcrumbEmitter(
  emitter: ScannerBreadcrumbEmitter | null,
): void {
  injectedEmitter = emitter;
}

/**
 * Record a scanner breadcrumb.
 *
 * A no-op until an emitter is injected, and never throws: a breadcrumb is
 * diagnostic, and neither its absence nor a failing reporter may break a scan
 * or mask the real error.
 */
export function recordScannerBreadcrumb(
  event: ScannerBreadcrumbEvent,
  payload: Record<string, unknown> = {},
): void {
  if (!injectedEmitter) return;

  try {
    const { category, message, data } = buildScannerBreadcrumb(event, payload);
    injectedEmitter(category, message, data);
  } catch {
    // Diagnostics must never be the reason a scan fails.
  }
}

/**
 * Typed call sites for the scanner screens. Each one fixes its event name and
 * payload keys, so a screen cannot invent an event or pass content by accident.
 */
export const scannerBreadcrumbs = {
  sessionStarted(mode: ScannerMode, screen: string): void {
    recordScannerBreadcrumb('scan_session_started', { mode, screen });
  },

  sessionEnded(
    mode: ScannerMode,
    counts: {
      scanned: number;
      verified: number;
      failed: number;
      skipped: number;
      durationMs: number;
    },
  ): void {
    recordScannerBreadcrumb('scan_session_ended', { mode, ...counts });
  },

  scanReceived(
    mode: ScannerMode,
    contentLength: number,
    contentType: 'deep_link' | 'url' | 'unknown' = 'unknown',
  ): void {
    recordScannerBreadcrumb('scan_received', {
      mode,
      contentLengthBucket: bucketContentLength(contentLength),
      contentType,
    });
  },

  scanDeduplicated(mode: ScannerMode, dedupeWindowMs: number): void {
    recordScannerBreadcrumb('scan_deduplicated', { mode, dedupeWindowMs });
  },

  scanParseFailed(
    mode: ScannerMode,
    reason: 'invalid_soter_qr' | 'unknown_format',
    contentLength: number,
  ): void {
    recordScannerBreadcrumb('scan_parse_failed', {
      mode,
      reason,
      contentLengthBucket: bucketContentLength(contentLength),
    });
  },

  scanQueued(mode: ScannerMode, queueStatus: 'queued' | 'completed'): void {
    recordScannerBreadcrumb('scan_queued', { mode, queueStatus });
  },

  scanVerified(mode: ScannerMode, queueStatus: 'queued' | 'completed'): void {
    recordScannerBreadcrumb('scan_verified', { mode, queueStatus });
  },

  scanFailed(
    mode: ScannerMode,
    reason: 'invalid_format' | 'verification_failed',
    errorType?: string,
  ): void {
    recordScannerBreadcrumb('scan_failed', { mode, reason, errorType });
  },

  scanNavigated(mode: ScannerMode, target: 'AidDetails'): void {
    recordScannerBreadcrumb('scan_navigated', { mode, target });
  },
};
