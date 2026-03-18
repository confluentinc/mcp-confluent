# Observability Tools Quick Start

## Overview

This guide shows you how to add observability capabilities to your Confluent Cloud MCP server in 3 phases:

```
Phase 1: Metrics & Health (HIGH PRIORITY)
├── get-cluster-metrics        ⭐ Start here
├── check-consumer-lag         ⭐ High value
└── get-topic-metrics

Phase 2: Infrastructure Discovery
├── describe-cluster-config    (Extends existing list-clusters)
└── get-partition-metrics

Phase 3: Security & Governance
├── check-client-quotas
├── get-schema-registry-status
└── stream-audit-logs
```

## What You Already Have

✅ **Telemetry Client** - Ready to use in `client-manager.ts`
```typescript
getConfluentCloudTelemetryRestClient(): Client<paths, `${string}/${string}`>
```

✅ **Authentication** - Configured via env vars
```bash
TELEMETRY_ENDPOINT=https://api.telemetry.confluent.cloud
TELEMETRY_API_KEY=<your-key>    # Falls back to CONFLUENT_CLOUD_API_KEY
TELEMETRY_API_SECRET=<your-secret>
```

✅ **Base Architecture** - Tool handler pattern established
- All tools extend `BaseToolHandler`
- Registered in `ToolFactory`
- Auto-discovery via `ToolName` enum

## 30-Minute Quick Start

### Step 1: Create Metrics Helper (5 min)

**File**: `src/confluent/tools/handlers/metrics/metrics-helper.ts`

```typescript
import { Client } from "openapi-fetch";
import { paths } from "@src/confluent/openapi-schema.js";

/**
 * Query Confluent Cloud Metrics API v2
 */
export async function queryMetrics(
  client: Client<paths, `${string}/${string}`>,
  dataset: "cloud" | "kafka",
  clusterId: string,
  metrics: string[],
  timeRangeMinutes: number = 60
) {
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - timeRangeMinutes * 60000);

  const response = await (client as any).POST(`/v2/metrics/${dataset}/query`, {
    body: {
      aggregations: metrics.map(m => ({ metric: m, agg: "SUM" })),
      filter: {
        op: "AND",
        filters: [
          { field: "resource.kafka.id", op: "EQ", value: clusterId }
        ]
      },
      granularity: "PT5M",
      intervals: [`${startTime.toISOString()}/${endTime.toISOString()}`],
      limit: 1000
    }
  });

  if (response.error) {
    throw new Error(`Metrics API error: ${JSON.stringify(response.error)}`);
  }

  return response.data;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}
```

### Step 2: Create Your First Metric Tool (15 min)

**File**: `src/confluent/tools/handlers/metrics/get-cluster-metrics-handler.ts`

```typescript
import { ClientManager } from "@src/confluent/client-manager.js";
import { CallToolResult } from "@src/confluent/schema.js";
import { BaseToolHandler, ToolConfig } from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { EnvVar } from "@src/env-schema.js";
import { logger } from "@src/logger.js";
import { z } from "zod";
import { queryMetrics, formatBytes } from "./metrics-helper.js";

const getClusterMetricsArguments = z.object({
  clusterId: z.string()
    .describe("Kafka cluster ID (e.g., lkc-xxxxx)")
    .startsWith("lkc-"),
  timeRangeMinutes: z.number()
    .default(60)
    .describe("Look back time in minutes (default: 60)"),
});

export class GetClusterMetricsHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const { clusterId, timeRangeMinutes } =
      getClusterMetricsArguments.parse(toolArguments);

    try {
      const client = clientManager.getConfluentCloudTelemetryRestClient();

      const data = await queryMetrics(
        client,
        "cloud",
        clusterId,
        [
          "io.confluent.kafka.server/received_bytes",
          "io.confluent.kafka.server/sent_bytes",
          "io.confluent.kafka.server/active_connection_count",
        ],
        timeRangeMinutes
      );

      // Extract latest values
      const latest = data.data[data.data.length - 1] || {};
      const receivedBytes = latest["io.confluent.kafka.server/received_bytes"] || 0;
      const sentBytes = latest["io.confluent.kafka.server/sent_bytes"] || 0;
      const connections = latest["io.confluent.kafka.server/active_connection_count"] || 0;

      return this.createResponse(
        `Cluster Metrics: ${clusterId}

