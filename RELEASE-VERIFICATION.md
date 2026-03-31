# Release Verification Test Cases

## Running the Automated Integration Tests

The test cases below (1-43) are implemented as automated integration tests
in `tests/integration/`. They call each MCP tool via the protocol and
cross-check results against the Confluent Cloud REST API.

### Setup

1. **Build the project:**

   ```bash
   npm run build
   ```

2. **Create an `.env.integration` file** (or copy from the example):

   ```bash
   cp .env.integration.example .env.integration
   ```

   Fill in the credentials for a **dedicated dev/staging environment**.
   The tests create and delete real resources (topics, schemas, tags).

   | Variable group | Required for |
   |---|---|
   | `BOOTSTRAP_SERVERS`, `KAFKA_API_KEY`, `KAFKA_API_SECRET`, `KAFKA_REST_ENDPOINT`, `KAFKA_CLUSTER_ID` | Kafka tests (1-21), Schema Registry tests (16-30) |
   | `SCHEMA_REGISTRY_ENDPOINT`, `SCHEMA_REGISTRY_API_KEY`, `SCHEMA_REGISTRY_API_SECRET` | Kafka tests (1-21), Schema Registry tests (16-30), Catalog/Search tests (37-43) |
   | `CONFLUENT_CLOUD_API_KEY`, `CONFLUENT_CLOUD_API_SECRET` | Cloud infra tests (31-34), Connect tests (35-36) |
   | `KAFKA_ENV_ID` | Connect tests (35-36), Catalog tests (37-43) |

   If env vars for a group are missing, those test suites will skip
   with an error message indicating which variables are needed.

3. **Run the tests:**

   ```bash
   # Run all integration tests
   npm run test:integration

   # Run only Kafka tests
   npm run test:integration:kafka

   # Run only Schema Registry tests
   npm run test:integration:schema

   # Run only Cloud/Connect/Catalog/Search tests
   npm run test:integration:cloud
   ```

### What the tests do

- Each test run generates a **unique prefix** (`inttest-<timestamp>`) for all
  resource names, so parallel runs don't collide.
- Tests clean up after themselves in `afterAll` hooks (topics, schemas, tags).
- Tool calls go through the full MCP protocol (in-memory transport), exactly
  as a real client would invoke them.
- Verification calls hit the Confluent Cloud REST API directly using `fetch`
  with basic auth, providing an independent check.

### Test file layout

```
tests/integration/
  setup.ts                              # Shared helpers, client setup, REST utils
  kafka.integration.test.ts             # Tests 1-21
  schema-registry.integration.test.ts   # Tests 22-30
  cloud.integration.test.ts             # Tests 31-43
```

---

## Test Case Reference

### 1. Kafka Tools (Priority: HIGH)

#### 1.1 Topic Lifecycle

| # | Test Case | Tool | Input | Expected Result |
|---|-----------|------|-------|-----------------|
| 1 | List topics (baseline) | `list-topics` | _(none)_ | Returns current topic list without error |
| 2 | Create a single topic | `create-topics` | `topicNames: ["<prefix>-single"]` | Topic created successfully |
| 3 | Create multiple topics | `create-topics` | `topicNames: ["<prefix>-a", "<prefix>-b"]` | Both topics created |
| 4 | Create duplicate topic | `create-topics` | `topicNames: ["<prefix>-single"]` | Graceful error or idempotent success |
| 5 | List topics (verify) | `list-topics` | _(none)_ | New topics appear in list |
| 6 | Delete a single topic | `delete-topics` | `topicNames: ["<prefix>-single"]` | Topic deleted |
| 7 | Delete multiple topics | `delete-topics` | `topicNames: ["<prefix>-a", "<prefix>-b"]` | Both deleted |
| 8 | Delete non-existent topic | `delete-topics` | `topicNames: ["<prefix>-nonexistent"]` | Graceful error message |

#### 1.2 Topic Configuration (Cloud only)

| # | Test Case | Tool | Input | Expected Result |
|---|-----------|------|-------|-----------------|
| 9 | Get topic config | `get-topic-config` | `topicName: "<prefix>-config"` | Returns retention, cleanup policy, etc. |
| 10 | Alter topic config | `alter-topic-config` | `topicName: "<prefix>-config"`, `topicConfigs: [{name: "retention.ms", value: "86400000", operation: "SET"}]` | Config updated |
| 11 | Verify altered config | `get-topic-config` | `topicName: "<prefix>-config"` | Shows updated retention.ms = 86400000 |

#### 1.3 Produce & Consume (plain, no Schema Registry)

| # | Test Case | Tool | Input | Expected Result |
|---|-----------|------|-------|-----------------|
| 12 | Produce with key+value | `produce-message` | `topicName: "<prefix>-produce"`, `key: {message: "k1"}`, `value: {message: '{"hello":"world"}'}` | Message produced, offset returned |
| 13 | Produce value only | `produce-message` | `topicName: "<prefix>-produce"`, `value: {message: "plain text"}` | Message produced |
| 14 | Consume messages | `consume-messages` | `topicNames: ["<prefix>-produce"]`, `maxMessages: 10` | Returns the 2 produced messages |
| 15 | Consume from empty topic | `consume-messages` | `topicNames: ["<prefix>-empty"]`, `maxMessages: 5`, `timeoutMs: 5000` | Returns 0 messages, no crash |

#### 1.4 Produce & Consume with Schema Registry

