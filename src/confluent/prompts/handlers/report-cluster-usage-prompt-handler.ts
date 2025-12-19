import { z } from "zod";
import {
  BasePromptHandler,
  PromptConfig,
} from "@src/confluent/prompts/base-prompts.js";
import { PromptName } from "@src/confluent/prompts/prompt-name.js";
import { ClientManager } from "@src/confluent/client-manager.js";
import { PromptResult } from "@src/confluent/prompts/base-prompts.js";
import { EnvVar } from "@src/env-schema.js";
import env from "@src/env.js";

const reportClusterUsageArguments = z.object({
  clusterId: z
    .string()
    .optional()
    .describe(
      "The Kafka cluster ID (e.g., lkc-xxxxxx). If not provided, will use KAFKA_CLUSTER_ID environment variable.",
    ),
});

export class ReportClusterUsagePromptHandler extends BasePromptHandler {
  getSchema() {
    return reportClusterUsageArguments;
  }

  getPromptConfig(): PromptConfig {
    return {
      name: PromptName.REPORT_CLUSTER_USAGE,
      description:
        "Analyze the metrics for a Confluent Cloud cluster {clusterId}. " +
        "Inform the user about the Kafka Cluster Id you are using to get metrics from. " +
        "Follow the steps to perform the task: " +
        "1. You can get metrics descriptors using the get-metrics-descriptors tool." +
        "2. Use the get-confluent-cloud-metrics tool to fetch all the available cluster metrics." +
        "3. When you have the metrics results, build a table with the following columns: metric, value and selected period. " +
        "Discard metrics with 0 or empty values and add a disclaimer below the table. " +
        "4. Add a summary about the most relevant metrics and their values, and a metric description." +
        "5. Try to identify the most active topic in the cluster. If you need more data to solve this task, " +
        "use the get-topic-metrics tool to get the metrics grouped by topic. " +
        "6. Try to identify the principal responsible for the most relevant metrics. " +
        "If you need more data to solve this task, use the get-principal-metrics tool to get the metrics grouped by principal. " +
        "7. Report for unused resources, like inactive topics, where inactive topics means no received data or not consumed data from the topic",
      inputSchema: reportClusterUsageArguments.shape,
    };
  }

  getRequiredEnvVars(): EnvVar[] {
    return [
      "CONFLUENT_CLOUD_API_KEY",
      "CONFLUENT_CLOUD_API_SECRET",
      "CONFLUENT_CLOUD_TELEMETRY_ENDPOINT",
    ];
  }

  isConfluentCloudOnly(): boolean {
    return true;
  }

  async handle(
    clientManager: ClientManager,
    promptArguments: Record<string, unknown> | undefined,
  ): Promise<PromptResult> {
    const args = this.getSchema().parse(promptArguments ?? {});

    // Use provided clusterId or fall back to environment variable
    const clusterId = args.clusterId || env.KAFKA_CLUSTER_ID || "";

    if (!clusterId) {
      return this.createResponse(
        "Error: No cluster ID provided and KAFKA_CLUSTER_ID environment variable is not set.",
        true,
      );
    }

    // This is a template prompt that provides instructions for the AI assistant
    // The actual analysis will be performed by the AI using the available tools
    const instructionText = `
Analyze metrics for Confluent Cloud cluster: ${clusterId}

Please follow these steps:

1. **Get Metrics Descriptors**: Use the \`get-metrics-descriptors\` tool to understand available metrics
2. **Fetch Cluster Metrics**: Use the \`get-confluent-cloud-metrics\` tool with resourceIds: {"resource.kafka.id": ["${clusterId}"]}
3. **Create Metrics Table**: Build a table with columns: metric, value, period. Exclude zero/empty values
4. **Metrics Summary**: Analyze the most relevant metrics and provide descriptions
5. **Topic Analysis**: Use \`get-topic-metrics\` tool to identify the most active topics
6. **Principal Analysis**: Use \`get-principal-metrics\` tool to identify active principals
7. **Resource Utilization**: Report on unused resources like inactive topics

Add a disclaimer about excluded zero-value metrics in your analysis.
`;

    return this.createResponse(instructionText.trim());
  }
}
