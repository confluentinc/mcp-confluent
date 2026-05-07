import {
  resolveKafkaBootstrap,
  resolveSchemaRegistryEndpoint,
} from "@src/confluent/oauth-resource-resolvers.js";
import type { paths } from "@src/confluent/openapi-schema.js";
import type { Client } from "openapi-fetch";
import { describe, expect, it, vi } from "vitest";

type CloudClient = Client<paths, `${string}/${string}`>;

function makeStubClient(
  responses: Record<string, { data?: unknown; error?: unknown }>,
): CloudClient {
  return {
    GET: vi.fn(
      async (path: string, opts?: { params?: { path?: { id?: string } } }) => {
        const id = opts?.params?.path?.id ?? "";
        const key = `${path}:${id}`;
        return responses[key] ?? { error: { message: `unhandled ${key}` } };
      },
    ),
  } as unknown as CloudClient;
}

describe("resolveKafkaBootstrap", () => {
  it("returns spec.kafka_bootstrap_endpoint on success", async () => {
    const client = makeStubClient({
      "/cmk/v2/clusters/{id}:lkc-abc": {
        data: {
          spec: {
            kafka_bootstrap_endpoint:
              "lkc-abc.us-east-1.aws.confluent.cloud:9092",
          },
        },
      },
    });
    expect(await resolveKafkaBootstrap(client, "lkc-abc", "env-1")).toBe(
      "lkc-abc.us-east-1.aws.confluent.cloud:9092",
    );
  });

  it("throws with cluster + env in message on 404", async () => {
    const client = makeStubClient({
      "/cmk/v2/clusters/{id}:lkc-x": {
        error: { message: "not found", status: 404 },
      },
    });
    await expect(
      resolveKafkaBootstrap(client, "lkc-x", "env-9"),
    ).rejects.toThrow(/lkc-x.*env-9/);
  });

  it("throws when response is missing kafka_bootstrap_endpoint", async () => {
    const client = makeStubClient({
      "/cmk/v2/clusters/{id}:lkc-no-bootstrap": { data: { spec: {} } },
    });
    await expect(
      resolveKafkaBootstrap(client, "lkc-no-bootstrap", "env-1"),
    ).rejects.toThrow(/kafka_bootstrap_endpoint/);
  });
});

describe("resolveSchemaRegistryEndpoint", () => {
  it("returns spec.http_endpoint on success", async () => {
    const client = makeStubClient({
      "/srcm/v3/clusters/{id}:lsrc-abc": {
        data: {
          spec: {
            http_endpoint: "https://psrc-abc.us-central1.gcp.confluent.cloud",
          },
        },
      },
    });
    expect(
      await resolveSchemaRegistryEndpoint(client, "lsrc-abc", "env-1"),
    ).toBe("https://psrc-abc.us-central1.gcp.confluent.cloud");
  });

  it("throws with cluster + env in message on 404", async () => {
    const client = makeStubClient({
      "/srcm/v3/clusters/{id}:lsrc-x": {
        error: { message: "not found", status: 404 },
      },
    });
    await expect(
      resolveSchemaRegistryEndpoint(client, "lsrc-x", "env-9"),
    ).rejects.toThrow(/lsrc-x.*env-9/);
  });

  it("throws when response is missing http_endpoint", async () => {
    const client = makeStubClient({
      "/srcm/v3/clusters/{id}:lsrc-no-endpoint": { data: { spec: {} } },
    });
    await expect(
      resolveSchemaRegistryEndpoint(client, "lsrc-no-endpoint", "env-1"),
    ).rejects.toThrow(/http_endpoint/);
  });
});