| # | Test Case | Tool | Input | Expected Result |
|---|-----------|------|-------|-----------------|
| 16 | Produce AVRO message | `produce-message` | AVRO schema + `{name, age}` | Produced, schema registered |
| 17 | Produce JSON Schema message | `produce-message` | JSON schema + `{name}` | Produced with JSON schema |
| 18 | Produce PROTOBUF message | `produce-message` | Proto schema + `{name}` | Produced with protobuf schema |
| 19 | Consume AVRO messages | `consume-messages` | `useSchemaRegistry: true` | Auto-deserialized AVRO records |
| 20 | Consume JSON Schema messages | `consume-messages` | `useSchemaRegistry: true` | Auto-deserialized JSON records |
| 21 | Consume from multiple topics | `consume-messages` | AVRO + JSON topics | Messages from both topics |

---

### 2. Schema Registry Tools (Priority: HIGH)

| # | Test Case | Tool | Input | Expected Result |
|---|-----------|------|-------|-----------------|
| 22 | List schemas (latest only) | `list-schemas` | `latestOnly: true` | Returns latest schema versions |
| 23 | List all schema versions | `list-schemas` | `latestOnly: false` | Returns all versions |
| 24 | List with subject prefix | `list-schemas` | `subjectPrefix: "<prefix>"` | Filtered to test subjects |
| 25 | Verify schemas from produce | `list-schemas` | `subjectPrefix: "<prefix>-sr-test"` | Shows AVRO schema |
| 26 | Soft delete schema | `delete-schema` | `subject: "<prefix>-value"`, `permanent: false` | Schema soft-deleted |
| 27 | Delete specific version | `delete-schema` | `subject: "<prefix>-value"`, `version: "latest"` | Latest version deleted |
| 28 | List including deleted | `list-schemas` | `latestOnly: false`, `deleted: true` | Call succeeds |
| 29 | Permanent delete schema | `delete-schema` | `subject: "<prefix>-value"`, `permanent: true` | Schema permanently removed |
| 30 | Delete non-existent subject | `delete-schema` | `subject: "<prefix>-no-such"` | Returns error |

---

### 3. Cloud Infrastructure Tools

| # | Test Case | Tool | Input | Expected Result |
|---|-----------|------|-------|-----------------|
| 31 | List environments | `list-environments` | _(none)_ | Returns environment list |
| 32 | Read specific environment | `read-environment` | `environmentId: "<from #31>"` | Returns env details |
| 33 | List clusters | `list-clusters` | _(none)_ | Returns cluster list |
| 34 | List billing costs | `list-billing-costs` | `startDate/endDate` | Returns cost data |

---

### 4. Kafka Connect Tools

| # | Test Case | Tool | Input | Expected Result |
|---|-----------|------|-------|-----------------|
| 35 | List connectors | `list-connectors` | _(none)_ | Returns connector names |
| 36 | Read connector details | `read-connector` | `connectorName: "<from #35>"` | Returns config and status |

---

### 5. Catalog & Tagging Tools

| # | Test Case | Tool | Input | Expected Result |
|---|-----------|------|-------|-----------------|
| 37 | List tags | `list-tags` | _(none)_ | Returns tag definitions |
| 38 | Create a tag | `create-topic-tags` | `tags: [{tagName: "<unique>"}]` | Tag created |
| 39 | Add tag to topic | `add-tags-to-topic` | `entityName: "<qualified>"`, `typeName: "<tag>"` | Tag assigned |
| 40 | Search topics by tag | `search-topics-by-tag` | `topicTag: "<tag>"` | Returns tagged topic |
| 41 | Search topics by name | `search-topics-by-name` | `topicName: "<prefix>"` | Returns matching topics |
| 42 | Remove tag from topic | `remove-tag-from-entity` | `tagName, qualifiedName` | Tag removed |
| 43 | Delete tag | `delete-tag` | `tagName: "<tag>"` | Tag definition deleted |

---

### 6. Flink SQL Tools (manual)

| # | Test Case | Tool | Input | Expected Result |
|---|-----------|------|-------|-----------------|
| 44 | List catalogs | `list-flink-catalogs` | _(none)_ | Returns available catalogs |
| 45 | List databases | `list-flink-databases` | _(none)_ | Returns databases |
| 46 | List tables | `list-flink-tables` | _(none)_ | Returns tables |
| 47 | Describe table | `describe-flink-table` | `tableName: "<table from #46>"` | Returns column schema |
| 48 | Create statement | `create-flink-statement` | `statement: "SELECT 1"`, `statementName: "release-test-stmt"` | Statement created |
| 49 | Read statement result | `read-flink-statement` | `statementName: "release-test-stmt"` | Returns result with value `1` |
| 50 | List statements | `list-flink-statements` | _(none)_ | Shows release-test-stmt |
| 51 | Get exceptions | `get-flink-statement-exceptions` | `statementName: "release-test-stmt"` | Returns empty or exception list |
| 52 | Check health | `check-flink-statement-health` | `statementName: "release-test-stmt"` | Returns healthy status |
| 53 | Delete statement | `delete-flink-statements` | `statementName: "release-test-stmt"` | Statement deleted |

---

### 7. Tableflow Tools (manual)

| # | Test Case | Tool | Input | Expected Result |
|---|-----------|------|-------|-----------------|
| 54 | List regions | `list-tableflow-regions` | _(none)_ | Returns available regions |
| 55 | List topics | `list-tableflow-topics` | _(none)_ | Returns tableflow topics |
| 56 | List catalog integrations | `list-tableflow-catalog-integrations` | _(none)_ | Returns integrations list |

---

## Cleanup

Automated tests clean up after themselves via `afterAll` hooks.
For manual Flink/Tableflow tests, remove:

- [ ] Flink statements: `release-test-stmt`
