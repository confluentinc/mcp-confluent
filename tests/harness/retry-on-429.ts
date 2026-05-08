import type { Middleware } from "openapi-fetch";

/** Construction options for {@link createRetryOn429Middleware}. */
export interface RetryOn429Options {
  /** Max retry attempts after the initial 429. Default 3. */
  maxAttempts?: number;
  /** Base for exponential backoff when `Retry-After` is absent. Default 500ms. */
  baseBackoffMs?: number;
  /** Injectable for tests. Defaults to {@linkcode globalThis.fetch}. */
  fetch?: typeof globalThis.fetch;
  /** Injectable for tests. Defaults to a `setTimeout`-based sleep. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_BACKOFF_MS = 500;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Parses an RFC 7231 `Retry-After` value (delta-seconds or HTTP-date) into
 * milliseconds clamped to ≥ 0. Returns `null` when absent or unparseable.
 */
function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const ts = Date.parse(trimmed);
  if (Number.isFinite(ts)) return Math.max(0, ts - Date.now());
  return null;
}

/**
 * Full-jitter exponential backoff: `base * 2^(attempt-1) + uniform[0, base)`.
 * `attempt` is 1-based.
 */
function backoffWithJitter(attempt: number, base: number): number {
  return base * 2 ** (attempt - 1) + Math.random() * base;
}

/**
 * Builds an openapi-fetch {@link Middleware} that retries HTTP 429s,
 * honoring `Retry-After` when present and falling back to exponential
 * backoff with jitter otherwise. Caps at
 * {@linkcode RetryOn429Options.maxAttempts} retries and returns the final
 * 429 on exhaustion so openapi-fetch surfaces it as `{ error }` (not silently as `data === undefined`)
 */
export function createRetryOn429Middleware(
  opts: RetryOn429Options = {},
): Middleware {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseBackoffMs = opts.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const sleep = opts.sleep ?? defaultSleep;

  // post-fetch `request.clone()` throws "unusable" for body-bearing calls since openapi-fetch hands
  // the same Request to fetch() and onResponse; capture bytes in onRequest and rebuild a new Request
  // per retry
  const requestBodyBytes = new WeakMap<Request, ArrayBuffer>();

  return {
    async onRequest({ request }) {
      if (request.body !== null) {
        requestBodyBytes.set(request, await request.clone().arrayBuffer());
      }
      return undefined;
    },
    async onResponse({ request, response }) {
      if (response.status !== 429) return undefined;
      let current = response;
      const cachedBody = requestBodyBytes.get(request);
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const retryAfter = parseRetryAfter(current.headers.get("Retry-After"));
        const delayMs = retryAfter ?? backoffWithJitter(attempt, baseBackoffMs);
        console.error(
          `[test-ccloud] 429 from ${request.method} ${request.url}; ` +
            `retry ${attempt}/${maxAttempts} after ${Math.round(delayMs)}ms`,
        );
        await sleep(delayMs);
        current = await fetchFn(
          new Request(request.url, {
            method: request.method,
            headers: request.headers,
            body: cachedBody ?? null,
            signal: request.signal,
          }),
        );
        if (current.status !== 429) return current;
      }
      return current;
    },
  };
}
