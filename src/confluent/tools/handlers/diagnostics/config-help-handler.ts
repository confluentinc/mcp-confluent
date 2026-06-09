import { CallToolResult } from "@src/confluent/schema.js";
import {
  READ_ONLY,
  ToolCategory,
  ToolConfig,
  ToolHandler,
} from "@src/confluent/tools/base-tools.js";
import {
  alwaysEnabled,
  ToolDisabledReason,
} from "@src/confluent/tools/connection-predicates.js";
import { ToolMetadataHandler } from "@src/confluent/tools/tool-metadata-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { z } from "zod";

const configHelpArguments = z.object({
  tool: z
    .string()
    .trim()
    .min(1, "tool cannot be empty")
    .describe(
      "The tool name exactly as it appears in tools/list (e.g. 'list-tableflow-topics', 'create-flink-statement') that you want to enable. config-help inspects every configured connection, finds the config gap each one is missing for this tool, and returns the YAML block to add to unlock it.",
    ),
});

/**
 * Per-connection advice for the target tool. `enabled` mirrors the tool's
 * predicate verdict on that connection; the remaining fields are populated
 * only when the tool is disabled there:
 *   - `currentState` — the {@link ToolDisabledReason}'s human phrasing.
 *   - `suggestedYaml` — a copy-pasteable YAML fragment that closes the gap,
 *     present whenever the gap is a missing direct-connection block or field.
 *   - `note` — guidance when there is no YAML to suggest (OAuth connections
 *     carry no service blocks, so the tool simply isn't reachable that way).
 */
interface ConnectionAdvice {
  enabled: boolean;
  currentState?: string;
  suggestedYaml?: string;
  note?: string;
}

interface ConfigHelpPayload {
  tool: string;
  alreadyEnabled: boolean;
  connections: Record<string, ConnectionAdvice>;
}

/**
 * Config-coaching tool: given a tool name, returns the YAML each configured
 * connection is missing to enable it.
 *
 * Where {@link ExplainDisabledToolsHandler} answers "which tools are off and
 * why?" across the whole catalog, this tool inverts the question — "I want
 * *this* tool; what do I add to my config?" — and hands back a ready-to-paste
 * YAML fragment derived from the gap between the connection's current shape and
 * the tool's predicate requirement.
 *
 * The mechanism is the same verdict map every diagnostic surface reads:
 * {@link BaseToolHandler.connectionVerdicts} turns the target handler's
 * `predicate` into a per-connection `PredicateResult`; a disabled verdict
 * carries a {@link ToolDisabledReason}, which {@link adviceForReason} maps to
 * the YAML that closes that specific gap. The tool only suggests — it never
 * mutates config, and (per the issue's out-of-scope note) it assumes the
 * schema in `models.ts` keeps the suggested YAML valid rather than re-parsing
 * it.
 *
 * Always enabled (predicate = `alwaysEnabled`): an operator must be able to ask
 * how to fix a config that left the tool they want disabled.
 *
 * The tool catalog is supplied through the thunk that {@link
 * ToolMetadataHandler} owns, for the ESM-cycle reason documented there.
 */
export class ConfigHelpHandler extends ToolMetadataHandler {
  handle(
    runtime: ServerRuntime,
    toolArguments?: Record<string, unknown>,
  ): CallToolResult {
    const { tool } = configHelpArguments.parse(toolArguments ?? {});

    const handler = this.findHandler(tool);
    if (handler === undefined) {
      return this.createResponse(
        `Unknown tool "${tool}". Pass a tool name exactly as it appears in tools/list (e.g. "list-tableflow-topics"). Call list-configured-connections or explain-disabled-tools to discover tool names.`,
        true,
      );
    }

    const verdicts = handler.connectionVerdicts(runtime);
    const connections: Record<string, ConnectionAdvice> = {};
    let alreadyEnabled = false;
    for (const [connId, verdict] of verdicts) {
      if (verdict.enabled) {
        alreadyEnabled = true;
        connections[connId] = { enabled: true };
        continue;
      }
      const advice = adviceForReason(verdict.reason, connId);
      connections[connId] = {
        enabled: false,
        currentState: verdict.reason,
        ...advice,
      };
    }

    const payload: ConfigHelpPayload = {
      tool,
      alreadyEnabled,
      connections,
    };
    return this.createStructuredResponse(renderAdvice(payload), { ...payload });
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.CONFIG_HELP,
      description:
        'Call when the user wants to enable or unlock a specific tool (e.g. "how do I enable the tableflow tools?", "what config does create-flink-statement need?", "why isn\'t list-topics showing up — fix it"). Given a tool name, returns a copy-pasteable YAML snippet, per connection, that closes the gap between the current config and what that tool requires. Suggests only — it never edits your config file. Prefer explain-disabled-tools when the question is "what\'s off and why?" across all tools; prefer this when the user has a target tool in mind and wants the exact YAML to add.',
      inputSchema: configHelpArguments.shape,
      annotations: READ_ONLY,
    };
  }

  /**
   * Resolve a tool name (the `tools/list` string, i.e. a {@link ToolName}
   * enum *value*) to its handler. Linear scan over the catalog; the catalog is
   * small and this runs once per invocation.
   */
  private findHandler(tool: string): ToolHandler | undefined {
    for (const [name, handler] of this.getToolNamesAndHandlers()) {
      if (name === tool) return handler;
    }
    return undefined;
  }

  readonly category = ToolCategory.McpServerDiagnostics;
  readonly predicate = alwaysEnabled;
}

