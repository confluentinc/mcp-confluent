import type { ConnectionConfig } from "@src/config/models.js";
import {
  directConnectionSchema,
  oauthConnectionSchema,
} from "@src/config/models.js";
import {
  buildConnectionCard,
  CONFLUENT_CLOUD_FIELD_VISIBILITY,
  DIRECT_CONNECTION_FIELD_VISIBILITY,
  FLINK_FIELD_VISIBILITY,
  KAFKA_FIELD_VISIBILITY,
  OAUTH_CONNECTION_FIELD_VISIBILITY,
  SCHEMA_REGISTRY_FIELD_VISIBILITY,
  SERVICE_BLOCK_VISIBILITY,
  TABLEFLOW_FIELD_VISIBILITY,
  TELEMETRY_FIELD_VISIBILITY,
  type FieldVisibility,
} from "@src/confluent/tools/handlers/diagnostics/describe-fields.js";
import { describe, expect, it } from "vitest";

/**
 * Sentinel secret value planted in every `auth` block of the test fixtures.
 * The leak guard asserts this string never appears anywhere in a built card,
 * proving no credential value escaped the visibility allow-list.
 */
const SECRET_SENTINEL = "sekret-must-never-surface";

const AUTH = {
  type: "api_key" as const,
  key: "key-must-never-surface",
  secret: SECRET_SENTINEL,
};

/** Direct connection with every block present and every field populated. */
const FULL_DIRECT: ConnectionConfig = {
  type: "direct",
  description: "Prod east",
  read_only: true,
  kafka: {
    bootstrap_servers: "broker:9092",
    rest_endpoint: "https://kafka-rest.example.com",
    cluster_id: "lkc-1",
    env_id: "env-1",
    auth: AUTH,
    extra_properties: { "client.id": "x" },
  },
  schema_registry: { endpoint: "https://sr.example.com", auth: AUTH },
  confluent_cloud: {
    endpoint: "https://api.confluent.cloud",
    organization_id: "org-1",
    auth: AUTH,
  },
  tableflow: { auth: AUTH },
  telemetry: { endpoint: "https://telemetry.example.com", auth: AUTH },
  flink: {
    endpoint: "https://flink.example.com",
    environment_id: "env-1",
    organization_id: "org-1",
    compute_pool_id: "lfcp-1",
    catalog_name: "cat",
    database_name: "db",
    auth: AUTH,
  },
};

const FULL_OAUTH: ConnectionConfig = {
  type: "oauth",
  description: "Prod via OAuth",
  read_only: false,
  ccloud_env: "stag",
  kafka_debug: "security,broker",
};

/** Every visibility map, keyed by a human label for diagnostic test output. */
const ALL_MAPS: Record<string, Readonly<Record<string, FieldVisibility>>> = {
  kafka: KAFKA_FIELD_VISIBILITY,
  schema_registry: SCHEMA_REGISTRY_FIELD_VISIBILITY,
  confluent_cloud: CONFLUENT_CLOUD_FIELD_VISIBILITY,
  tableflow: TABLEFLOW_FIELD_VISIBILITY,
  telemetry: TELEMETRY_FIELD_VISIBILITY,
  flink: FLINK_FIELD_VISIBILITY,
  "direct connection": DIRECT_CONNECTION_FIELD_VISIBILITY,
  "oauth connection": OAUTH_CONNECTION_FIELD_VISIBILITY,
};

/** Narrows a value to a Zod object exposing a `shape` record. */
function hasShape(value: unknown): value is { shape: Record<string, unknown> } {
  return (
    typeof value === "object" &&
    value !== null &&
    "shape" in value &&
    typeof (value as { shape: unknown }).shape === "object"
  );
}

/** Narrows a value to a wrapper schema (ZodOptional/effects) exposing `unwrap()`. */
function isUnwrappable(value: unknown): value is { unwrap: () => unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "unwrap" in value &&
    typeof (value as { unwrap: unknown }).unwrap === "function"
  );
}

/**
 * The Zod field schemas for the six direct-connection service blocks,
 * each unwrapped from its `.optional()` (and, where present, `.refine()`)
 * wrapper down to the underlying object so `.shape` is reachable. Kept fully
 * typed (no `any`) so a Zod-shape change that breaks the unwrap fails loudly
 * here rather than slipping past the drift check it backs.
 */
function blockSchemaShapeKeys(blockKey: string): string[] {
  // ZodOptional exposes `.unwrap()` but no `.shape`; refined objects expose
  // `.shape`. Peel optionals/effects until the object shape surfaces.
  let schema: unknown = (
    directConnectionSchema.shape as Record<string, unknown>
  )[blockKey];
  while (!hasShape(schema) && isUnwrappable(schema)) {
    schema = schema.unwrap();
  }
  if (!hasShape(schema)) {
    throw new Error(
      `Wacky -- could not resolve a Zod object shape for block "${blockKey}"`,
    );
  }
  return Object.keys(schema.shape);
}

