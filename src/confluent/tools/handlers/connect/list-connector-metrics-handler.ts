import { ClientManager } from "@src/confluent/client-manager.js";
import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  READ_ONLY,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { ListMetricsHandler } from "@src/confluent/tools/handlers/metrics/list-metrics-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { EnvVar, TELEMETRY_REQUIRED_ENV_VARS } from "@src/env-schema.js";
import { z } from "zod";

const listConnectorMetricsArguments = z.object({});

export class ListConnectorMetricsHandler extends BaseToolHandler {
  private inner = new ListMetricsHandler();

  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    listConnectorMetricsArguments.parse(toolArguments ?? {});
    return this.inner.handle(clientManager, { resource_type: "connector" });
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.LIST_CONNECTOR_METRICS,
      description:
        "List Confluent Cloud connector metrics available from the Telemetry API. Equivalent to list-available-metrics with resource_type=connector.",
      inputSchema: listConnectorMetricsArguments.shape,
      annotations: READ_ONLY,
    };
  }

  getRequiredEnvVars(): readonly EnvVar[] {
    return TELEMETRY_REQUIRED_ENV_VARS;
  }

  isConfluentCloudOnly(): boolean {
    return true;
  }
}
