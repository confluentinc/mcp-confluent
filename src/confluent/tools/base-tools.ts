import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type {
  ConnectionConfig,
  DirectConnectionConfig,
} from "@src/config/models.js";
import type { BaseClientManager } from "@src/confluent/base-client-manager.js";
import { CallToolResult } from "@src/confluent/schema.js";
import {
  alwaysEnabled,
  ConnectionPredicate,
  ENABLED,
  PredicateResult,
  ToolDisabledReason,
} from "@src/confluent/tools/connection-predicates.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { z, ZodRawShape } from "zod";

/**
 * Standard MCP tool annotations.
 * Tools should reference these constants rather than creating ad-hoc instances.
 */
export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
} as const;

export const CREATE_UPDATE: ToolAnnotations = {
  destructiveHint: false,
  readOnlyHint: false,
} as const;

export const DESTRUCTIVE: ToolAnnotations = {
  destructiveHint: true,
  readOnlyHint: false,
} as const;

/**
 * Opening clause of the injected `connectionId` parameter description, before the
 * comma-separated list of viable connection ids is appended.
 */
export const CONNECTION_ID_DESCRIPTION_PREFIX =
  "Which configured connection to target. One of: ";

/**
 * Sentence appended to the `connectionId` description that steers the agent at the
 * discovery tool. Emitted only when that tool is itself reachable; the joining space
 * is added at the call site so a blocked tool leaves no dangling trailing space.
 */
export const LIST_CONFIGURED_CONNECTIONS_POINTER = `Discover connections and learn what tools are supported by each connection by invoking '${ToolName.LIST_CONFIGURED_CONNECTIONS}'.`;

/**
 * Operator-facing taxonomy of tool kinds.
 *
 * Answers "what kind of tool is this?" — orthogonal to the
 * {@linkcode ConnectionPredicate}-based "is this tool enabled?" question that
 * lives next door. Predicates gate advertisement; categories classify intent.
 */
export enum ToolCategory {
  Billing = "billing",
  Catalog = "catalog",
  ConfluentCloud = "confluent-cloud",
  Connect = "connect",
  Docs = "docs",
  Flink = "flink",
  Kafka = "kafka",
  McpServerDiagnostics = "mcp-server-diagnostics",
  Metrics = "metrics",
  SchemaRegistry = "schema-registry",
  Tableflow = "tableflow",
}

export interface ToolHandler {
  /** Handle a tool invocation. */
  handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown> | undefined,
    sessionId?: string,
  ): Promise<CallToolResult> | CallToolResult;

  /**
   * Produce the actual config registered with MCP for this tool, potentially
   * injecting a required `connectionId` parameter when the tool can target more
   * than one connection. See the method body for the rules.
   *
   * This method is called when setting up the MCP server, and we ourselves make
   * the downcall to the handler-authored `getToolConfig()`.
   * {@linkcode BaseToolHandler.getRegisteredToolConfig} for the rules.
   */
  getRegisteredToolConfig(runtime: ServerRuntime): ToolConfig;

  /**
   * The connection predicate that gates this tool's enablement. Lifted onto
   * the interface so the MCP tool-call wrapper can compare it against
   * `alwaysEnabled` to skip the OAuth login gate for tools that don't touch
   * the client manager (currently the doc-lookup tools). See
   * {@linkcode BaseToolHandler.predicate} for the rules around setting it.
   */
  readonly predicate: ConnectionPredicate;

  /**
   * The {@linkcode ToolCategory} this tool belongs to — operator-facing
   * taxonomy, orthogonal to {@linkcode predicate}. See
   * {@linkcode BaseToolHandler.category} for the rules around setting it.
   */
  readonly category: ToolCategory;

  /**
   * IDs of connections that satisfy this tool's service requirements. A
   * non-empty result enables the tool; an empty result disables it. Always a
   * subset of `runtime.config.connections` keys.
   *
   * Implementations that extend {@linkcode BaseToolHandler} (the standard
   * path for every tool in this codebase) must not override this — declare
   * a {@linkcode BaseToolHandler.predicate} property and let the base class
   * derive the result.
   */
  enabledConnectionIds(runtime: ServerRuntime): string[];

  /**
   * Per-connection verdict map for this tool: `{ enabled: true }` for
   * connections that satisfy its requirements, `{ enabled: false; reason }`
   * for those that don't. Powers startup-log grouping and the
   * `describe-tool-availability` diagnostic tool.
   */
  connectionVerdicts(runtime: ServerRuntime): Map<string, PredicateResult>;

  /**
   * Whether this tool is enabled irrespective of the configured connections.
   * See {@linkcode BaseToolHandler.isConnectionIndependent}.
   */
  readonly isConnectionIndependent: boolean;

  /**
   * The connection id this invocation routes to, or `undefined` when it routes
   * to none. See {@linkcode BaseToolHandler.resolvedTargetConnectionId}.
   */
  resolvedTargetConnectionId(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown> | undefined,
  ): string | undefined;
}

