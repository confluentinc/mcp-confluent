import { z } from "zod";
// Prompt definition for analyzing Confluent Cloud metrics
const REPORT_CLUSTER_USAGE = "REPORT_CLUSTER_USAGE";

export const reportClusterUsagePrompt = {
  name: REPORT_CLUSTER_USAGE,
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
  inputSchema: z.object({
    clusterId: z
      .string()
      .describe("The Kafka cluster ID (e.g., lkc-xxxxxx)")
      .default(process.env.KAFKA_CLUSTER_ID || ""),
  }),
  arguments: [
    {
      name: "clusterId",
      description: "The Kafka cluster ID (e.g., lkc-xxxxxx)",
      required: true,
    },
  ],
};