describe("describe-fields", () => {
  describe("visibility-map drift catch (runtime belt to the compile-time Record)", () => {
    it.each([
      ["kafka", KAFKA_FIELD_VISIBILITY],
      ["schema_registry", SCHEMA_REGISTRY_FIELD_VISIBILITY],
      ["confluent_cloud", CONFLUENT_CLOUD_FIELD_VISIBILITY],
      ["tableflow", TABLEFLOW_FIELD_VISIBILITY],
      ["telemetry", TELEMETRY_FIELD_VISIBILITY],
      ["flink", FLINK_FIELD_VISIBILITY],
    ] as const)(
      "%s visibility map classifies exactly the schema block's fields",
      (blockKey, map) => {
        expect(new Set(Object.keys(map))).toEqual(
          new Set(blockSchemaShapeKeys(blockKey)),
        );
      },
    );

    it("direct-connection map classifies exactly the schema's fields", () => {
      expect(new Set(Object.keys(DIRECT_CONNECTION_FIELD_VISIBILITY))).toEqual(
        new Set(Object.keys(directConnectionSchema.shape)),
      );
    });

    it("oauth-connection map classifies exactly the schema's fields", () => {
      expect(new Set(Object.keys(OAUTH_CONNECTION_FIELD_VISIBILITY))).toEqual(
        new Set(Object.keys(oauthConnectionSchema.shape)),
      );
    });

    it("provides a service-block map for exactly the direct keys classified 'block'", () => {
      const blockKeys = Object.entries(DIRECT_CONNECTION_FIELD_VISIBILITY)
        .filter(([, visibility]) => visibility === "block")
        .map(([key]) => key);
      expect(new Set(Object.keys(SERVICE_BLOCK_VISIBILITY))).toEqual(
        new Set(blockKeys),
      );
    });

    it("uses 'block' only at the connection level, never inside a block map", () => {
      for (const blockMap of Object.values(SERVICE_BLOCK_VISIBILITY)) {
        for (const visibility of Object.values(blockMap)) {
          expect(visibility).not.toBe("block");
        }
      }
    });
  });

  describe("leak guard", () => {
    it("never classifies a credential-named field as public", () => {
      for (const [label, map] of Object.entries(ALL_MAPS)) {
        for (const [field, visibility] of Object.entries(map)) {
          if (/^(auth|key|secret|password)$/i.test(field)) {
            expect(visibility, `${label}.${field}`).not.toBe("public");
          }
        }
      }
    });

    it("emits no auth key and no secret value anywhere in a fully-populated card", () => {
      const card = buildConnectionCard(FULL_DIRECT);
      const serialized = JSON.stringify(card);
      expect(serialized).not.toContain("auth");
      expect(serialized).not.toContain(SECRET_SENTINEL);
      expect(serialized).not.toContain("key-must-never-surface");
    });
  });

  describe("buildConnectionCard", () => {
    it("surfaces only the public scalars of each present block for a direct connection", () => {
      expect(buildConnectionCard(FULL_DIRECT)).toEqual({
        scalars: { type: "direct", description: "Prod east" },
        blocks: {
          kafka: {
            bootstrap_servers: "broker:9092",
            rest_endpoint: "https://kafka-rest.example.com",
            cluster_id: "lkc-1",
            env_id: "env-1",
          },
          schema_registry: { endpoint: "https://sr.example.com" },
          confluent_cloud: {
            endpoint: "https://api.confluent.cloud",
            organization_id: "org-1",
          },
          tableflow: {},
          telemetry: { endpoint: "https://telemetry.example.com" },
          flink: {
            endpoint: "https://flink.example.com",
            environment_id: "env-1",
            organization_id: "org-1",
            compute_pool_id: "lfcp-1",
            catalog_name: "cat",
            database_name: "db",
          },
        },
      });
    });

    it("returns empty blocks for an oauth connection and surfaces its public scalars", () => {
      expect(buildConnectionCard(FULL_OAUTH)).toEqual({
        scalars: {
          type: "oauth",
          description: "Prod via OAuth",
          ccloud_env: "stag",
          kafka_debug: "security,broker",
        },
        blocks: {},
      });
    });

    it("omits absent blocks and absent optional public fields", () => {
      const card = buildConnectionCard({
        type: "direct",
        kafka: { bootstrap_servers: "broker:9092" },
      });
      expect(card).toEqual({
        scalars: { type: "direct" },
        blocks: { kafka: { bootstrap_servers: "broker:9092" } },
      });
    });
  });
});
