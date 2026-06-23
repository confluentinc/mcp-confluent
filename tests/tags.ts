/**
 * Tags for filtering integration tests.
 *
 * Two axes:
 *
 * - **Tool-group axis** ({@link Tag.KAFKA}, {@link Tag.FLINK}, ...) - matches
 *   handler directories under `src/confluent/tools/handlers/`. Used to scope
 *   per-PR auto-promotions to the handler dir the PR touched.
 * - **Service-config axis** ({@link Tag.REQUIRES_KAFKA_CONFIG}, ...) - matches
 *   the per-service blocks on `MCPServerConfiguration` (`kafka`, `flink`,
 *   etc.). Drives `integration.yml`'s matrix axis: each job provisions one
 *   service config's worth of setup and runs every test tagged with that
 *   service config.
 *
 * Cross-cutting tags: {@link Tag.SMOKE} marks transport-layer tests that
 * don't belong to any tool group; {@link Tag.OAUTH} marks tests that exercise
 * the OAuth flow; {@link Tag.MULTI} marks the multi-connection suite that boots
 * a server holding two connections at once.
 *
 * {@see https://vitest.dev/guide/test-tags}
 */
export enum Tag {
  SMOKE = "@smoke",

  // Tests that work with an OAuth connection
  OAUTH = "@oauth",

  // Multi-connection suite: one server, two connections (CCloud + local CP
  // broker), proving per-connection routing against live infra. Cross-cutting
  // (spans kafka + flink + diagnostics), so it's neither a tool-group nor a
  // service-config tag. Stood up in CI by its own block, which boots the CP
  // docker stack — currently the per-PR `Integration Tests: multi` block in
  // .semaphore/semaphore.yml; a follow-up moves it to the scheduled
  // .semaphore/integration.yml pipeline.
  MULTI = "@multi",

  // Tool-group axis: matches handler directories
  BILLING = "@billing",
  CATALOG = "@catalog",
  CLUSTERS = "@clusters",
  CONNECT = "@connect",
  DOCS = "@docs",
  ENVIRONMENTS = "@environments",
  FLINK = "@flink",
  KAFKA = "@kafka",
  METRICS = "@metrics",
  ORGANIZATIONS = "@organizations",
  SCHEMA = "@schema",
  SEARCH = "@search",
  TABLEFLOW = "@tableflow",

  // Service-config axis: drives integration.yml's matrix axis. Each value
  // matches a service block on MCPServerConfiguration (see
  // src/config/models.ts).
  REQUIRES_KAFKA_CONFIG = "@requires-kafka-config",
  REQUIRES_SCHEMA_REGISTRY_CONFIG = "@requires-schema-registry-config",
  REQUIRES_CONFLUENT_CLOUD_CONFIG = "@requires-confluent-cloud-config",
  REQUIRES_FLINK_CONFIG = "@requires-flink-config",
  REQUIRES_TABLEFLOW_CONFIG = "@requires-tableflow-config",
  REQUIRES_TELEMETRY_CONFIG = "@requires-telemetry-config",

  // Self-managed Confluent Platform (local CP stack via docker-compose.cp-test.yml)
  CP = "@cp",
}