📊 Last ${timeRangeMinutes} minutes:
  • Active Connections: ${connections}
  • Received: ${formatBytes(receivedBytes)}
  • Sent: ${formatBytes(sentBytes)}
  • Total Throughput: ${formatBytes(receivedBytes + sentBytes)}`,
        false,
        { clusterId, metrics: { receivedBytes, sentBytes, connections } }
      );

    } catch (error) {
      logger.error({ error }, "Error fetching cluster metrics");
      return this.createResponse(
        `Failed to fetch metrics: ${error instanceof Error ? error.message : String(error)}`,
        true
      );
    }
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.GET_CLUSTER_METRICS,
      description: "Get real-time metrics for a Kafka cluster including throughput and active connections",
      inputSchema: getClusterMetricsArguments.shape,
    };
  }

  getRequiredEnvVars(): EnvVar[] {
    return ["TELEMETRY_API_KEY", "TELEMETRY_API_SECRET"];
  }

  isConfluentCloudOnly(): boolean {
    return true;
  }
}
```

### Step 3: Register the Tool (5 min)

**1. Add to tool names** (`src/confluent/tools/tool-name.ts`):
```typescript
export enum ToolName {
  // ... existing tools
  GET_CLUSTER_METRICS = "get-cluster-metrics",
}
```

**2. Register in factory** (`src/confluent/tools/tool-factory.ts`):
```typescript
import { GetClusterMetricsHandler } from "@src/confluent/tools/handlers/metrics/get-cluster-metrics-handler.js";

private static handlers: Map<ToolName, ToolHandler> = new Map([
  // ... existing handlers
  [ToolName.GET_CLUSTER_METRICS, new GetClusterMetricsHandler()],
]);
```

### Step 4: Test It (5 min)

```bash
# Build
npm run build

# Run the server
npm run mcp-confluent

# In your AI client (Claude Desktop, etc.)
# Use the tool:
{
  "clusterId": "lkc-xxxxx",
  "timeRangeMinutes": 60
}
```

## Next: Add Consumer Lag Monitoring

Consumer lag is one of the most requested observability features. Here's how to add it:

**File**: `src/confluent/tools/handlers/metrics/check-consumer-lag-handler.ts`

```typescript
import { ClientManager } from "@src/confluent/client-manager.js";
import { CallToolResult } from "@src/confluent/schema.js";
import { BaseToolHandler, ToolConfig } from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { EnvVar } from "@src/env-schema.js";
import { logger } from "@src/logger.js";
import { z } from "zod";

const checkConsumerLagArguments = z.object({
  clusterId: z.string()
    .describe("Kafka cluster ID")
    .startsWith("lkc-"),
  consumerGroupId: z.string()
    .describe("Consumer group ID to check for lag"),
  warnThreshold: z.number()
    .default(1000)
    .describe("Lag threshold to trigger warning"),
});

export class CheckConsumerLagHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const { clusterId, consumerGroupId, warnThreshold } =
      checkConsumerLagArguments.parse(toolArguments);

    try {
      const kafkaClient = clientManager.getConfluentCloudKafkaRestClient();

      // Call Kafka REST API v3 for consumer lag
      const response = await (kafkaClient as any).GET(
        `/kafka/v3/clusters/${clusterId}/consumer-groups/${consumerGroupId}/lag-summary`
      );

      if (response.error) {
        throw new Error(`Failed to fetch consumer lag: ${JSON.stringify(response.error)}`);
      }

      const lagData = response.data;
      const totalLag = lagData.max_lag_consumer?.total_lag || 0;
      const isLagging = totalLag > warnThreshold;

      return this.createResponse(
        `Consumer Group: ${consumerGroupId}

Status: ${isLagging ? "⚠️  LAGGING" : "✅ Healthy"}
Total Lag: ${totalLag.toLocaleString()} messages

