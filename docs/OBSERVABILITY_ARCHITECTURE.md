# Observability Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         AI Assistant                             │
│                    (Claude, ChatGPT, etc.)                       │
└────────────────────────┬────────────────────────────────────────┘
                         │ MCP Protocol
                         │
┌────────────────────────▼────────────────────────────────────────┐
│                    MCP Confluent Server                          │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              Tool Factory & Registry                      │   │
│  │  - get-cluster-metrics                                   │   │
│  │  - get-topic-metrics                                     │   │
│  │  - check-consumer-lag                                    │   │
│  │  - get-partition-metrics                                 │   │
│  │  - check-client-quotas                                   │   │
│  │  - stream-audit-logs                                     │   │
│  │  - get-schema-registry-status                            │   │
│  └──────────────────────┬───────────────────────────────────┘   │
│                         │                                        │
│  ┌──────────────────────▼───────────────────────────────────┐   │
│  │              Client Manager                               │   │
│  │  ┌──────────────────────────────────────────────────┐    │   │
│  │  │  Telemetry Client (Metrics API)                  │    │   │
│  │  │  - Cluster metrics                               │    │   │
│  │  │  - Topic metrics                                 │    │   │
│  │  │  - Partition metrics                             │    │   │
│  │  │  - Quota metrics                                 │    │   │
│  │  └──────────────────────────────────────────────────┘    │   │
│  │  ┌──────────────────────────────────────────────────┐    │   │
│  │  │  Cloud REST Client (Resource Management)         │    │   │
│  │  │  - Cluster discovery                             │    │   │
│  │  │  - Environment listing                           │    │   │
│  │  └──────────────────────────────────────────────────┘    │   │
│  │  ┌──────────────────────────────────────────────────┐    │   │
│  │  │  Kafka REST Client (Consumer Lag)                │    │   │
│  │  │  - Consumer group lag                            │    │   │
│  │  │  - Offset information                            │    │   │
│  │  └──────────────────────────────────────────────────┘    │   │
│  │  ┌──────────────────────────────────────────────────┐    │   │
│  │  │  Schema Registry Client                          │    │   │
│  │  │  - Schema health                                 │    │   │
│  │  │  - Compatibility checks                          │    │   │
│  │  └──────────────────────────────────────────────────┘    │   │
│  │  ┌──────────────────────────────────────────────────┐    │   │
│  │  │  Kafka Client (Audit Logs)                       │    │   │
│  │  │  - Consume audit events                          │    │   │
│  │  └──────────────────────────────────────────────────┘    │   │
│  └──────────────────────────────────────────────────────────┘   │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         │ HTTPS + Basic Auth
                         │
┌────────────────────────▼────────────────────────────────────────┐
│                   Confluent Cloud APIs                           │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Telemetry API (Metrics)                                 │   │
│  │  https://api.telemetry.confluent.cloud                   │   │
│  │  - POST /v2/metrics/cloud/query                          │   │
│  │  - POST /v2/metrics/kafka/query                          │   │
│  │  - GET  /v2/metrics/{dataset}/descriptors                │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Cloud API v2 (Resources)                                │   │
│  │  https://api.confluent.cloud                             │   │
│  │  - GET /cmk/v2/clusters                                  │   │
│  │  - GET /org/v2/environments                              │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Kafka REST API v3 (Consumer Lag)                        │   │
│  │  https://{cluster}.confluent.cloud                       │   │
│  │  - GET /kafka/v3/clusters/{id}/consumer-groups/{id}/lag  │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Schema Registry API                                     │   │
│  │  https://{sr-cluster}.confluent.cloud                    │   │
│  │  - GET /subjects                                         │   │
│  │  - GET /mode                                             │   │
│  │  - GET /config/{subject}                                 │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Kafka Protocol (Audit Logs)                             │   │
│  │  {bootstrap-servers}:9092                                │   │
│  │  - Topic: confluent-audit-log-events                     │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## Data Flow: Metrics Query Example

