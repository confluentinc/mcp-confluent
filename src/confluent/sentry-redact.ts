import type { ErrorEvent } from "@sentry/node";

export const REDACTED = "[REDACTED]";

/** Object keys whose entire value is replaced, regardless of contents. */
const SENSITIVE_KEY =
  /^(authorization|cookie|set-cookie|x-api-key|api[_-]?key|api[_-]?secret|password|sasl[._-]?password|secret|token|bearer|access[_-]?token|refresh[_-]?token)$/i;

/** Free-text patterns scrubbed inside any string value (error messages, YAML blobs). */
const TEXT_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // Authorization scheme + credential.
  [/\b(Bearer|Basic)\s+[\w\-._~+/]+=*/gi, `$1 ${REDACTED}`],
  // key/secret/password/token in `key: value` or `key=value` form (YAML + query/SASL).
  [
    /\b(password|secret|token|api[_-]?key|api[_-]?secret|sasl[._-]?password|authorization|bearer)\b(["']?\s*[:=]\s*["']?)([^\s"',}]+)/gi,
    `$1$2${REDACTED}`,
  ],
  // High-entropy standalone token (Confluent secret shape: >=40 base64 chars).
  [/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, REDACTED],
];

function scrubString(value: string): string {
  let out = value;
  for (const [pattern, replacement] of TEXT_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function scrub(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return scrubString(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value as object)) return value;
  seen.add(value as object);

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = scrub(value[i], seen);
    return value;
  }

  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    record[key] = SENSITIVE_KEY.test(key) ? REDACTED : scrub(record[key], seen);
  }
  return record;
}

/** `beforeSend` hook: deep-scrub credentials from an outbound Sentry event. */
export function redactEvent(event: ErrorEvent): ErrorEvent {
  return scrub(event, new WeakSet()) as ErrorEvent;
}
