import { DirectClientManager } from "@src/confluent/direct-client-manager.js";
import type { CallToolResult } from "@src/confluent/schema.js";
import type { BaseToolHandler } from "@src/confluent/tools/base-tools.js";
import type { ServerRuntime } from "@src/server-runtime.js";
import { expect } from "vitest";
import { ZodError } from "zod";
import { createMockInstance } from "./mock-instance.js";

export type Resolves = {
  /**
   * Controls what each stubbed API call resolves to. Forwarded directly to
   * `stubClientGetters()` — see its JSDoc for the full element-shape contract.
   *
   * Quick reference:
   * - Omit (or `{}`) when the handler short-circuits before reading the result.
   * - Plain object → becomes `(await call()).data`. Match the shape the handler
   *   reads: e.g. `{ status: { phase: "COMPLETED" }, results: { data: [...] } }`.
   * - `{ response: { status: N } }` → for handlers that destructure `response`
   *   (e.g. DELETE endpoints: `const { response } = await client.DELETE(...)`).
   * - `{ error: { ... } }` → makes `(await call()).error` truthy, triggering
   *   error-branch code.
   * - Array of the above → consumed in call order; last element reused when
   *   the array is exhausted (needed for poll-then-fetch handlers).
   */
  responseData?: unknown;
  /** Substring that must appear in the resolved response text. */
  resolves: string;
};

export type Throws = {
  /**
   * Same contract as `Resolves.responseData`. Supply when the handler must
   * complete one or more successful API calls before reaching the code that
   * throws (e.g. a handler that fetches data and then validates it).
   * Omit when the throw happens before any client call.
   */
  responseData?: unknown;
  /** Substring that must appear in the thrown error message, or "ZodError"
   *  to match any ZodError regardless of message. */
  throws: string;
};

/** Complete specification for one `handle()` invocation: what to feed in
 *  (`responseData`) and what to expect out (`resolves` / `throws`).
 *  Pass `"DISCOVER"` as a sentinel to run the handler, report the actual
 *  outcome, and get a copy-paste suggestion for the recorded expectation. */
export type HandleOutcome = Resolves | Throws | "DISCOVER";

/** The array of client-getter mock functions returned by `stubClientGetters()`.
 *  Each element is a Vitest mock whose `.mock.calls` records invocations. */
export type ClientGetters = Array<{ mock: { calls: unknown[] } }>;

/**
 * One intercepted REST call captured by the proxy in `stubClientGetters()`.
 *
 * An entry is recorded for any invocation where the first argument is a string
 * path — this covers both `wrapAsPathBasedClient` callers (where
 * `PathCallForwarder` injects the path automatically) and handlers that call
 * the REST client directly as `client.GET("/path", options)`.
 *
 *   - `pathTemplate` — the raw OpenAPI path string, e.g.
 *     `"/sql/v1/organizations/{organization_id}/environments/{environment_id}/statements"`
 *   - `args` — the `{ params, body, ... }` object passed as the second argument
 *     to the HTTP method (undefined when the handler passes no init object)
 *
 * Use `capturedCalls[N].args` to assert POST body contents or query params
 * that are not observable through the handler's return value alone.
 */
export interface CapturedCall {
  pathTemplate: string;
  args: unknown;
}

/** One entry in an `it.each` handler test suite. */
export type HandleCase = {
  label: string;
  args: Record<string, unknown>;
  outcome: HandleOutcome;
  /**
   * Forwarded to `stubClientGetters()`. Omit for cases that throw or
   * short-circuit before touching the client. See `Resolves.responseData`
   * for the element-shape contract and array usage.
   */
  responseData?: unknown;
};

/** Classifies a thrown value into the string used for matching in HandleOutcome. */
export function classifyThrown(label: string, thrown: unknown): string {
  if (thrown instanceof ZodError) return "ZodError";
  if (thrown instanceof Error) return thrown.message;
  throw new Error(
    `Wacky -- ${label}: handler threw a non-Error value: ${JSON.stringify(thrown)}`,
  );
}

