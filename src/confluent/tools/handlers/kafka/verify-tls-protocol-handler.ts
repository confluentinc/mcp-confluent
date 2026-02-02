import {
  BaseToolHandler,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ClientManager } from "@src/confluent/client-manager.js";
import { z } from "zod";
import { TextContent } from "@modelcontextprotocol/sdk/types.js";

/**
 * Handler for verifying TLS protocols on Confluent Cloud Kafka clusters
 * Based on https://docs.confluent.io/cloud/current/security/encrypt/tls.html#verify-tls-protocols
 */
export class VerifyTlsProtocolsHandler extends BaseToolHandler {
  constructor() {
    super();
  }

  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown> | undefined,
  ) {
    // Extract clusterId from toolArguments
    const clusterId = toolArguments?.clusterId as string;

    if (!clusterId) {
      throw new Error("Cluster ID is required");
    }

    try {
      // Get Kafka REST endpoint from environment
      const kafkaRestEndpoint = process.env.KAFKA_REST_ENDPOINT;
      const kafkaApiKey = process.env.KAFKA_API_KEY;
      const kafkaApiSecret = process.env.KAFKA_API_SECRET;

      if (!kafkaRestEndpoint || !kafkaApiKey || !kafkaApiSecret) {
        throw new Error(
          "Missing required Kafka configuration. Please ensure KAFKA_REST_ENDPOINT, KAFKA_API_KEY, and KAFKA_API_SECRET are set.",
        );
      }

      // Construct the API endpoint for broker configuration
      const url = `${kafkaRestEndpoint}/kafka/v3/clusters/${clusterId}/broker-configs/ssl.enabled.protocols`;

      // Make the API request
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Basic ${Buffer.from(`${kafkaApiKey}:${kafkaApiSecret}`).toString("base64")}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Failed to retrieve TLS configuration: ${response.status} ${response.statusText}\n${errorText}`,
        );
      }

      const data = await response.json();

      // Parse the TLS configuration
      const tlsProtocols = data.value || "TLSv1.2"; // Default if not explicitly set
      const isReadOnly = data.read_only || false;

      // Analyze the configuration
      let analysis = `## TLS Protocol Configuration for Cluster ${clusterId}\n\n`;
      analysis += `**Enabled Protocols:** ${tlsProtocols}\n`;
      analysis += `**Read-only:** ${isReadOnly}\n\n`;

      // Provide recommendations
      analysis += `### Analysis:\n`;

      if (tlsProtocols === "TLSv1.3") {
        analysis += `✅ **Excellent!** Your cluster is using TLS 1.3 exclusively, which provides the strongest security.\n\n`;
      } else if (
        tlsProtocols.includes("TLSv1.3") &&
        tlsProtocols.includes("TLSv1.2")
      ) {
        analysis += `✅ **Good!** Your cluster supports both TLS 1.3 and TLS 1.2, allowing for a smooth migration path.\n\n`;
        analysis += `### Recommendations:\n`;
        analysis += `- Monitor client connections to ensure all clients support TLS 1.3\n`;
        analysis += `- Once all clients are verified to use TLS 1.3, consider removing TLS 1.2 for enhanced security\n`;
        analysis += `- Review audit logs to track TLS protocol usage per client\n\n`;
      } else if (tlsProtocols === "TLSv1.2") {
        analysis += `⚠️ **Warning:** Your cluster is using TLS 1.2 only.\n\n`;
        analysis += `### Recommendations:\n`;
        analysis += `1. Enable TLS 1.3 support by updating the broker configuration:\n`;
        analysis += `   - Set \`ssl.enabled.protocols=TLSv1.3,TLSv1.2\` to support both protocols\n`;
        analysis += `2. Ensure all Kafka clients are configured to support TLS 1.3:\n`;
        analysis += `   - Java clients v2.6.0+ default to TLS 1.3 support\n`;
        analysis += `   - For older Java clients (< 3.0.2/3.1.1), note potential performance issues\n`;
        analysis += `3. Verify all applications work correctly with TLS 1.3\n`;
        analysis += `4. After verification, optionally disable TLS 1.2: \`ssl.enabled.protocols=TLSv1.3\`\n\n`;
      } else {
        analysis += `⚠️ **Warning:** Unexpected TLS configuration detected: ${tlsProtocols}\n\n`;
      }

      // Add migration guide reference
      analysis += `### Migration Guide:\n`;
      analysis += `For detailed migration steps, see:\n`;
      analysis += `https://docs.confluent.io/cloud/current/security/encrypt/tls.html#migrate-to-tls-1-3-on-dedicated-clusters\n\n`;

      // Add troubleshooting tips
      analysis += `### Troubleshooting:\n`;
      analysis += `- If you see "configuration not found" error, the cluster is using default TLS 1.2\n`;
      analysis += `- Check audit logs for TLS suite and cipher information in kafka.Authentication events\n`;
      analysis += `- Use Confluent CLI: \`confluent kafka cluster configuration describe ssl.enabled.protocols --cluster ${clusterId}\`\n`;

      return {
        content: [
          {
            type: "text" as const,
            text: analysis,
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
            text: `Error verifying TLS protocols: ${errorMessage}`,
          } as TextContent,
        ],
      };
    }
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.VERIFY_TLS_PROTOCOLS,
      description:
        "Verify TLS protocols enabled on a Confluent Cloud Kafka cluster. Checks the ssl.enabled.protocols configuration and provides recommendations for TLS 1.3 migration.",
      inputSchema: {
        clusterId: z
          .string()
          .describe("The ID of the Kafka cluster to verify (e.g., lkc-abc123)"),
      },
    };
  }
}
