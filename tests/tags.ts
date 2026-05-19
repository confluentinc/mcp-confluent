/**
 * Tags for filtering integration tests. Tool-group tags map 1:1 to
 * directories under `src/confluent/tools/handlers/`; `SMOKE` and `OAUTH`
 * are cross-cutting tags. `SMOKE` marks transport-layer tests (e.g. the
 * auth middleware) that don't belong to any tool group. `OAUTH` marks
 * tests that can run against an OAuth connection via the harness's
 * `oauth: true` opt-in.
 * {@see https://vitest.dev/guide/test-tags}
 */
export enum Tag {
  SMOKE = "@smoke",

  // Tests that work with an OAuth connection
  OAUTH = "@oauth",

  // Tool group specific tags, matching handler directories
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
}