/**
 * Wires every client getter on a fresh `Mocked<DirectClientManager>` to a
 * two-proxy pair so handler bodies can traverse arbitrary method chains
 * (`.GET(...)`, `.POST(...)`, `.path(...).method(...)`, etc.) without throwing
 * a TypeError. Every async call resolves to a proxy that models the
 * `{ data, error, response }` shape returned by `openapi-fetch`.
 *
 * ## `responseData` — single value
 *
 * Pass a plain object; it becomes `(await call()).data`. Shape it to match
 * what the handler reads:
 * ```typescript
 * // handler does: const { data } = await client.GET(...); data.status.phase
 * stubClientGetters({ status: { phase: "COMPLETED" }, results: { data: [] } })
 * ```
 *
 * Two special top-level keys override the defaults:
 * - `response` — surfaced as `(await call()).response`. Use for handlers that
 *   destructure `response` directly, e.g. DELETE endpoints that check
 *   `response?.status`:
 *   ```typescript
 *   stubClientGetters({ response: { status: 204 } })
 *   ```
 * - `error` — surfaced as `(await call()).error`. Use to exercise a handler's
 *   error branch (`if (error) return this.createResponse(..., true)`):
 *   ```typescript
 *   stubClientGetters({ error: { message: "not found" } })
 *   ```
 *
 * ## `responseData` — array of elements (sequential calls)
 *
 * Pass an array to feed different data to successive calls. Each element
 * follows the same shape contract above. The last element is reused once the
 * array is exhausted, so you only need to enumerate the calls that differ:
 * ```typescript
 * // handler: POST to create → GET to poll status → GET to fetch results
 * stubClientGetters([
 *   {},                                                    // POST (ignored)
 *   { status: { phase: "COMPLETED" } },                   // GET poll
 *   { results: { data: [{ COLUMN_NAME: "id" }] } },       // GET results
 * ])
 * ```
 *
 * ## Bare-array routes (response IS an array)
 *
 * Some Confluent Cloud routes return a bare JSON array rather than a paginated
 * envelope object (e.g. `GET /connect/v1/.../connectors` returns
 * `["ConnectorA", "ConnectorB"]`). Because a top-level array is always
 * interpreted as sequential-call responses, you must wrap it in an outer array
 * so the single element is the array itself:
 * ```typescript
 * // handler does: const { data: names } = await client.GET(...); names.join(",")
 * stubClientGetters([["ConnectorA", "ConnectorB"]])
 * //               ^outer array = one response  ^inner array = the data value
 * ```
 *
 * Returns `{ clientManager, clientGetters, capturedCalls }`.
 * - Pass `clientGetters` to `assertHandleCase` to assert the handler reached
 *   the client layer on a successful resolve.
 * - `capturedCalls` is a `CapturedCall[]`; each entry has `.pathTemplate` (the
 *   raw OpenAPI path string) and `.args` (the `{ params, body, ... }` object).
 *   Use it to assert what the handler actually sent to the REST layer, e.g.
 *   POST body contents or query params. Any call whose first argument is a
 *   string path is captured — this includes both `wrapAsPathBasedClient`
 *   callers and direct `client.METHOD(path, options)` calls. Invocations whose
 *   first argument is not a string (Kafka admin, producer, consumer, etc.) are
 *   silently skipped.
 */
