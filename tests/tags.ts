/**
 * Tags for filtering integration tests. Tool-group tags map 1:1 to
 * directories under `src/confluent/tools/handlers/`; `SMOKE` is a
 * cross-cutting tag for transport-layer tests (e.g. the auth middleware)
 * that don't belong to any tool group.
 * {@see https://vitest.dev/guide/test-tags}
 */
export enum Tag {
  SMOKE = "@smoke",

  // Tool group specific tags, matching handler directories
  BILLING = "@billing",
  CATALOG = "@catalog",
  CLUSTERS = "@clusters",
  CONNECT = "@connect",
  ENVIRONMENTS = "@environments",
  FLINK = "@flink",
  KAFKA = "@kafka",
  METRICS = "@metrics",
  SCHEMA = "@schema",
  SEARCH = "@search",
  TABLEFLOW = "@tableflow",
}