export interface ToolConfig {
  name: ToolName;
  description: string;
  inputSchema: ZodRawShape;
  annotations: ToolAnnotations;
}

/**
 * What the connection-resolution helpers hand back: the chosen connection id,
 * its resolved config, and the client manager bound to it.
 *
 * Generic over the connection arm so the type-neutral resolvers
 * ({@linkcode BaseToolHandler.resolveConnection}) and the direct-narrowing one
 * ({@linkcode BaseToolHandler.resolveDirectConnection}) share a single name —
 * the latter instantiates it via the {@link ResolvedDirectConnection} alias.
 */
export interface ResolvedConnection<
  C extends ConnectionConfig = ConnectionConfig,
> {
  connId: string;
  conn: C;
  clientManager: BaseClientManager;
}

/**
 * A {@link ResolvedConnection} pre-narrowed to the direct arm — the return type
 * of {@linkcode BaseToolHandler.resolveDirectConnection}.
 */
export type ResolvedDirectConnection =
  ResolvedConnection<DirectConnectionConfig>;

export abstract class BaseToolHandler implements ToolHandler {
  abstract handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown> | undefined,
    sessionId?: string,
  ): Promise<CallToolResult> | CallToolResult;

  protected abstract getToolConfig(): ToolConfig;

  /**
   * Produce the actual config registered with MCP for this tool, potentially
   * injecting a required `connectionId` parameter when the tool can target more
   * than one connection. See the method body for the rules.
   *
   * This method is called when setting up the MCP server, and we ourselves make
   * the downcall to the handler-authored `getToolConfig()`.
   *
   * @final — concrete on `BaseToolHandler`; subclasses must not override.
   */
  getRegisteredToolConfig(runtime: ServerRuntime): ToolConfig {
    const config = this.getToolConfig();

    // Connection-independent tools (docs, diagnostics) never route to a
    // connection and so never need a connectionId parameter; bail before the
    // per-connection scan below.
    if (this.isConnectionIndependent) return config;

    const ids = this.enabledConnectionIds(runtime);

    // A tool viable on a single connection has no ambiguity as to which
    // connection it routes to, so return the tool's authored config verbatim.

    // (We might find that in multi-connection configurations, we might
    //  want to surface the `connectionId` parameter regardless but then
    //  lock it to a single value with `z.enum([theSoleEnabledId])`. Will
    //  have to get farther along epic #532 before we can make that
    //  determination, though. We have enough information in serverRuntime
    //  to be able to migrate, though, so is not a blocker at this time.)
    if (ids.length <= 1) return config;

    // Otherwise, inject a required connectionId parameter into the Zod
    // inputSchema with an enum of the enabled connection IDs.

    // Point the agent at list-configured-connections so it can learn which
    // tools each connection supports — but only when that tool is itself
    // reachable; naming a tool the operator blocked would send the agent
    // chasing a ghost. The joining space is added here so the blocked case
    // (empty pointer) leaves no dangling trailing space on the description.
    const listConfiguredConnectionsPointer = runtime.isToolAllowed(
      ToolName.LIST_CONFIGURED_CONNECTIONS,
    )
      ? ` ${LIST_CONFIGURED_CONNECTIONS_POINTER}`
      : "";
    return {
      ...config,
      inputSchema: {
        ...config.inputSchema,
        connectionId: z
          .enum(ids as [string, ...string[]])
          .describe(
            `${CONNECTION_ID_DESCRIPTION_PREFIX}${ids.join(", ")}.${listConfiguredConnectionsPointer}`,
          ),
      },
    };
  }

  /**
   * The connection predicate that gates this tool. The single customization
   * seam for tool enablement — declared as a one-line readonly property:
   *
   *     readonly predicate = hasKafka;                  // base predicate
   *     readonly predicate = kafkaBootstrapOrOAuth;     // named composite
   *     readonly predicate = alwaysEnabled;             // no requirement
   *
   * **Must reference a named export from `connection-predicates.ts`.** Do
   * not compose with `allOf(...)` or `widenForOAuth(...)` at the use site.
   * If no existing named export expresses the gate you need, add one —
   * with a per-predicate test in `connection-predicates.test.ts` matching
   * the depth of the existing `hasKafka` / `flinkWithTelemetry` blocks —
   * and reference that. Enforced mechanically: the `predicate property`
   * block in `tool-registry.test.ts` maintains an explicit
   * `Readonly<Record<ToolName, ConnectionPredicate>>` (`EXPECTED_PREDICATES`)
   * pinning every tool to its expected predicate. The `Record` over
   * `ToolName` makes exhaustiveness a compile-time check (a missing tool
   * is a `tsc` error, not a runtime one), and the value type rejects
   * combinators at compile time. The `it.each` over the record fails with
   * the offending tool name in the row label whenever a handler's
   * `predicate` drifts from the table. New tools or rewires are a one-line
   * table edit.
   *
   * Both {@linkcode enabledConnectionIds} and {@linkcode connectionVerdicts}
   * are derived from this property and are marked `@final`; never override
   * either method. The retired iteration helpers `connectionIdsWhere` and
   * `connectionReasonsWhere` are no longer exported — the base class walks
   * `runtime.config.connections` for you.
   */
  abstract readonly predicate: ConnectionPredicate;

  /**
   * The {@linkcode ToolCategory} this tool belongs to — operator-facing
   * taxonomy answering "what kind of tool is this?" Orthogonal to
   * {@linkcode predicate} (which gates advertisement); category classifies
   * intent for grouping in diagnostic surfaces and AI-client UX.
   */
  abstract readonly category: ToolCategory;

  /**
   * IDs of connections that satisfy this tool's {@linkcode predicate} and are
   * not blocked by the read-only overlay. A non-empty result enables the tool;
   * an empty result disables it. Derived from {@linkcode connectionVerdicts} so
   * the two stay in lockstep.
   *
   * Customize tool gating by declaring {@linkcode predicate}, never by
   * replacing this derivation.
   *
   * @final — concrete on `BaseToolHandler`; subclasses must not override.
   */
  enabledConnectionIds(runtime: ServerRuntime): string[] {
    return [...this.connectionVerdicts(runtime)]
      .filter(([, verdict]) => verdict.enabled)
      .map(([id]) => id);
  }

  /**
   * Whether this tool is enabled regardless of the configured connections —
   * true exactly when its {@linkcode predicate} is `alwaysEnabled`, the only
   * predicate that returns enabled without inspecting a connection. Such tools
   * (docs lookup, server diagnostics) never route to a connection, so they
   * register even on a zero-connection config, where the per-connection verdict
   * map driving {@linkcode enabledConnectionIds} is empty.
   */
  get isConnectionIndependent(): boolean {
    return this.predicate === alwaysEnabled;
  }

  /**
   * The connection id this invocation routes to — the OAuth-login gate uses it
   * to launch the browser flow only when a call actually targets the OAuth
   * connection, not merely because one exists somewhere in the config.
   *
   * Delegates to {@linkcode resolveConnection} so routing is decided in one
   * place rather than duplicated in the gate. Returns `undefined` for a
   * connection-independent tool (it routes to no connection) and for a call
   * `resolveConnection` can't resolve unambiguously (e.g. a multi-connection
   * tool invoked without a `connectionId`); in the latter case the gate declines
   * to pre-launch a login and `handle()` reports the routing error to the caller.
   *
   * @final — concrete on `BaseToolHandler`; subclasses must not override.
   */
  resolvedTargetConnectionId(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown> | undefined,
  ): string | undefined {
    if (this.isConnectionIndependent) return undefined;
    try {
      return this.resolveConnection(runtime, toolArguments).connId;
    } catch {
      return undefined;
    }
  }

  /**
   * Per-connection verdict map for this tool — the single source of truth for
   * enablement. Each verdict composes the {@linkcode predicate} with the
   * read-only overlay (see {@linkcode connectionVerdict}). Powers grouped
   * startup logging, the diagnostic-tool surface, and
   * {@linkcode enabledConnectionIds}.
   *
   * Customize tool gating by declaring {@linkcode predicate}, never by
   * replacing this derivation.
   *
   * @final — concrete on `BaseToolHandler`; subclasses must not override.
   */
  connectionVerdicts(runtime: ServerRuntime): Map<string, PredicateResult> {
    return new Map(
      Object.entries(runtime.config.connections).map(([id, conn]) => [
        id,
        this.connectionVerdict(conn),
      ]),
    );
  }

  /**
   * Single-connection verdict composing the two gating layers: the
   * {@linkcode predicate} (service reachability) and the read-only overlay.
   *
   * A connection the predicate already disables keeps that verdict unchanged —
   * service reachability is the more fundamental reason and wins, so a
   * connection missing the service block is never reported as "read-only
   * blocked". Otherwise, a `read_only` connection disables any tool that
   * mutates state (`annotations.readOnlyHint !== true`).
   */
  private connectionVerdict(conn: ConnectionConfig): PredicateResult {
    const verdict = this.predicate(conn);
    if (!verdict.enabled) return verdict;
    if (
      conn.read_only === true &&
      this.getToolConfig().annotations.readOnlyHint !== true
    ) {
      return { enabled: false, reason: ToolDisabledReason.ReadOnlyConnection };
    }
    return ENABLED;
  }

  /**
   * Resolves the first connection enabled for this tool, returning the
   * connection id, its config, and the matching client manager.
   *
   * Selects `enabledConnectionIds(runtime)[0]`. On a multi-connection config
   * that arbitrarily picks the first enabled connection, which is why handlers
   * route via {@linkcode resolveConnection} instead. Single-connection
   * scaffolding with no remaining production callers; deletion tracked in #554.
   */
  protected resolveSoleConnection(runtime: ServerRuntime): ResolvedConnection {
    const connId = this.enabledConnectionIds(runtime)[0]!;
    return {
      connId,
      conn: runtime.config.connections[connId]!,
      clientManager: runtime.clientManagers[connId]!,
    };
  }

  /**
   * Resolves which connection a tool call targets: the explicit `connectionId`
   * argument when present, else the sole connection enabled for this tool.
   * Throws a listing error when the id is unknown/not-enabled, when it is
   * present but not a string, or when omitted while two or more connections are
   * candidates (the augmented schema makes all three unreachable in normal MCP
   * flow — these are defensive backstops against internal call sites).
   *
   * Reads `connectionId` off the **raw** `toolArguments` rather than off the
   * handler's locally-parsed object: the framework already validated it against
   * the registered schema (see {@linkcode getRegisteredToolConfig}), and a
   * handler's own `z.object` re-`parse()` would strip the key it never declared.
   *
   * @final — concrete on `BaseToolHandler`; subclasses must not override.
   */
  protected resolveConnection(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown> | undefined,
  ): ResolvedConnection {
    // The connection this tool call should route to.
    let determinedId: string;

    // What connection ids this tool possibly supports.
    const enabledIds = this.enabledConnectionIds(runtime);

    // The requested connection id, if the caller provided one. Per the Zod schema injected by
    // `getRegisteredToolConfig()` it should be a string that is one of the enabled ids; both
    // expectations are enforced below rather than assumed.
    const requestedId = toolArguments?.connectionId;

    if (typeof requestedId === "string") {
      if (!enabledIds.includes(requestedId)) {
        throw new Error(
          `Wacky -- connection "${requestedId}" is not an enabled connection for this tool; enabled: ${enabledIds.join(", ")}`,
        );
      }
      // Explicit requested ID must be valid based on the injected schema enum already having validated it, so can
      // at this point trust fully.
      determinedId = requestedId;
    } else if (requestedId !== undefined) {
      // Unreachable in normal operation: Zod has already validated `args`
      // against the registered schema before `handle()` runs, and that schema
      // either declares `connectionId` as a string enum (multi-connection
      // tools — a non-string fails parsing) or omits it entirely (single-
      // connection tools — an unknown key is stripped). Either way a non-string
      // can't survive to reach this branch. It exists purely as a symmetric
      // peer to the two backstops below, so a malformed value can never quietly
      // masquerade as an omission and auto-route.
      throw new Error(
        `Wacky -- connectionId present but not a string (got ${typeof requestedId}); the injected schema should have rejected this`,
      );
    } else if (enabledIds.length === 1) {
      // No requested ID, but only one enabled connection — unambiguous, so route there.
      determinedId = enabledIds[0]!;
    } else {
      // Not a string and not a sole enabled connection. Should have been blocked by the injected schema.
      throw new Error(
        `Wacky -- connectionId omitted but this tool is enabled for ${enabledIds.length} connections (${enabledIds.join(", ") || "none"}); cannot auto-route`,
      );
    }

    return {
      connId: determinedId,
      conn: runtime.config.connections[determinedId]!,
      clientManager: runtime.clientManagers[determinedId]!,
    };
  }

  /**
   * Like {@linkcode resolveConnection}, but narrows the resolved connection to
   * a {@link DirectConnectionConfig} — throwing if the addressed connection is
   * OAuth-typed. The throw is a defensive backstop: a tool's `connectionId`
   * enum only offers connections its predicate enables, and the direct-block
   * predicates exclude OAuth, so an OAuth connection is unreachable here via
   * normal MCP flow.
   *
   * @final — concrete on `BaseToolHandler`; subclasses must not override.
   */
  protected resolveDirectConnection(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown> | undefined,
  ): ResolvedDirectConnection {
    // Reuse resolveConnection for id selection + validation; this method only
    // adds the direct-vs-oauth narrowing on top of its type-neutral result.
    const { connId, conn, clientManager } = this.resolveConnection(
      runtime,
      toolArguments,
    );

    // A resolved OAuth connection means the wiring is broken (a non-oauth tool
    // somehow offered an oauth id), not that a caller legitimately asked for one.
    if (conn.type !== "direct") {
      throw new Error(
        `Wacky -- connection "${connId}" is ${conn.type}-typed; this tool requires a direct connection`,
      );
    }

    // conn is narrowed to DirectConnectionConfig by the guard above.
    return { connId, conn, clientManager };
  }

  /**
   * Resolves a required string from an explicit tool argument, falling back to
   * a connection-config value. Throws if neither is present.
   * `label` is the human-readable field name (e.g. `"Organization ID"`);
   * the thrown message is `"${label} is required"`.
   * The returned value is always trimmed.
   */
  protected resolveParam(
    argValue: string | undefined,
    configValue: string | undefined,
    label: string,
  ): string {
    const resolved = argValue?.trim() || configValue?.trim();
    if (!resolved) throw new Error(`${label} is required`);
    return resolved;
  }

  /** Like resolveParam but returns undefined instead of throwing when both are absent or blank. The returned value is always trimmed. */
  protected resolveOptionalParam(
    argValue: string | undefined,
    configValue: string | undefined,
  ): string | undefined {
    return argValue?.trim() || configValue?.trim() || undefined;
  }

  createResponse(
    message: string,
    isError: boolean = false,
    _meta?: Record<string, unknown>, // Type as a generic object
  ): CallToolResult {
    const response: CallToolResult = {
      content: [
        {
          type: "text",
          text: message,
        },
      ],
      isError: isError,
      _meta: _meta,
    };
    return response;
  }

  /**
   * Variant of {@link createResponse} that surfaces the response's
   * machine-readable payload via MCP's `structuredContent` channel (per the
   * [2025-11-25 spec](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)).
   * The `message` carries the human-readable summary on `content`; the
   * `structuredContent` field carries the typed JSON payload callers (or
   * `outputSchema` validators) can consume directly.
   */
  createStructuredResponse(
    message: string,
    structuredContent: Record<string, unknown>,
  ): CallToolResult {
    return {
      content: [{ type: "text", text: message }],
      structuredContent,
      isError: false,
    };
  }
}
