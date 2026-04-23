/**
 * Tags mapping to individual directories under `src/confluent/tools/handlers/` to allow running
 * tests for specific tool groups.
 * {@see https://vitest.dev/guide/test-tags}
 */
export enum Tag {
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
