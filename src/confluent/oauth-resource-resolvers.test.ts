import {
  resolveKafkaBootstrap,
  resolveKafkaRestEndpoint,
  resolveSchemaRegistryClusterId,
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
      async (
        path: string,
        opts?: {
          params?: {
            path?: { id?: string };
            query?: { environment?: string };
          };
        },
      ) => {
        const id =
          opts?.params?.path?.id ?? opts?.params?.query?.environment ?? "";
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

describe("resolveKafkaRestEndpoint", () => {
  it("returns spec.http_endpoint on success", async () => {
    const client = makeStubClient({
      "/cmk/v2/clusters/{id}:lkc-abc": {
        data: {
          spec: {
            http_endpoint: "https://pkc-abc.us-east-1.aws.confluent.cloud:443",
          },
        },
      },
    });
    expect(await resolveKafkaRestEndpoint(client, "lkc-abc", "env-1")).toBe(
      "https://pkc-abc.us-east-1.aws.confluent.cloud:443",
    );
  });

  it("throws with cluster + env in message on 404", async () => {
    const client = makeStubClient({
      "/cmk/v2/clusters/{id}:lkc-x": {
        error: { message: "not found", status: 404 },
      },
    });
    await expect(
      resolveKafkaRestEndpoint(client, "lkc-x", "env-9"),
    ).rejects.toThrow(/lkc-x.*env-9/);
  });

  it("throws when response is missing http_endpoint", async () => {
    const client = makeStubClient({
      "/cmk/v2/clusters/{id}:lkc-no-http": { data: { spec: {} } },
    });
    await expect(
      resolveKafkaRestEndpoint(client, "lkc-no-http", "env-1"),
    ).rejects.toThrow(/http_endpoint/);
  });
});

describe("resolveSchemaRegistryClusterId", () => {
  it("returns the SR cluster's lsrc-id when exactly one SR is registered in the environment", async () => {
    const client = makeStubClient({
      "/srcm/v3/clusters:env-1": {
        data: { data: [{ id: "lsrc-abc" }] },
      },
    });
    expect(await resolveSchemaRegistryClusterId(client, "env-1")).toBe(
      "lsrc-abc",
    );
  });

  it("throws when no SR cluster is registered in the environment", async () => {
    const client = makeStubClient({
      "/srcm/v3/clusters:env-empty": {
        data: { data: [] },
      },
    });
    await expect(
      resolveSchemaRegistryClusterId(client, "env-empty"),
    ).rejects.toThrow(/env-empty/);
    await expect(
      resolveSchemaRegistryClusterId(client, "env-empty"),
    ).rejects.toThrow(/No Schema Registry cluster/);
  });

  it("throws when multiple SR clusters are registered in the environment", async () => {
    // Defense-in-depth: CCloud's documented invariant is one SR per env, but
    // if that ever changes we want to fail loud rather than silently pick
    // data[0] and bake the wrong target-sr-cluster header into requests.
    const client = makeStubClient({
      "/srcm/v3/clusters:env-multi": {
        data: { data: [{ id: "lsrc-a" }, { id: "lsrc-b" }] },
      },
    });
    await expect(
      resolveSchemaRegistryClusterId(client, "env-multi"),
    ).rejects.toThrow(/env-multi/);
    await expect(
      resolveSchemaRegistryClusterId(client, "env-multi"),
    ).rejects.toThrow(/Multiple Schema Registry clusters/);
  });

  it("surfaces the REST error payload when /srcm/v3/clusters fails", async () => {
    const client = makeStubClient({
      "/srcm/v3/clusters:env-broken": {
        error: { message: "internal server error", status: 500 },
      },
    });
    await expect(
      resolveSchemaRegistryClusterId(client, "env-broken"),
    ).rejects.toThrow(/internal server error/);
    await expect(
      resolveSchemaRegistryClusterId(client, "env-broken"),
    ).rejects.toThrow(/env-broken/);
  });
});
