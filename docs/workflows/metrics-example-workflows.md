# Metrics Example Workflows

The `list-available-metrics` and `query-metrics` tools work together to let AI assistants monitor your Confluent Cloud resources. The discovery tool ensures the assistant uses valid metric names and filter fields rather than guessing.

#### Kafka Topic Throughput

```
User: "What's the throughput on topic sensor-readings over the last hour?"
        ↓
Claude: Uses list-available-metrics(resource_type: "kafka") → discovers metric names & filters
        ↓
Claude: Uses query-metrics(metric: "io.confluent.kafka.server/received_bytes",
        filter: {"metric.topic": "sensor-readings"}) → gets time-series data
        ↓
Claude: "sensor-readings is receiving ~14.3 KB/min steadily over the last hour."
```

#### Flink Compute Pool Utilization

```
User: "How many CFUs is my Flink compute pool using?"
        ↓
Claude: Uses list-available-metrics(resource_type: "compute_pool") → discovers CFU metrics
        ↓
Claude: Uses query-metrics(metric: "io.confluent.flink/compute_pool_utilization/current_cfus",
        filter: {"resource.compute_pool.id": "lfcp-..."}, granularity: "PT1H",
        interval: "<7-day range>") → gets usage trend
        ↓
Claude: "Your compute pool is using 1 CFU consistently."
```

#### Consumer Lag Monitoring

```
User: "Is there any consumer lag on the sensor-readings topic?"
        ↓
Claude: Uses query-metrics(metric: "io.confluent.kafka.server/consumer_lag_offsets",
        filter: {"metric.topic": "sensor-readings"},
        group_by: ["metric.consumer_group_id"]) → gets lag per consumer group
        ↓
Claude: "Consumer group 'analytics' has 1,200 offsets of lag."
```

> **Note:** Kafka server metrics (e.g., `io.confluent.kafka.server/received_bytes`) require `CONFLUENT_CLOUD_API_KEY` and `CONFLUENT_CLOUD_API_SECRET`. The `KAFKA_CLUSTER_ID` environment variable is auto-injected as a filter when querying Kafka metrics. Flink compute pool metrics report at hourly granularity, so queries may need a wider time window than the default 1 hour.