/** Body of an `auth` block (api_key flavor) at the given indentation. */
function apiKeyAuth(indent: string, keyVar: string, secretVar: string): string {
  return [
    `${indent}auth:`,
    `${indent}  type: api_key`,
    `${indent}  key: "\${${keyVar}}"`,
    `${indent}  secret: "\${${secretVar}}"`,
  ].join("\n");
}

/**
 * Render a connection id as a YAML mapping key. Connection ids are only
 * constrained to non-empty trimmed strings (`mcpConfigSchema`), so an id
 * containing `:`, spaces, or other YAML-significant characters would produce an
 * invalid key if emitted bare. Plain ids (e.g. `default`) stay unquoted to keep
 * the snippet readable; anything else is double-quoted with embedded quotes and
 * backslashes escaped.
 */
function yamlKey(connId: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(connId)) return connId;
  // A YAML double-quoted scalar accepts the same C-style escapes JSON uses
  // (\\, \", \n, \t, \uXXXX), so JSON.stringify produces a valid quoted key.
  return JSON.stringify(connId);
}

/**
 * Wrap a connection-scoped block body in the `connections.<connId>` envelope so
 * the snippet can be pasted at the top level of a config YAML file. `blockBody`
 * lines are expected to start at four-space indentation (one level under
 * `  <connId>:`).
 */
function wrap(connId: string, blockBody: string): string {
  return `connections:\n  ${yamlKey(connId)}:\n${blockBody}`;
}

/**
 * Map a {@link ToolDisabledReason} to the config change that resolves it. Each
 * snippet mirrors the canonical shape in `config.example.yaml`. Reasons that
 * stem from an OAuth connection carry no YAML — OAuth connections hold no
 * service blocks, so the fix is a different connection type, surfaced as a
 * `note` instead.
 *
 * Exhaustive over `ToolDisabledReason`: every arm returns, and the `default`
 * arm pins `reason` to `never`, so a new reason added to the enum fails
 * `tsc --noEmit` here until it gets a case. The `default` also throws at
 * runtime as a belt-and-suspenders guard against an unmapped reason reaching
 * the spread in `handle()`.
 */
