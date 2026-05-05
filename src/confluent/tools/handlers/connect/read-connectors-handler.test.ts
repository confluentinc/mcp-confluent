import { ReadConnectorHandler } from "@src/confluent/tools/handlers/connect/read-connectors-handler.js";
import {
  DEFAULT_CONNECTION_ID,
  HandleCaseWithConn,
  runtimeWith,
} from "@tests/factories/runtime.js";
import { assertHandleCase, stubClientGetters } from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

const CONNECT_CONN = {
  kafka: {
    env_id: "env-from-config",
    cluster_id: "lkc-from-config",
  },
};

const MINIMAL_ARGS = { connectorName: "my-connector" };

type ReadCase = HandleCaseWithConn & {
  expectedPathParams?: {
    environment_id: string;
    kafka_cluster_id: string;
    connector_name: string;
  };
};

const cases: ReadCase[] = [
  {
    label:
      "should throw when environment_id is absent from both arg and config",
    connectionConfig: { kafka: { cluster_id: "lkc-from-config" } },
    args: MINIMAL_ARGS,
    outcome: { throws: "Environment ID is required" },
  },
  {
    label:
      "should throw when kafka_cluster_id is absent from both arg and config",
    connectionConfig: { kafka: { env_id: "env-from-config" } },
    args: MINIMAL_ARGS,
    outcome: { throws: "Kafka Cluster ID is required" },
  },
  {
    label:
      "should resolve env_id and cluster_id from config when args are absent",
    connectionConfig: CONNECT_CONN,
    args: MINIMAL_ARGS,
    outcome: { resolves: "Connector Details for my-connector:" },
    expectedPathParams: {
      environment_id: "env-from-config",
      kafka_cluster_id: "lkc-from-config",
      connector_name: "my-connector",
    },
  },
  {
    label: "should prefer explicit args over config values",
    connectionConfig: CONNECT_CONN,
    args: {
      ...MINIMAL_ARGS,
      environmentId: "env-from-arg",
      clusterId: "lkc-from-arg",
    },
    outcome: { resolves: "Connector Details for my-connector:" },
    expectedPathParams: {
      environment_id: "env-from-arg",
      kafka_cluster_id: "lkc-from-arg",
      connector_name: "my-connector",
    },
  },
];

describe("read-connectors-handler.ts", () => {
  describe("ReadConnectorHandler", () => {
    const handler = new ReadConnectorHandler();

    describe("handle()", () => {
      it.each(cases)("$label", async (tc) => {
        const { clientManager, clientGetters, capturedCalls } =
          stubClientGetters({ name: "my-connector", config: {} });
        await assertHandleCase({
          handler,
          runtime: runtimeWith(
            tc.connectionConfig ?? CONNECT_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: tc.args,
          outcome: tc.outcome,
          ...(typeof tc.outcome === "object" && "resolves" in tc.outcome
            ? { clientGetters }
            : {}),
        });
        if (tc.expectedPathParams) {
          expect(capturedCalls).toHaveLength(1);
          expect(capturedCalls[0]!.args).toMatchObject({
            params: expect.objectContaining({
              path: expect.objectContaining(tc.expectedPathParams),
            }),
          });
        }
      });
    });
  });
});
