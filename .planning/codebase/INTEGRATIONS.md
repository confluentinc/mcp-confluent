# External Integrations

**Analysis Date:** 2026-03-11

## APIs & External Services

**Confluent Cloud REST API:**
- Base endpoint: `CONFLUENT_CLOUD_REST_ENDPOINT` (default: `https://api.confluent.cloud`)
- Authentication: Basic auth via `CONFLUENT_CLOUD_API_KEY` and `CONFLUENT_CLOUD_API_SECRET`
- SDK/Client: `openapi-fetch` with types generated from `openapi.json`
- Used for: Environment management, cluster operations, billing queries, connector management, catalog operations

**Flink REST API:**
- Base endpoint: `FLINK_REST_ENDPOINT`
- Authentication: Basic auth via `FLINK_API_KEY` and `FLINK_API_SECRET`
- SDK/Client: `openapi-fetch` with types from `openapi.json`
- Used for: SQL statement management, catalog queries (databases, tables, schemas), diagnostics and health checks, query profiling and metrics

**Schema Registry API:**
- Base endpoint: `SCHEMA_REGISTRY_ENDPOINT`
- Authentication: Basic auth via `SCHEMA_REGISTRY_API_KEY` and `SCHEMA_REGISTRY_API_SECRET`
- SDK/Client: `@confluentinc/schemaregistry` SchemaRegistryClient
- Used for: Schema registration, versioning, validation, compatibility checks

**Kafka REST Proxy API:**
- Base endpoint: `KAFKA_REST_ENDPOINT`
- Authentication: Basic auth via `KAFKA_API_KEY` and `KAFKA_API_SECRET`
- SDK/Client: `openapi-fetch` with types from `openapi.json`
- Used for: REST-based Kafka operations (topics, messages, cluster info)

**Tableflow API:**
- Base endpoint: Derived from Confluent Cloud endpoint
- Authentication: Basic auth via `TABLEFLOW_API_KEY` and `TABLEFLOW_API_SECRET`
- SDK/Client: `openapi-fetch` with types from `openapi.json`
- Used for: Topic and catalog integrations, data governance features (preview)

**Telemetry/Metrics API:**
- Base endpoint: `TELEMETRY_ENDPOINT` (default: `https://api.telemetry.confluent.cloud`)
- Authentication: Basic auth via `TELEMETRY_API_KEY` or `CONFLUENT_CLOUD_API_KEY`
- SDK/Client: `openapi-fetch` with types from `openapi.json`
- Used for: Query metrics, statement diagnostics, performance profiling

## Data Storage

**Kafka Cluster:**
- Connection: Direct TCP/SSL to bootstrap servers
- Bootstrap servers: `BOOTSTRAP_SERVERS` (e.g., `host1:9092,host2:9092`)
- Authentication: SASL/PLAIN (username/password) via `KAFKA_API_KEY` and `KAFKA_API_SECRET`
- Client: `@confluentinc/kafka-javascript` KafkaJS
- Operations: Produce, consume, list topics, manage topic configs, monitor offsets

**Schema Registry:**
- Connection: REST API via `SCHEMA_REGISTRY_ENDPOINT`
- Client: `@confluentinc/schemaregistry` SchemaRegistryClient
- Purpose: Schema storage, validation, compatibility management

**File Storage:**
- Local filesystem only - No external object storage integration

**Caching:**
- None - No external caching layer (Redis, Memcached)

## Authentication & Identity

**Auth Provider:**
- Custom implementation using Basic authentication (Base64-encoded API key:secret)

**Implementation Details:**
- Middleware: `createAuthMiddleware()` in `src/confluent/middleware.ts`
- All REST API calls include `Authorization: Basic [base64(key:secret)]` header
- MCP server supports Bearer token auth for HTTP/SSE transports (optional, can be disabled in dev)
- Auth tokens generated via: `npx @confluentinc/mcp-confluent --generate-key`

**Environment Variables:**
- `CONFLUENT_CLOUD_API_KEY` / `CONFLUENT_CLOUD_API_SECRET`
- `FLINK_API_KEY` / `FLINK_API_SECRET`
- `SCHEMA_REGISTRY_API_KEY` / `SCHEMA_REGISTRY_API_SECRET`
- `KAFKA_API_KEY` / `KAFKA_API_SECRET`
- `TABLEFLOW_API_KEY` / `TABLEFLOW_API_SECRET`
- `TELEMETRY_API_KEY` / `TELEMETRY_API_SECRET`
- `MCP_API_KEY` (for HTTP/SSE transport authentication)

## Monitoring & Observability

**Error Tracking:**
- None - No external error tracking service (Sentry, DataDog)

**Logs:**
- Structured JSON logging via `pino` (v10.1.0)
- Log level configurable: `LOG_LEVEL` env var (trace, debug, info, warn, error, fatal)
- All API interactions logged with request/response details
- Output: stdout (suitable for Docker/container environments)

**Metrics:**
- Flink query profiling metrics via Telemetry API
- Health checks available via Flink diagnostics tools
- No custom metrics export (Prometheus, CloudWatch)

## CI/CD & Deployment

**Hosting:**
- Container-based: Docker (multi-stage build)
- Self-hosted or any container orchestration platform (Kubernetes, Docker Compose)

