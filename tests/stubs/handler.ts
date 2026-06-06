import type { DirectClientManager } from "@src/confluent/direct-client-manager.js";
import type { CallToolResult } from "@src/confluent/schema.js";
import type { BaseToolHandler } from "@src/confluent/tools/base-tools.js";
import type { ServerRuntime } from "@src/server-runtime.js";
import { type Mock, type Mocked, expect } from "vitest";
import { ZodError } from "zod";
import type { MockedClientManager } from "./clients.js";

export type Resolves = {
  /** Substring that must appear in the resolved response text. */
  resolves: string;
  /** When set, asserts `result.isError` matches. Use `true` for handler-side
   *  error responses (built with `createResponse(text, true)`) — those resolve
   *  rather than throw, and without this check the test would pass on any
   *  message-text match regardless of the isError flag. */
  isError?: boolean;
};

export type Throws = {
  /** Substring that must appear in the thrown error message, or "ZodError"
   *  to match any ZodError regardless of message. */
  throws: string;
};

/** Complete specification for one `handle()` invocation: what to expect out
 *  (`resolves` / `throws`). Pass `"DISCOVER"` as a sentinel to run the handler,
 *  report the actual outcome, and get a copy-paste suggestion for the recorded
 *  expectation. */
export type HandleOutcome = Resolves | Throws | "DISCOVER";

/** One entry in an `it.each` handler test suite. */
export type HandleCase = {
  label: string;
  args: Record<string, unknown>;
  outcome: HandleOutcome;
};

/**
 * Snapshots the current call count of every getter (a `vi.fn()` enumerable
 * property) on a mocked client manager, so a later comparison counts only the
 * deltas the handler itself produced.
 */
function snapshotGetterCallCounts(
  clientManager: Mocked<DirectClientManager>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [key, value] of Object.entries(clientManager)) {
    if (typeof value === "function" && "mock" in value) {
      counts.set(key, (value as Mock).mock.calls.length);
    }
  }
  return counts;
}

/** Classifies a thrown value into the string used for matching in HandleOutcome. */
export function classifyThrown(label: string, thrown: unknown): string {
  if (thrown instanceof ZodError) return "ZodError";
  if (thrown instanceof Error) return thrown.message;
  throw new Error(
    `Wacky -- ${label}: handler threw a non-Error value: ${JSON.stringify(thrown)}`,
  );
}

/**
 * Runs `handler.handle(runtime, args)` and asserts the outcome matches the
 * `HandleOutcome` specification. Designed for both per-handler unit tests
 * and the global smoke suite.
 *
 * @param handler - The handler under test. Only `handle()` is required; pass
 *   the full handler instance or any `Pick<BaseToolHandler, "handle">`.
 * @param runtime - The {@link ServerRuntime} injected into `handle()`. Build it
 *   with `runtimeWith(connectionConfig, connectionId, clientManager)` so the
 *   connection shape and mocked client are both under test control.
 * @param args - Tool arguments forwarded to `handle()`. Defaults to `{}`.
 *   Supply only the fields relevant to the case under test.
 * @param outcome - What to expect: `{ resolves: substring }` asserts the
 *   response text contains the substring; `{ throws: substring }` asserts the
 *   thrown error message contains it (or `"ZodError"` for any {@link ZodError});
 *   the discovery sentinel runs the handler and fails with a copy-paste
 *   suggestion for the correct entry (see {@link HandleOutcome}).
 * @param clientManager - When supplied, asserts that at least one client
 *   getter on the manager was called on a successful resolve, proving the
 *   handler reached the client layer. Omit in cases that short-circuit
 *   before touching the client.
 * @param untouchedClientManager - When supplied, asserts that no getter on this
 *   manager was called by the handler — the negative half of a routing test,
 *   proving the call did not leak onto a connection it should have avoided
 *   (e.g. the decoy planted by `runtimeWithDecoy`).
 * @param name - Label prepended to assertion failure messages and used in
 *   discovery-sentinel output. Defaults to `"(handler)"`.
 */
export async function assertHandleCase(options: {
  handler: Pick<BaseToolHandler, "handle">;
  runtime: ServerRuntime;
  args?: Record<string, unknown>;
  outcome: HandleOutcome;
  clientManager?: MockedClientManager;
  untouchedClientManager?: Mocked<DirectClientManager>;
  name?: string;
}): Promise<void> {
  const {
    handler,
    runtime,
    args = {},
    outcome,
    clientManager,
    untouchedClientManager,
    name = "(handler)",
  } = options;

  if (typeof outcome === "object" && "resolves" in outcome) {
    expect(
      outcome.resolves,
      `${name}: resolves must be a non-empty substring, not ""`,
    ).not.toBe("");
  }

  // Snapshot getter call counts before the handler runs so the dynamic walk
  // below only counts deltas from the handler itself, not from test setup
  // calls like `const flinkRest = cm.getConfluentCloudFlinkRestClient()`.
  const callCountsBefore = clientManager
    ? snapshotGetterCallCounts(clientManager)
    : new Map<string, number>();
  const untouchedCountsBefore = untouchedClientManager
    ? snapshotGetterCallCounts(untouchedClientManager)
    : new Map<string, number>();

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

  if (untouchedClientManager) {
    for (const [key, value] of Object.entries(untouchedClientManager)) {
      if (typeof value === "function" && "mock" in value) {
        expect(
          (value as Mock).mock.calls.length,
          `${name}: ${key} on the untouched client manager was called, but routing should have avoided that connection`,
        ).toBe(untouchedCountsBefore.get(key) ?? 0);
      }
    }
  }

  if (thrown === undefined) {
    expect(
      typeof outcome === "object" && "resolves" in outcome,
      `${name}: resolved successfully but outcome specifies { throws }`,
    ).toBe(true);

    const { resolves, isError } = outcome as Resolves;
    const responseText = result!.content
      .map((c) => ("text" in c ? c.text : ""))
      .join("");
    expect(
      responseText,
      `${name}: response text does not contain expected substring`,
    ).toContain(resolves);

    if (isError !== undefined) {
      expect(
        result!.isError,
        `${name}: result.isError does not match expected`,
      ).toBe(isError);
    }

    if (clientManager) {
      // every getter on a `Mocked<DirectClientManager>` is a `vi.fn()` assigned
      // as an enumerable property by `createMockInstance`; comparing
      // post-handler counts against the pre-handler snapshot proves the
      // handler (not test setup) touched the client layer
      const anyMockCalled = Object.entries(clientManager).some(
        ([key, value]) =>
          typeof value === "function" &&
          "mock" in value &&
          (value as Mock).mock.calls.length > (callCountsBefore.get(key) ?? 0),
      );
      expect(
        anyMockCalled,
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
