import {
  BaseToolHandler,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ClientManager } from "@src/confluent/client-manager.js";
import { z } from "zod";
import { TextContent } from "@modelcontextprotocol/sdk/types.js";

/**
 * Handler for updating TLS protocols on Confluent Cloud Kafka dedicated clusters
 * Based on https://docs.confluent.io/cloud/current/clusters/broker-config.html#manage-tls-protocols
 */
export class UpdateTlsProtocolsHandler extends BaseToolHandler {
  constructor() {
    super();
  }

  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown> | undefined,
  ) {
    const clusterId = toolArguments?.clusterId as string;
    const tlsProtocols = toolArguments?.tlsProtocols as string;
    const validateOnly = (toolArguments?.validateOnly as boolean) || false;

    if (!clusterId) {
      throw new Error("Cluster ID is required");
    }

    if (!tlsProtocols) {
      throw new Error("TLS protocols configuration is required");
    }

    // Validate TLS protocol values
    const validProtocols = ["TLSv1.2", "TLSv1.3"];
    const protocols = tlsProtocols.split(",").map((p) => p.trim());
    const invalidProtocols = protocols.filter(
      (p) => !validProtocols.includes(p),
    );

    if (invalidProtocols.length > 0) {
      throw new Error(
        `Invalid TLS protocols: ${invalidProtocols.join(", ")}. Valid values are: TLSv1.2, TLSv1.3`,
      );
    }

    try {
      const kafkaRestEndpoint = process.env.KAFKA_REST_ENDPOINT;
      const kafkaApiKey = process.env.KAFKA_API_KEY;
      const kafkaApiSecret = process.env.KAFKA_API_SECRET;

      if (!kafkaRestEndpoint || !kafkaApiKey || !kafkaApiSecret) {
        throw new Error(
          "Missing required Kafka configuration. Please ensure KAFKA_REST_ENDPOINT, KAFKA_API_KEY, and KAFKA_API_SECRET are set.",
        );
      }

      // Construct the API endpoint for altering broker configuration
      const url = `${kafkaRestEndpoint}/kafka/v3/clusters/${clusterId}/broker-configs:alter`;

      // Prepare the request payload
      const payload = {
        data: [
          {
            name: "ssl.enabled.protocols",
            value: tlsProtocols,
          },
        ],
        ...(validateOnly && { validate_only: true }),
      };

      // Make the API request
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${kafkaApiKey}:${kafkaApiSecret}`).toString("base64")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Failed to update TLS configuration: ${response.status} ${response.statusText}\n${errorText}`,
        );
      }

      // For validate_only mode, there might not be a response body
      let result = "";

      if (validateOnly) {
        result = `## TLS Protocol Configuration Validation\n\n`;
        result += `✅ **Validation Successful**\n\n`;
        result += `The following configuration is valid and can be applied:\n`;
        result += `- **Cluster:** ${clusterId}\n`;
        result += `- **Setting:** ssl.enabled.protocols\n`;
        result += `- **Value:** ${tlsProtocols}\n\n`;
        result += `To apply this configuration, run the same command with validateOnly set to false.\n`;
      } else {
        result = `## TLS Protocol Configuration Updated\n\n`;
        result += `✅ **Configuration Applied Successfully**\n\n`;
        result += `- **Cluster:** ${clusterId}\n`;
        result += `- **Setting:** ssl.enabled.protocols\n`;
        result += `- **New Value:** ${tlsProtocols}\n\n`;

        // Add migration guidance based on the configuration
        if (tlsProtocols === "TLSv1.3") {
          result += `### ⚠️ Important Notes:\n`;
          result += `- You have set TLS 1.3 only. Ensure all clients support TLS 1.3.\n`;
          result += `- Clients that only support TLS 1.2 will no longer be able to connect.\n`;
          result += `- Monitor your applications for connection issues.\n\n`;
        } else if (
          tlsProtocols.includes("TLSv1.3") &&
          tlsProtocols.includes("TLSv1.2")
        ) {
          result += `### Migration Path:\n`;
          result += `- Both TLS 1.3 and TLS 1.2 are now enabled.\n`;
          result += `- This allows for a gradual migration to TLS 1.3.\n`;
          result += `- Monitor client connections using audit logs.\n`;
          result += `- Once all clients use TLS 1.3, you can disable TLS 1.2.\n\n`;
        }

        result += `### Next Steps:\n`;
        result += `1. Monitor application logs for connection issues\n`;
        result += `2. Check audit logs for TLS protocol usage:\n`;
        result += `   - Look for kafka.Authentication events\n`;
        result += `   - Review TLS suite and cipher information\n`;
        result += `3. Verify using: confluent kafka cluster configuration describe ssl.enabled.protocols --cluster ${clusterId}\n\n`;

        result += `### Documentation:\n`;
        result += `- Manage TLS Protocols: https://docs.confluent.io/cloud/current/clusters/broker-config.html#manage-tls-protocols\n`;
        result += `- TLS Migration Guide: https://docs.confluent.io/cloud/current/security/encrypt/tls.html#migrate-to-tls-1-3-on-dedicated-clusters\n`;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: result,
          } as TextContent,
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text" as const,
            text: `Error updating TLS protocols: ${errorMessage}`,
          } as TextContent,
        ],
      };
    }
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.UPDATE_TLS_PROTOCOLS,
      description:
        "Update TLS protocols on a Confluent Cloud Kafka dedicated cluster. Configure ssl.enabled.protocols to enable TLS 1.3, TLS 1.2, or both. Use validateOnly to test the configuration before applying.",
      inputSchema: {
        clusterId: z
          .string()
          .describe("The ID of the Kafka dedicated cluster (e.g., lkc-abc123)"),
        tlsProtocols: z
          .string()
          .describe(
            'Comma-separated list of TLS protocols to enable. Valid values: "TLSv1.3", "TLSv1.2", or "TLSv1.3,TLSv1.2"',
          )
          .default("TLSv1.3,TLSv1.2"),
        validateOnly: z
          .boolean()
          .optional()
          .describe(
            "If true, validate the configuration without applying it. Default: false",
          )
          .default(false),
      },
    };
  }
}
