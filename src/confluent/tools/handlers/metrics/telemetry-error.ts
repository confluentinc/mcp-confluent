/**
 * openapi-fetch surfaces a non-2xx Telemetry API response through an `error`
 * property rather than throwing, so callers must check it explicitly before
 * trusting `data` — otherwise an HTTP failure reads as an empty success.
 * Shared by list-metrics-handler.ts and query-metrics-handler.ts.
 */

export function formatHttpStatusPart(status: number | undefined): string {
  return status === undefined ? "" : ` (HTTP ${status})`;
}

export function describeTelemetryError(error: unknown): string {
  const envelope = error as { errors?: unknown } | null;
  const details = Array.isArray(envelope?.errors)
    ? envelope.errors
        .map((e: { detail?: string }) => e?.detail)
        .filter(Boolean)
        .join("; ")
    : "";
  if (details.length > 0) {
    return details;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return safeStringify(error);
}

/**
 * Stringify an arbitrary error payload without ever throwing (e.g. on circular
 * structures) or returning `undefined` (e.g. for values JSON.stringify omits).
 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