function adviceForReason(
  reason: ToolDisabledReason,
  connId: string,
): Pick<ConnectionAdvice, "suggestedYaml" | "note"> {
  switch (reason) {
    case ToolDisabledReason.MissingKafkaBlock:
      return {
        suggestedYaml: wrap(
          connId,
          [
            `    kafka:`,
            `      bootstrap_servers: "\${BOOTSTRAP_SERVERS}"`,
            apiKeyAuth("      ", "KAFKA_API_KEY", "KAFKA_API_SECRET"),
          ].join("\n"),
        ),
      };
    case ToolDisabledReason.MissingKafkaBootstrap:
      return {
        suggestedYaml: wrap(
          connId,
          [
            `    kafka:`,
            `      bootstrap_servers: "\${BOOTSTRAP_SERVERS}"`,
          ].join("\n"),
        ),
      };
    case ToolDisabledReason.MissingKafkaAuth:
      return {
        suggestedYaml: wrap(
          connId,
          [
            `    kafka:`,
            apiKeyAuth("      ", "KAFKA_API_KEY", "KAFKA_API_SECRET"),
          ].join("\n"),
        ),
      };
    case ToolDisabledReason.MissingKafkaRestEndpoint:
      return {
        suggestedYaml: wrap(
          connId,
          [`    kafka:`, `      rest_endpoint: "\${KAFKA_REST_ENDPOINT}"`].join(
            "\n",
          ),
        ),
      };
    case ToolDisabledReason.MissingSchemaRegistryBlock:
      return {
        suggestedYaml: wrap(
          connId,
          [
            `    schema_registry:`,
            `      endpoint: "\${SCHEMA_REGISTRY_ENDPOINT}"`,
            apiKeyAuth(
              "      ",
              "SCHEMA_REGISTRY_API_KEY",
              "SCHEMA_REGISTRY_API_SECRET",
            ),
          ].join("\n"),
        ),
      };
    case ToolDisabledReason.MissingSchemaRegistryApiKeyAuth:
      return {
        suggestedYaml: wrap(
          connId,
          [
            `    schema_registry:`,
            apiKeyAuth(
              "      ",
              "SCHEMA_REGISTRY_API_KEY",
              "SCHEMA_REGISTRY_API_SECRET",
            ),
          ].join("\n"),
        ),
      };
    case ToolDisabledReason.MissingConfluentCloudBlock:
      return {
        suggestedYaml: wrap(
          connId,
          [
            `    confluent_cloud:`,
            apiKeyAuth(
              "      ",
              "CONFLUENT_CLOUD_API_KEY",
              "CONFLUENT_CLOUD_API_SECRET",
            ),
          ].join("\n"),
        ),
      };
    case ToolDisabledReason.MissingFlinkBlock:
      return {
        suggestedYaml: wrap(
          connId,
          [
            `    flink:`,
            `      endpoint: "\${FLINK_REST_ENDPOINT}"`,
            apiKeyAuth("      ", "FLINK_API_KEY", "FLINK_API_SECRET"),
            `      organization_id: "\${FLINK_ORG_ID}"`,
            `      environment_id: "\${FLINK_ENV_ID}"`,
            `      compute_pool_id: "\${FLINK_COMPUTE_POOL_ID}"`,
          ].join("\n"),
        ),
      };
    case ToolDisabledReason.MissingTelemetryBlock:
      return {
        suggestedYaml: wrap(
          connId,
          [
            `    telemetry:`,
            apiKeyAuth("      ", "TELEMETRY_API_KEY", "TELEMETRY_API_SECRET"),
          ].join("\n"),
        ),
      };
    case ToolDisabledReason.MissingTableflowBlock:
      return {
        suggestedYaml: wrap(
          connId,
          [
            `    tableflow:`,
            apiKeyAuth("      ", "TABLEFLOW_API_KEY", "TABLEFLOW_API_SECRET"),
          ].join("\n"),
        ),
      };
    case ToolDisabledReason.OAuthNoServiceBlocks:
      return {
        note: `Connection "${connId}" is an OAuth connection, which carries no service blocks. This tool reads a service block that OAuth cannot provide, so it is not reachable on an OAuth connection — add a direct (api_key) connection with the required block instead.`,
      };
    case ToolDisabledReason.OAuthNotDirectCapable:
      return {
        note: `Connection "${connId}" is an OAuth connection. This tool requires a direct (api_key) connection and cannot run against OAuth — switch to a direct connection carrying the required block.`,
      };
    default: {
      const exhaustive: never = reason;
      throw new Error(`Unmapped ToolDisabledReason: ${String(exhaustive)}`);
    }
  }
}

/**
 * Human-readable rendering of the advice payload. The structured payload is
 * authoritative; this text is the at-a-glance view. Handler tests pin the
 * already-enabled and per-connection headers so the format stays stable.
 */
function renderAdvice(payload: ConfigHelpPayload): string {
  const { tool, alreadyEnabled, connections } = payload;
  const entries = Object.entries(connections);

  if (entries.length === 0) {
    return `No connections are configured, so there is nothing to enable "${tool}" against. Add a connection to your config first.`;
  }

  if (alreadyEnabled) {
    const enabledIds = entries
      .filter(([, advice]) => advice.enabled)
      .map(([id]) => id)
      .sort((a, b) => a.localeCompare(b));
    return `Tool "${tool}" is already enabled on connection(s): ${enabledIds.join(", ")}. No config change needed.`;
  }

  const blocks = entries.map(([connId, advice]) => {
    const header = `  connection "${connId}" — ${advice.currentState ?? "disabled"}`;
    if (advice.suggestedYaml !== undefined) {
      // Indent the YAML two spaces so it reads as a nested block under the
      // connection header rather than as top-level config.
      const indented = advice.suggestedYaml
        .split("\n")
        .map((line) => (line.length > 0 ? `    ${line}` : line))
        .join("\n");
      return `${header}\n  Add to your config YAML:\n\n${indented}`;
    }
    return `${header}\n  ${advice.note ?? ""}`;
  });

  return [
    `Tool "${tool}" is disabled on all ${entries.length} configured connection(s). To enable it:`,
    "",
    blocks.join("\n\n"),
  ].join("\n");
}
