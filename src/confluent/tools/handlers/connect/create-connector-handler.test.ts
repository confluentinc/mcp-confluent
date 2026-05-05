import { CreateConnectorHandler } from "@src/confluent/tools/handlers/connect/create-connector-handler.js";
import {
  bareRuntime,
  confluentCloudRuntime,
  DEFAULT_CONNECTION_ID,
  runtimeWith,
} from "@tests/factories/runtime.js";
import { assertHandleCase, stubClientGetters } from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

const WITH_KAFKA_AUTH = {
  kafka: {
    auth: {
      type: "api_key" as const,
      key: "api-key-from-config",
      secret: "api-secret-from-config",
    },
    env_id: "env-from-config",
    cluster_id: "lkc-from-config",
  },
};

const MINIMAL_ARGS = {
  connectorName: "my-connector",
  environmentId: "env-from-arg",
  clusterId: "lkc-from-arg",
  connectorConfig: { "connector.class": "BigQuerySink" },
};

describe("create-connector-handler.ts", () => {
  describe("CreateConnectorHandler", () => {
    const handler = new CreateConnectorHandler();

    describe("enabledConnectionIds()", () => {
      it("should return the connection ID for a connection with confluent_cloud and kafka.auth", () => {
        const runtime = runtimeWith({
          confluent_cloud: {
            endpoint: "https://api.confluent.cloud",
            auth: { type: "api_key", key: "k", secret: "s" },
          },
          kafka: { auth: { type: "api_key", key: "k", secret: "s" } },
        });
        expect(handler.enabledConnectionIds(runtime)).toEqual([
          DEFAULT_CONNECTION_ID,
        ]);
      });

      it("should return an empty array for a connection without a kafka block", () => {
        expect(handler.enabledConnectionIds(bareRuntime())).toEqual([]);
      });

      it("should return an empty array for a connection with confluent_cloud but no kafka.auth", () => {
        expect(handler.enabledConnectionIds(confluentCloudRuntime())).toEqual(
          [],
        );
      });
    });

    describe("handle()", () => {
      it("should forward credentials from conn kafka.auth in the POST body", async () => {
        const { clientManager, clientGetters, capturedCalls } =
          stubClientGetters({});
        await assertHandleCase({
          handler,
          runtime: runtimeWith(
            WITH_KAFKA_AUTH,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: MINIMAL_ARGS,
          outcome: { resolves: "my-connector created:" },
          clientGetters,
        });
        expect(capturedCalls).toHaveLength(1);
        expect(capturedCalls[0]!.args).toMatchObject({
          body: expect.objectContaining({
            config: expect.objectContaining({
              "kafka.api.key": "api-key-from-config",
              "kafka.api.secret": "api-secret-from-config",
            }),
          }),
        });
      });

      it("should throw when conn kafka.auth is absent", async () => {
        const { clientManager } = stubClientGetters({});
        await assertHandleCase({
          handler,
          runtime: runtimeWith(
            { kafka: {} },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: MINIMAL_ARGS,
          outcome: { throws: "Kafka API Key is required" },
        });
      });

      it("should prefer explicit environmentId and clusterId args over conn config values", async () => {
        const { clientManager, clientGetters, capturedCalls } =
          stubClientGetters({});
        await assertHandleCase({
          handler,
          runtime: runtimeWith(
            WITH_KAFKA_AUTH,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: MINIMAL_ARGS,
          outcome: { resolves: "my-connector created:" },
          clientGetters,
        });
        expect(capturedCalls).toHaveLength(1);
        expect(capturedCalls[0]!.args).toMatchObject({
          params: expect.objectContaining({
            path: expect.objectContaining({
              environment_id: "env-from-arg",
              kafka_cluster_id: "lkc-from-arg",
            }),
          }),
        });
      });
    });
  });
});
