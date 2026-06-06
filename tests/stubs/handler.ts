import type { DirectClientManager } from "@src/confluent/direct-client-manager.js";
import type { CallToolResult } from "@src/confluent/schema.js";
import type { BaseToolHandler } from "@src/confluent/tools/base-tools.js";
import type { ServerRuntime } from "@src/server-runtime.js";
import { type Mock, type Mocked, expect } from "vitest";
import { ZodError } from "zod";
import type { MockedClientManager } from "./clients.js";

/**
 * Reserved connection id for the decoy connection planted by `runtimeWithDecoy`.
 * {@link assertHandleCase} recognizes a runtime carrying this connection and,
 * for it, auto-routes the call to the real connection (injecting `connectionId`)
 * and asserts the decoy's client manager is never touched — turning any handle()
 * test into a routing test without a bespoke test body.
 */
export const DECOY_CONNECTION_ID = "decoy";

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
 *   Supply only the fields relevant to the case under test. Not always passed
 *   through verbatim: against a decoy runtime (see below) the harness injects a
 *   `connectionId` naming the non-decoy connection id present in the runtime when
 *   you didn't supply one, so the handler receives `{ ...args, connectionId }`.
 * Pass your own `connectionId` to opt out of that injection.
 * @param outcome - What to expect: `{ resolves: substring }` asserts the
 *   response text contains the substring; `{ throws: substring }` asserts the
 *   thrown error message contains it (or `"ZodError"` for any {@link ZodError});
 *   the discovery sentinel runs the handler and fails with a copy-paste
 *   suggestion for the correct entry (see {@link HandleOutcome}).
 * @param clientManager - When supplied, asserts that at least one client
 *   getter on the manager was called on a successful resolve, proving the
 *   handler reached the client layer. Omit in cases that short-circuit
 *   before touching the client.
 * @param name - Label prepended to assertion failure messages and used in
 *   discovery-sentinel output. Defaults to `"(handler)"`.
 *
 * When the runtime carries a {@link DECOY_CONNECTION_ID} connection (built via
 * `runtimeWithDecoy`), this also routes the call to the real connection — by
 * injecting `connectionId: <real id>` when the caller didn't supply one, where
 * `<real id>` is the sole non-decoy connection id (the `connectionId` passed to
 * `runtimeWithDecoy`, i.e. `DEFAULT_CONNECTION_ID` unless overridden) — and
 * asserts the decoy's client manager was never touched. That makes every
 * handle() test a routing test for free; a handler that still grabs
 * `enabledConnectionIds[0]` lands on the (first) decoy and fails the untouched
 * assertion.
 */
export async function assertHandleCase(options: {
  handler: Pick<BaseToolHandler, "handle">;
  runtime: ServerRuntime;
  args?: Record<string, unknown>;
  outcome: HandleOutcome;
  clientManager?: MockedClientManager;
  name?: string;
}): Promise<void> {
  const {
    handler,
    runtime,
    args = {},
    outcome,
    clientManager,
    name = "(handler)",
  } = options;

  // When a decoy connection is present (a runtimeWithDecoy runtime), route the
  // call to the real connection and capture the decoy's manager so we can prove
  // the handler never touched it. Validate the runtime shape up front: a decoy
  // with no manager, or with zero / more than one non-decoy sibling, would
  // otherwise inject `connectionId: undefined` and silently neuter the routing
  // assertion instead of failing where the mistake is.
  let decoyManager: Mocked<DirectClientManager> | undefined;
  let realConnectionId: string | undefined;
  if (DECOY_CONNECTION_ID in runtime.config.connections) {
    decoyManager = runtime.clientManagers[DECOY_CONNECTION_ID] as
      | Mocked<DirectClientManager>
      | undefined;
    if (!decoyManager) {
      throw new Error(
        `Wacky -- ${name}: decoy connection "${DECOY_CONNECTION_ID}" has no client manager; build decoy runtimes with runtimeWithDecoy`,
      );
    }
    const nonDecoyIds = Object.keys(runtime.config.connections).filter(
      (id) => id !== DECOY_CONNECTION_ID,
    );
    if (nonDecoyIds.length !== 1) {
      throw new Error(
        `Wacky -- ${name}: a decoy runtime must have exactly one non-decoy connection to route to; found ${nonDecoyIds.length} (${nonDecoyIds.join(", ") || "none"})`,
      );
    }
    realConnectionId = nonDecoyIds[0];
  }
  const effectiveArgs =
    decoyManager && args.connectionId === undefined
      ? { ...args, connectionId: realConnectionId }
      : args;

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
  const decoyCountsBefore = decoyManager
    ? snapshotGetterCallCounts(decoyManager)
    : new Map<string, number>();

  let result: CallToolResult | undefined;
  let thrown: unknown;
  try {
    result = await handler.handle(runtime, effectiveArgs, undefined);
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

  if (decoyManager) {
    for (const [key, value] of Object.entries(decoyManager)) {
      if (typeof value === "function" && "mock" in value) {
        expect(
          (value as Mock).mock.calls.length,
          `${name}: ${key} on the decoy connection's client manager was called, but routing should have stayed on the addressed connection`,
        ).toBe(decoyCountsBefore.get(key) ?? 0);
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