${lagData.max_lag_consumer ? `
Max Lag Consumer:
  • Client: ${lagData.max_lag_consumer.client_id}
  • Topic: ${lagData.max_lag_consumer.topic}
  • Partition: ${lagData.max_lag_consumer.partition}
  • Lag: ${lagData.max_lag_consumer.lag}
` : ""}`,
        isLagging,
        {
          consumerGroupId,
          totalLag,
          isLagging,
          maxLagConsumer: lagData.max_lag_consumer
        }
      );

    } catch (error) {
      logger.error({ error }, "Error checking consumer lag");
      return this.createResponse(
        `Failed to check consumer lag: ${error instanceof Error ? error.message : String(error)}`,
        true
      );
    }
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.CHECK_CONSUMER_LAG,
      description: "Check if a consumer group is lagging behind in message consumption",
      inputSchema: checkConsumerLagArguments.shape,
    };
  }

  getRequiredEnvVars(): EnvVar[] {
    return ["KAFKA_API_KEY", "KAFKA_API_SECRET", "KAFKA_REST_ENDPOINT"];
  }

  isConfluentCloudOnly(): boolean {
    return true;
  }
}
```

Don't forget to register it:
```typescript
// tool-name.ts
CHECK_CONSUMER_LAG = "check-consumer-lag",

// tool-factory.ts
[ToolName.CHECK_CONSUMER_LAG, new CheckConsumerLagHandler()],
```

## Common Metrics Reference

### Cluster-Level Metrics
```
io.confluent.kafka.server/received_bytes        - Data ingress rate
io.confluent.kafka.server/sent_bytes           - Data egress rate
io.confluent.kafka.server/retained_bytes       - Total data stored
io.confluent.kafka.server/active_connection_count - Active clients
io.confluent.kafka.server/request_bytes        - Request size
io.confluent.kafka.server/response_bytes       - Response size
io.confluent.kafka.server/cluster_load_percent - Cluster utilization %
```

### Topic-Level Metrics (add filter)
```
Filter: { field: "metric.topic", op: "EQ", value: "topic-name" }

Same metrics as cluster, scoped to topic
```

### Partition-Level Metrics (add filter)
```
Filter: { field: "metric.partition", op: "EQ", value: "0" }

Same metrics as topic, scoped to partition
```

## Troubleshooting

### Error: "Telemetry endpoint not configured"
**Solution**: Set environment variables
```bash
export TELEMETRY_ENDPOINT=https://api.telemetry.confluent.cloud
export TELEMETRY_API_KEY=<your-cloud-api-key>
export TELEMETRY_API_SECRET=<your-cloud-api-secret>
```

### Error: "401 Unauthorized"
**Solution**: Ensure your Cloud API key has MetricsViewer role
```bash
confluent iam rbac role-binding create \
  --principal User:sa-xxxxx \
  --role MetricsViewer \
  --cloud-cluster lkc-xxxxx
```

### No data returned
**Solution**: Check time range - metrics may not be available for very recent data (lag ~2-5 min)

## API Rate Limits

| API | Rate Limit | Best Practice |
|-----|------------|---------------|
| Metrics API | 100 req/min | Cache results for 1-5 minutes |
| Kafka REST API | 1000 req/min | Use batch operations |
| Cloud API | 100 req/min | Cache cluster metadata |

## What's Next?

After implementing the core metrics tools, consider:

1. **Alerting Integration** - Use metric thresholds to trigger notifications
2. **Dashboards** - Aggregate metrics over time for trend analysis
3. **Cost Monitoring** - Combine metrics with billing API data
4. **Multi-Cluster** - Query metrics across all clusters
5. **SLA Tracking** - Monitor availability and latency SLAs

## Resources

- Full implementation guide: `OBSERVABILITY_IMPLEMENTATION_GUIDE.md`
- Confluent Metrics API: https://docs.confluent.io/cloud/current/monitoring/metrics-api.html
- Kafka REST API: https://docs.confluent.io/cloud/current/api.html