```
1. AI Request
   │
   ▼
[MCP Tool Call: get-cluster-metrics]
   clusterId: "lkc-12345"
   timeRangeMinutes: 60
   │
   ▼
2. Handler Validation
   │
   ▼
[GetClusterMetricsHandler.handle()]
   - Parse & validate arguments
   - Get telemetry client
   │
   ▼
3. API Request Construction
   │
   ▼
[queryMetrics() helper]
   POST /v2/metrics/cloud/query
   {
     "aggregations": [
       {"metric": "io.confluent.kafka.server/received_bytes", "agg": "SUM"}
     ],
     "filter": {
       "op": "AND",
       "filters": [{"field": "resource.kafka.id", "op": "EQ", "value": "lkc-12345"}]
     },
     "granularity": "PT5M",
     "intervals": ["2024-03-15T09:00:00Z/2024-03-15T10:00:00Z"]
   }
   │
   ▼
4. Confluent Telemetry API
   │
   ▼
5. Response Processing
   │
   ▼
[Format & Return]
   {
     "content": [{
       "type": "text",
       "text": "Cluster Metrics: lkc-12345\n..."
     }],
     "_meta": {
       "clusterId": "lkc-12345",
       "metrics": {...}
     }
   }
   │
   ▼
6. AI Assistant displays results
```

## Component Responsibilities

### 1. Tool Handlers (`src/confluent/tools/handlers/metrics/`)

**Purpose**: Implement business logic for each observability tool

**Responsibilities**:
- Input validation (Zod schemas)
- Client retrieval from ClientManager
- API request construction
- Response formatting
- Error handling

**Example Structure**:
```typescript
export class GetClusterMetricsHandler extends BaseToolHandler {
  async handle(clientManager, args): Promise<CallToolResult> {
    // 1. Validate input
    const { clusterId } = schema.parse(args);

    // 2. Get appropriate client
    const client = clientManager.getConfluentCloudTelemetryRestClient();

    // 3. Make API call
    const data = await queryMetrics(client, ...);

    // 4. Format response
    return this.createResponse(formattedText, false, metadata);
  }

  getRequiredEnvVars(): EnvVar[] {
    return ["TELEMETRY_API_KEY", "TELEMETRY_API_SECRET"];
  }
}
```

### 2. Metrics Helper (`src/confluent/tools/handlers/metrics/metrics-helper.ts`)

**Purpose**: Shared utilities for metric operations

**Responsibilities**:
- Common API query construction
- Time range calculations
- Data formatting (bytes, timestamps)
- Metric aggregation logic

**Functions**:
```typescript
queryMetrics(client, dataset, clusterId, metrics, timeRange)
formatBytes(bytes): string
formatTimestamp(iso): string
getTimeRange(range): { start, end }
aggregateMetrics(data): Summary
```

### 3. Client Manager (`src/confluent/client-manager.ts`)

**Purpose**: Manage all API client instances

**Existing Clients**:
- ✅ `getConfluentCloudTelemetryRestClient()` - Metrics API
- ✅ `getConfluentCloudRestClient()` - Cloud API v2
- ✅ `getConfluentCloudKafkaRestClient()` - Kafka REST API v3
- ✅ `getConfluentCloudSchemaRegistryRestClient()` - Schema Registry
- ✅ `getKafkaClient()` - Native Kafka client (for audit logs)

**Configuration**:
```typescript
endpoints: {
  telemetry: "https://api.telemetry.confluent.cloud",
  cloud: "https://api.confluent.cloud",
  kafka: "https://{cluster}.confluent.cloud",
  schemaRegistry: "https://{sr-cluster}.confluent.cloud"
}

auth: {
  telemetry: { apiKey, apiSecret },
  cloud: { apiKey, apiSecret },
  kafka: { apiKey, apiSecret },
  schemaRegistry: { apiKey, apiSecret }
}
```

## Tool Categories

### Category 1: Real-Time Metrics
**API**: Confluent Telemetry API v2
**Client**: `getConfluentCloudTelemetryRestClient()`