export function stubClientGetters(responseData: unknown = {}) {
  // Two-proxy setup: callableProxy (function target) handles method chains
  // and calls; per-call responseProxies model the { data, error, response }
  // shape from openapi-fetch. When responseData is an array, each element is
  // consumed in order; the last element is reused once the array is exhausted.
  const responses = Array.isArray(responseData) ? responseData : [responseData];
  if (responses.length === 0)
    throw new Error("stubClientGetters: responseData array must not be empty");
  let callIndex = 0;

  const capturedCalls: CapturedCall[] = [];

  const callableProxy: object = new Proxy((() => {}) as () => Promise<object>, {
    get: (_t, prop) => {
      if (prop === "then" || prop === "error") return undefined;
      return callableProxy;
    },
    apply: (_target, _thisArg, args) => {
      // Only REST clients (wrapAsPathBasedClient) produce captured calls —
      // PathCallForwarder always passes the path template string as the first
      // argument. Non-REST calls (Kafka admin, producer, consumer) fire apply
      // with zero args (proxy-chain continuations) or non-string first args
      // (e.g. createTopics({ topics: [...] })); both are silently skipped.
      // A test that tries to assert capturedCalls on a non-REST handler will
      // see an empty array and fail the toHaveLength guard with a clear message.
      //
      // Future: if we ever need to inspect Kafka-client or other non-REST calls,
      // replace CapturedCall with a discriminated union:
      //   | { kind: "rest"; pathTemplate: string; args: unknown }
      //   | { kind: "raw"; args: unknown[] }
      // and push accordingly here.
      if (typeof args[0] === "string") {
        capturedCalls.push({ pathTemplate: args[0], args: args[1] });
      }
      const element = responses[Math.min(callIndex++, responses.length - 1)];
      return Promise.resolve(makeResponseProxy(element));
    },
  });

  function makeResponseProxy(element: unknown): object {
    const elem =
      element !== null && typeof element === "object"
        ? (element as Record<string | symbol, unknown>)
        : null;
    return new Proxy({} as object, {
      // Special-cased properties:
      //   `then`          → undefined  (prevents JS treating this as a thenable)
      //   `error`         → element.error if present, else undefined
      //   `data`          → element  (backward compat: element IS the data)
      //   `response`      → element.response if present, else callableProxy
      //   Symbol.iterator → empty-array iterator
      get: (_t, prop) => {
        if (prop === "then") return undefined;
        if (prop === Symbol.iterator)
          return Array.prototype[Symbol.iterator].bind([]);
        if (prop === "error")
          return elem && "error" in elem ? elem["error"] : undefined;
        if (prop === "data") return element;
        if (prop === "response")
          return elem && "response" in elem ? elem["response"] : callableProxy;
        return callableProxy;
      },
    });
  }

  const clientManager = createMockInstance(DirectClientManager);
  clientManager.getAdminClient.mockResolvedValue(callableProxy as never);
  clientManager.getProducer.mockResolvedValue(callableProxy as never);
  clientManager.getConsumer.mockResolvedValue(callableProxy as never);
  clientManager.getConfluentCloudFlinkRestClient.mockReturnValue(
    callableProxy as never,
  );
  clientManager.getConfluentCloudRestClient.mockReturnValue(
    callableProxy as never,
  );
  clientManager.getConfluentCloudTableflowRestClient.mockReturnValue(
    callableProxy as never,
  );
  clientManager.getConfluentCloudSchemaRegistryRestClient.mockReturnValue(
    callableProxy as never,
  );
  clientManager.getConfluentCloudKafkaRestClient.mockReturnValue(
    callableProxy as never,
  );
  clientManager.getConfluentCloudTelemetryRestClient.mockReturnValue(
    callableProxy as never,
  );
  clientManager.getSchemaRegistryClient.mockReturnValue(callableProxy as never);

  const clientGetters = [
    clientManager.getAdminClient,
    clientManager.getProducer,
    clientManager.getConsumer,
    clientManager.getConfluentCloudFlinkRestClient,
    clientManager.getConfluentCloudRestClient,
    clientManager.getConfluentCloudTableflowRestClient,
    clientManager.getConfluentCloudSchemaRegistryRestClient,
    clientManager.getConfluentCloudKafkaRestClient,
    clientManager.getConfluentCloudTelemetryRestClient,
    clientManager.getSchemaRegistryClient,
  ];

  return { clientManager, clientGetters, capturedCalls };
}

