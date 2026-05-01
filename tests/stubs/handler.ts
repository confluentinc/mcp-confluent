import { DefaultClientManager } from "@src/confluent/client-manager.js";
import type { CallToolResult } from "@src/confluent/schema.js";
import type { BaseToolHandler } from "@src/confluent/tools/base-tools.js";
import type { ServerRuntime } from "@src/server-runtime.js";
import { expect } from "vitest";
import { ZodError } from "zod";
import { createMockInstance } from "./mock-instance.js";

export type Resolves = {
  /** Minimal valid API response to feed into the proxy's `data` property.
   *  Omit to use `{}` (sufficient when the handler just JSON-serialises the
   *  response); supply `{ data: [] }` or a richer shape to push the handler
   *  past guard checks into its real success branch. */
  responseData?: unknown;
  /** Substring that must appear in the resolved response text. */
  resolves: string;
};

export type Throws = {
  /** Same as `Resolves.responseData` — set when the handler needs valid-ish
   *  data before it reaches the code that throws. */
  responseData?: unknown;
  /** Substring that must appear in the thrown error message, or "ZodError"
   *  to match any ZodError regardless of message. */
  throws: string;
};

/** Complete specification for one `handle()` invocation: what to feed in
 *  (`responseData`) and what to expect out (`resolves` / `throws`).
 *  The `"TODO"` sentinel triggers discovery mode: the test executes the
 *  handler, reports the actual outcome, and asks you to paste it in as the
 *  recorded expectation. */
export type HandleOutcome = Resolves | Throws | "TODO";

/** The array of client-getter mock functions returned by `stubClientGetters()`.
 *  Each element is a Vitest mock whose `.mock.calls` records invocations. */
export type ClientGetters = Array<{ mock: { calls: unknown[] } }>;

/** One entry in an `it.each` handler test suite. Supply `responseData` to push
 *  the handler past guard checks; omit to use the default `{}` response. */
export type HandleCase = {
  label: string;
  args: Record<string, unknown>;
  outcome: HandleOutcome;
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
 * Wires every client getter on a fresh `Mocked<DefaultClientManager>` to a
 * two-proxy pair so handler bodies never throw a TypeError before reaching
 * real logic. Supply `responseData` to push a specific handler past schema
 * validation into its success branch (defaults to `{}`).
 *
 * Returns `{ clientManager, clientGetters }`. `clientGetters` is the
 * canonical list of all getter mocks; pass it to `assertHandleCase` to
 * assert that at least one was invoked when a handler resolves successfully.
 */
export function stubClientGetters(responseData: unknown = {}) {
  // Two-proxy setup: callableProxy (function target) handles method chains
  // and calls; responseProxy (plain-object target) is what async calls
  // resolve to, modelling the { data, error } shape from openapi-fetch.
  // Future refinement: accept responseData as an array to support sequential
  // per-call responses (needed for multi-call handlers). The apply trap would
  // become index-aware, constructing a fresh responseProxy per invocation.
  let responseProxy: object = {};
  const callableProxy = new Proxy((() => {}) as () => Promise<object>, {
    get: (_t, prop) => {
      if (prop === "then" || prop === "error") return undefined;
      return callableProxy;
    },
    apply: () => Promise.resolve(responseProxy),
  });
  responseProxy = new Proxy({} as object, {
    // Four properties are special-cased:
    //   `then`          → undefined  (prevents JS treating this as a thenable)
    //   `error`         → undefined  (openapi-fetch "success" signal)
    //   `data`          → responseData  (caller-supplied; defaults to {})
    //   Symbol.iterator → empty-array iterator (handlers that iterate the
    //                     resolved value directly get an empty loop, not a TypeError)
    get: (_t, prop) => {
      if (prop === "then" || prop === "error") return undefined;
      if (prop === "data") return responseData;
      if (prop === Symbol.iterator)
        return Array.prototype[Symbol.iterator].bind([]);
      return callableProxy;
    },
  });

  const clientManager = createMockInstance(DefaultClientManager);
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

  return { clientManager, clientGetters };
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

  if (outcome === "TODO") {
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
    throw new Error(`${name}: outcome is TODO — replace with: ${discovered}`);
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