| Tool | Metrics Used | Scope |
|------|-------------|-------|
| get-cluster-metrics | received_bytes, sent_bytes, active_connection_count | Cluster-level |
| get-topic-metrics | received_bytes, sent_bytes, retained_bytes | Per-topic |
| get-partition-metrics | received_bytes, sent_bytes | Per-partition |
| check-client-quotas | request_count | Per principal |

**Query Pattern**:
```typescript
POST /v2/metrics/cloud/query
{
  aggregations: [{ metric: "...", agg: "SUM|AVG|MAX" }],
  filter: { field: "resource.kafka.id|metric.topic|metric.partition", ... },
  granularity: "PT1M|PT5M|PT15M|PT1H",
  intervals: ["startTime/endTime"]
}
```

### Category 2: Infrastructure Discovery
**API**: Confluent Cloud API v2
**Client**: `getConfluentCloudRestClient()`

| Tool | Endpoint | Purpose |
|------|----------|---------|
| list-clusters | GET /cmk/v2/clusters | List all clusters |
| describe-cluster-config | GET /cmk/v2/clusters/{id} | Get cluster details |
| list-environments | GET /org/v2/environments | List environments |

### Category 3: Consumer Health
**API**: Kafka REST API v3
**Client**: `getConfluentCloudKafkaRestClient()`

| Tool | Endpoint | Purpose |
|------|----------|---------|
| check-consumer-lag | GET /kafka/v3/clusters/{id}/consumer-groups/{id}/lag-summary | Consumer lag |

### Category 4: Schema Health
**API**: Schema Registry API
**Client**: `getConfluentCloudSchemaRegistryRestClient()`

| Tool | Endpoints | Purpose |
|------|-----------|---------|
| get-schema-registry-status | GET /subjects, GET /mode, GET /config/{subject} | Health check |

### Category 5: Audit & Security
**API**: Native Kafka protocol
**Client**: `getKafkaClient()`

| Tool | Method | Purpose |
|------|--------|---------|
| stream-audit-logs | Consumer.subscribe("confluent-audit-log-events") | Security events |

## Authentication Flow

```
┌─────────────────────────────────────────────────────────────┐
│  Environment Variables                                       │
│                                                              │
│  TELEMETRY_API_KEY        ─┐                                │
│  TELEMETRY_API_SECRET     ─┼─> Telemetry Client Auth        │
│                            │                                 │
│  (fallback)                │                                 │
│  CONFLUENT_CLOUD_API_KEY  ─┘                                │
│  CONFLUENT_CLOUD_API_SECRET                                 │
│                                                              │
│  KAFKA_API_KEY            ─┐                                │
│  KAFKA_API_SECRET         ─┼─> Kafka REST Client Auth       │
│                            │                                 │
│  SCHEMA_REGISTRY_API_KEY  ─┐                                │
│  SCHEMA_REGISTRY_API_SECRET┼─> Schema Registry Client Auth  │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Client Manager (client-manager.ts)                          │
│                                                              │
│  constructor(config: ClientManagerConfig) {                 │
│    this.confluentCloudTelemetryRestClient = new Lazy(() => {│
│      const client = createClient({                          │
│        baseUrl: config.endpoints.telemetry                  │
│      });                                                    │
│      client.use(createAuthMiddleware(config.auth.telemetry));│
│      return client;                                         │
│    });                                                      │
│  }                                                          │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Auth Middleware (middleware.ts)                             │
│                                                              │
│  createAuthMiddleware(auth: ConfluentAuth) {                │
│    return {                                                 │
│      onRequest({ request }) {                               │
│        const credentials = btoa(`${auth.apiKey}:${auth.apiSecret}`);│
│        request.headers.set(                                 │
│          "Authorization",                                   │
│          `Basic ${credentials}`                             │
│        );                                                   │
│      }                                                      │
│    };                                                       │
│  }                                                          │
└─────────────────────────────────────────────────────────────┘
```