**CI Pipeline:**
- `.github/workflows/` - GitHub Actions workflows (check directory for specific pipelines)
- `.semaphore/` - Semaphore CI configuration (check directory for specific pipelines)

**Deployment Modes:**
1. Direct Node.js: `npm start`
2. Docker container: `docker build . && docker run ...`
3. Docker Compose: `docker-compose up`

## Environment Configuration

**Required env vars (conditional based on enabled tools):**

**Kafka Integration:**
- `BOOTSTRAP_SERVERS` - Kafka broker addresses
- `KAFKA_API_KEY` - Kafka authentication username
- `KAFKA_API_SECRET` - Kafka authentication password

**Flink Integration:**
- `FLINK_REST_ENDPOINT` - Flink API base URL
- `FLINK_API_KEY` - Flink authentication key
- `FLINK_API_SECRET` - Flink authentication secret
- `FLINK_ENV_ID` - Environment ID (e.g., `env-xyz`)
- `FLINK_ORG_ID` - Organization ID
- `FLINK_ENV_NAME` - Environment name
- `FLINK_DATABASE_NAME` - Default database
- `FLINK_COMPUTE_POOL_ID` - Compute pool ID (e.g., `lfcp-xyz`)

**Schema Registry Integration:**
- `SCHEMA_REGISTRY_ENDPOINT` - Schema Registry API URL
- `SCHEMA_REGISTRY_API_KEY` - Authentication key
- `SCHEMA_REGISTRY_API_SECRET` - Authentication secret

**Confluent Cloud Integration:**
- `CONFLUENT_CLOUD_REST_ENDPOINT` - Cloud API URL (default: `https://api.confluent.cloud`)
- `CONFLUENT_CLOUD_API_KEY` - Authentication key
- `CONFLUENT_CLOUD_API_SECRET` - Authentication secret

**HTTP/SSE Server:**
- `HTTP_PORT` - Server port (default: 8080)
- `HTTP_HOST` - Bind address (default: 127.0.0.1)
- `HTTP_MCP_ENDPOINT_PATH` - MCP endpoint path (default: `/mcp`)
- `SSE_MCP_ENDPOINT_PATH` - SSE connection endpoint (default: `/sse`)
- `SSE_MCP_MESSAGE_ENDPOINT_PATH` - SSE message endpoint (default: `/messages`)
- `MCP_API_KEY` - Bearer token for HTTP/SSE authentication (required if auth not disabled)
- `MCP_AUTH_DISABLED` - Disable auth in development (default: false, WARNING)
- `MCP_ALLOWED_HOSTS` - DNS rebinding protection list (default: `localhost,127.0.0.1`)

**Logging:**
- `LOG_LEVEL` - Application log level (default: `info`)

**Secrets location:**
- `.env` file (not committed, created from `.env.example`)
- Docker Compose: `.env` in same directory as `docker-compose.yml`
- GitHub Actions: Secrets in repository settings or workflow variables
- Environment files for deployment: Kubernetes ConfigMaps/Secrets, environment service configuration

## Client Initialization

**Client Management:**
- Centralized via `DefaultClientManager` in `src/confluent/client-manager.ts`
- Lazy initialization - clients created only when needed
- Session-based isolation (separate consumer groups per sessionId)

**Supported Clients:**

1. **Kafka Client** (`KafkaJS`)
   - Method: `getKafkaClient()`
   - Used by: Kafka handlers
   - Configuration: Global Kafka config with SASL/SSL

2. **Kafka Admin Client** (`KafkaJS.Admin`)
   - Method: `getAdminClient()`
   - Used by: Topic management, config operations
   - Auto-connects on first use

3. **Kafka Producer** (`KafkaJS.Producer`)
   - Method: `getProducer()`
   - Used by: Message publishing
   - Auto-connects on first use

4. **Kafka Consumer** (`KafkaJS.Consumer`)
   - Method: `getConsumer(sessionId?: string)`
   - Used by: Message consumption
   - Auto-connects on first use
   - Supports session isolation (different consumer groups per session)

5. **Schema Registry Client** (`SchemaRegistryClient`)
   - Method: `getSchemaRegistryClient()`
   - Used by: Schema operations
   - Configured with REST endpoint + basic auth

6. **Confluent Cloud REST Clients** (`openapi-fetch` Client)
   - Methods:
     - `getConfluentCloudRestClient()` - General cloud operations
     - `getConfluentCloudFlinkRestClient()` - Flink SQL operations
     - `getConfluentCloudKafkaRestClient()` - Kafka REST operations
     - `getConfluentCloudSchemaRegistryRestClient()` - Schema Registry operations
     - `getConfluentCloudTableflowRestClient()` - Tableflow operations
     - `getConfluentCloudTelemetryRestClient()` - Metrics and diagnostics
   - All configured with base URL + auth middleware

## Webhooks & Callbacks

**Incoming:**
- None - MCP server doesn't expose webhooks

**Outgoing:**
- None - Server doesn't initiate outbound webhooks to external services

**Tool Handler Pattern:**
- Tools are invoked synchronously via MCP protocol
- No background job execution or webhooks to external systems
- All operations are request-response based

---

*Integration audit: 2026-03-11*
