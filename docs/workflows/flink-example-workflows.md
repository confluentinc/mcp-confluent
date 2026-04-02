# Flink Example Workflows

Examples of how the Flink tools (see [Available Tools](../../README.md#available-tools)) work together in practice.

#### Deduplication Workflow

```
User: "I want to deduplicate events from my_topic"
        ↓
Claude: Uses describe-flink-table → gets schema (event_id, user_id, ...)
        ↓
Claude: "Which field should I deduplicate on?"
        ↓
User: "event_id"
        ↓
Claude: Generates SQL using ROW_NUMBER() pattern
        ↓
Claude: Uses create-flink-statement → submits query
        ↓
Claude: Uses check-flink-statement-health → monitors status
        ↓
Claude: "Running successfully!"
```

#### Debugging a Failed Statement

```
User: "My statement xyz is failing. What's wrong?"
        ↓
Claude: Uses get-flink-statement-exceptions → gets error details
        ↓
Claude: Uses detect-flink-statement-issues → analyzes status, exceptions, metrics
        ↓
Claude: Uses get-flink-statement-profile → gets task-level metrics
        ↓
Claude: "The statement has high backpressure on task 'Sink'. Try increasing parallelism..."
```