## Error Handling Strategy

### Levels of Error Handling

**1. Tool Handler Level** (Outer layer)
```typescript
async handle(clientManager, args): Promise<CallToolResult> {
  try {
    // Validation, API calls, processing
    return this.createResponse(successMessage, false, metadata);
  } catch (error) {
    logger.error({ error }, "Tool execution failed");
    return this.createResponse(errorMessage, true);
  }
}
```

**2. Helper Function Level** (Inner layer)
```typescript
export async function queryMetrics(...) {
  const response = await client.POST("/v2/metrics/cloud/query", { body });

  if (response.error) {
    throw new Error(`Metrics API error: ${JSON.stringify(response.error)}`);
  }

  return response.data;
}
```

**3. Client Level** (Lowest layer)
```typescript
// Handled by openapi-fetch middleware
client.use({
  onRequest({ request }) { /* auth */ },
  onResponse({ response }) { /* logging */ }
});
```

### Common Error Scenarios

| Error | Cause | Handler Response |
|-------|-------|------------------|
| 401 Unauthorized | Invalid API key | "Authentication failed. Check TELEMETRY_API_KEY" |
| 403 Forbidden | Missing RBAC permissions | "Insufficient permissions. User needs MetricsViewer role" |
| 404 Not Found | Invalid cluster ID | "Cluster lkc-xxxxx not found" |
| 429 Too Many Requests | Rate limit exceeded | "Rate limit exceeded. Try again in 60 seconds" |
| 500 Internal Server Error | Confluent API issue | "Confluent API error. Please retry" |
| Timeout | Network/API latency | "Request timeout. Reduce time range or retry" |

## Performance Considerations

### Caching Strategy

**Metrics Data** (Time-series)
- Cache TTL: 1-5 minutes (data freshness vs. API limits)
- Key: `${clusterId}:${metric}:${timeRange}`
- Eviction: LRU with max 100 entries

**Resource Metadata** (Clusters, environments)
- Cache TTL: 5-15 minutes (rarely changes)
- Key: `clusters:${environmentId}`
- Eviction: TTL-based

**Consumer Lag**
- Cache TTL: 30 seconds (highly dynamic)
- Key: `lag:${clusterId}:${groupId}`
- Eviction: TTL-based

### API Rate Limiting

| API | Limit | Mitigation |
|-----|-------|------------|
| Telemetry API | 100 req/min | Cache + batch queries |
| Cloud API v2 | 100 req/min | Cache cluster metadata |
| Kafka REST API | 1000 req/min | Batch consumer group queries |

### Optimization Tips

1. **Batch Queries**: Query multiple metrics in single API call
2. **Appropriate Granularity**: Use PT5M or PT15M for long time ranges
3. **Limit Time Ranges**: Don't query more than 7 days at high granularity
4. **Parallel Requests**: Use Promise.all() for independent queries
5. **Selective Metrics**: Only query metrics you need

## Deployment Checklist

- [ ] Environment variables configured
  - [ ] TELEMETRY_API_KEY / TELEMETRY_API_SECRET
  - [ ] KAFKA_API_KEY / KAFKA_API_SECRET (for consumer lag)
  - [ ] SCHEMA_REGISTRY_API_KEY / SCHEMA_REGISTRY_API_SECRET
- [ ] RBAC permissions granted
  - [ ] MetricsViewer role for telemetry
  - [ ] ResourceOwner or Operator for Kafka REST API
- [ ] Tool handlers implemented and registered
- [ ] Tests written and passing
- [ ] Documentation updated
- [ ] Rate limiting strategy in place
- [ ] Error handling tested
- [ ] Performance benchmarked

## Monitoring Your MCP Server

Monitor the MCP server itself for:
- API call latency
- Error rates
- Cache hit ratios
- Rate limit usage

Use structured logging:
```typescript
logger.info({
  tool: "get-cluster-metrics",
  clusterId: "lkc-12345",
  duration: 234,
  cacheHit: false
}, "Metrics query completed");
```