/**
 * Runs `handler.handle(runtime, args)` and asserts the outcome matches the
 * `HandleOutcome` specification. Designed for both per-handler unit tests
 * and the global smoke suite.
 *
 * @param handler - The handler under test. Only `handle()` is required; pass
 *   the full handler instance or any `Pick<BaseToolHandler, "handle">`.
 * @param runtime - The `ServerRuntime` injected into `handle()`. Build it with
 *   `runtimeWith(connectionConfig, connectionId, clientManager)` so the
 *   connection shape and mock client are both under test control.
 * @param args - Tool arguments forwarded to `handle()`. Defaults to `{}`.
 *   Supply only the fields relevant to the case under test.
 * @param outcome - What to expect: `{ resolves: substring }` asserts the
 *   response text contains the substring; `{ throws: substring }` asserts the
 *   thrown error message contains it (or `"ZodError"` for any `ZodError`);
 *   the discovery sentinel runs the handler and fails with a copy-paste
 *   suggestion for the correct entry (see `HandleOutcome`).
 * @param clientGetters - When supplied, asserts that at least one getter was
 *   called on a successful resolve, proving the handler reached the client
 *   layer. Omit in cases that short-circuit before touching the client.
 *   (Obtain from the `clientGetters` field returned by `stubClientGetters()`.)
 * @param name - Label prepended to assertion failure messages and used in
 *   discovery-sentinel output. Defaults to `"(handler)"`.
 */
export async function assertHandleCase(options: {
  handler: Pick<BaseToolHandler, "handle">;
  runtime: ServerRuntime;
  args?: Record<string, unknown>;
  outcome: HandleOutcome;
  clientGetters?: ClientGetters;
  name?: string;
}): Promise<void> {
  const {
    handler,
    runtime,
    args = {},
    outcome,
    clientGetters,
    name = "(handler)",
  } = options;

  if (typeof outcome === "object" && "resolves" in outcome) {
    expect(
      outcome.resolves,
      `${name}: resolves must be a non-empty substring, not ""`,
    ).not.toBe("");
  }

  let result: CallToolResult | undefined;
  let thrown: unknown;
  try {
    result = await handler.handle(runtime, args, undefined);
  } catch (err) {
    thrown = err;
  }

  if (outcome === "DISCOVER") {
    let discovered: string;
    if (thrown !== undefined) {
      discovered = `{ throws: ${JSON.stringify(classifyThrown(name, thrown))} }`;
    } else if (result === undefined) {
      throw new Error(
        `Wacky -- ${name}: handle() returned undefined instead of a CallToolResult`,
      );
    } else {
      const text = result.content
        .map((c) => ("text" in c ? c.text : ""))
        .join("")
        .slice(0, 60);
      discovered = `{ resolves: ${JSON.stringify(text)} }`;
    }
    throw new Error(
      `${name}: outcome is "DISCOVER" — replace with: ${discovered}`,
    );
  }

  if (thrown === undefined) {
    expect(
      typeof outcome === "object" && "resolves" in outcome,
      `${name}: resolved successfully but outcome specifies { throws }`,
    ).toBe(true);

    const { resolves } = outcome as Resolves;
    const responseText = result!.content
      .map((c) => ("text" in c ? c.text : ""))
      .join("");
    expect(
      responseText,
      `${name}: response text does not contain expected substring`,
    ).toContain(resolves);

    if (clientGetters) {
      expect(
        clientGetters.some((m) => m.mock.calls.length > 0),
        `${name}: resolved without error but no client getter was called`,
      ).toBe(true);
    }
  } else {
    expect(
      typeof outcome === "object" && "throws" in outcome,
      `${name}: handler threw but outcome specifies { resolves }`,
    ).toBe(true);

    expect(
      classifyThrown(name, thrown),
      `${name}: unexpected error — update outcome with actual`,
    ).toContain((outcome as Throws).throws);
  }
}
