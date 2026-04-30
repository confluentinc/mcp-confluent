import type { CCloudOAuthConfig } from "@src/config/models.js";
import {
  KAFKA_PROTECTED_EXTRA_PROPERTY_KEYS,
  MCPServerConfiguration,
  ccloudOAuthConfigSchema,
  formatZodIssues,
  mcpConfigSchema,
} from "@src/config/models.js";
import { describe, expect, it } from "vitest";

describe("config/models.ts", () => {
  const validFlinkBlock = {
    endpoint: "https://flink.us-east-1.aws.confluent.cloud",
    auth: { type: "api_key" as const, key: "flinkkey", secret: "flinksecret" },
    environment_id: "env-abc123",
    organization_id: "org-xyz789",
    compute_pool_id: "lfcp-pool01",
  };

  const directConnection = {
    type: "direct" as const,
    kafka: { bootstrap_servers: "localhost:9092" },
  };
  describe("mcpConfigSchema", () => {
    it("should reject unknown keys at the document root", () => {
      const result = mcpConfigSchema.safeParse({
        conenctions: { local: directConnection },
      });

      expect(result.success).toBe(false);
    });

    // Add a new case here for each new sub-model block added to directConnectionSchema.
    it.each([
      [
        "confluent_cloud",
        { auth: { type: "api_key", key: "k", secret: "s" }, bogus: 1 },
      ],
      ["kafka", { bootstrap_servers: "broker:9092", bogus: 1 }],
      ["schema_registry", { endpoint: "https://sr.example.com", bogus: 1 }],
      [
        "tableflow",
        { auth: { type: "api_key", key: "k", secret: "s" }, bogus: 1 },
      ],
      ["flink", { ...validFlinkBlock, bogus: 1 }],
      [
        "telemetry",
        { auth: { type: "api_key", key: "k", secret: "s" }, bogus: 1 },
      ],
    ])("should reject unknown keys in the %s block", (block, value) => {
      const result = mcpConfigSchema.safeParse({
        connections: { production: { type: "direct", [block]: value } },
      });
      expect(result.success).toBe(false);
    });
  });

  describe("flink block required fields", () => {
    it.each([
      "endpoint",
      "auth",
      "environment_id",
      "organization_id",
      "compute_pool_id",
    ])("should reject flink block with '%s' omitted", (field) => {
      const flink = { ...validFlinkBlock, [field]: undefined };
      const result = mcpConfigSchema.safeParse({
        connections: { production: { type: "direct", flink } },
      });
      expect(result.success).toBe(false);
    });

    it.each(["environment_name", "database_name"])(
      "should reject flink block with empty string for optional field '%s'",
      (field) => {
        const flink = { ...validFlinkBlock, [field]: "" };
        const result = mcpConfigSchema.safeParse({
          connections: { production: { type: "direct", flink } },
        });
        expect(result.success).toBe(false);
      },
    );

    it.each([
      ["environment_id", "bad-id"],
      ["compute_pool_id", "bad-id"],
    ])(
      "should reject flink block with invalid prefix for '%s'",
      (field, value) => {
        const flink = { ...validFlinkBlock, [field]: value };
        const result = mcpConfigSchema.safeParse({
          connections: { production: { type: "direct", flink } },
        });
        expect(result.success).toBe(false);
      },
    );
  });

  describe("kafka block extended metadata fields", () => {
    const baseKafka = { bootstrap_servers: "broker:9092" };

    it.each(["rest_endpoint", "cluster_id", "env_id"])(
      "should accept kafka block with optional field '%s' present",
      (field) => {
        const values: Record<string, string> = {
          rest_endpoint: "https://pkc-abc123.us-east-1.aws.confluent.cloud:443",
          cluster_id: "lkc-abc123",
          env_id: "env-xyz789",
        };
        const result = mcpConfigSchema.safeParse({
          connections: {
            production: {
              type: "direct",
              kafka: { ...baseKafka, [field]: values[field] },
            },
          },
        });
        expect(result.success).toBe(true);
      },
    );

    it("should reject kafka block with invalid rest_endpoint URL", () => {
      const result = mcpConfigSchema.safeParse({
        connections: {
          production: {
            type: "direct",
            kafka: { ...baseKafka, rest_endpoint: "not-a-url" },
          },
        },
      });
      expect(result.success).toBe(false);
    });

    it("should reject kafka block with empty cluster_id", () => {
      const result = mcpConfigSchema.safeParse({
        connections: {
          production: {
            type: "direct",
            kafka: { ...baseKafka, cluster_id: "" },
          },
        },
      });
      expect(result.success).toBe(false);
    });

    it("should reject kafka block with env_id missing 'env-' prefix", () => {
      const result = mcpConfigSchema.safeParse({
        connections: {
          production: {
            type: "direct",
            kafka: { ...baseKafka, env_id: "bad-id" },
          },
        },
      });
      expect(result.success).toBe(false);
    });

    it.each([
      { cluster_id: "lkc-abc123" },
      { env_id: "env-xyz789" },
      { cluster_id: "lkc-abc123", env_id: "env-xyz789" },
    ])(
      "should reject kafka block with no bootstrap_servers or rest_endpoint: %o",
      (kafka) => {
        const result = mcpConfigSchema.safeParse({
          connections: { production: { type: "direct", kafka } },
        });
        expect(result.success).toBe(false);
      },
    );
  });

  describe("kafka extra_properties", () => {
    const baseKafka = { bootstrap_servers: "broker:9092" };

    it("should accept extra_properties with non-protected keys", () => {
      const result = mcpConfigSchema.safeParse({
        connections: {
          production: {
            type: "direct",
            kafka: {
              ...baseKafka,
              extra_properties: {
                "socket.timeout.ms": "30000",
                debug: "broker",
              },
            },
          },
        },
      });
      expect(result.success).toBe(true);
    });

    it.each([...KAFKA_PROTECTED_EXTRA_PROPERTY_KEYS])(
      "should reject extra_properties containing protected key '%s'",
      (key) => {
        const result = mcpConfigSchema.safeParse({
          connections: {
            production: {
              type: "direct",
              kafka: { ...baseKafka, extra_properties: { [key]: "value" } },
            },
          },
        });
        expect(result.success).toBe(false);
      },
    );
  });

  describe("telemetry block", () => {
    it("should accept telemetry block with auth only and resolve default endpoint", () => {
      const result = mcpConfigSchema.safeParse({
        connections: {
          production: {
            type: "direct",
            telemetry: { auth: { type: "api_key", key: "k", secret: "s" } },
          },
        },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.connections["production"]?.telemetry).toEqual({
          endpoint: "https://api.telemetry.confluent.cloud",
          auth: { type: "api_key", key: "k", secret: "s" },
        });
      }
    });

    it("should reject telemetry block with endpoint only when no confluent_cloud.auth is available", () => {
      const result = mcpConfigSchema.safeParse({
        connections: {
          production: {
            type: "direct",
            telemetry: { endpoint: "https://api.telemetry.confluent.cloud" },
          },
        },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(formatZodIssues(result.error.issues)).toMatch(
          /no auth is available/,
        );
      }
    });

    it("should accept telemetry block with endpoint only when confluent_cloud.auth is available", () => {
      const result = mcpConfigSchema.safeParse({
        connections: {
          production: {
            type: "direct",
            confluent_cloud: {
              auth: { type: "api_key", key: "cckey", secret: "ccsecret" },
            },
            telemetry: { endpoint: "https://custom.telemetry.example.com" },
          },
        },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.connections["production"]?.telemetry).toEqual({
          endpoint: "https://custom.telemetry.example.com",
          auth: { type: "api_key", key: "cckey", secret: "ccsecret" },
        });
      }
    });

    it("should accept telemetry block with both endpoint and auth", () => {
      const result = mcpConfigSchema.safeParse({
        connections: {
          production: {
            type: "direct",
            telemetry: {
              endpoint: "https://api.telemetry.confluent.cloud",
              auth: { type: "api_key", key: "k", secret: "s" },
            },
          },
        },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.connections["production"]?.telemetry).toEqual({
          endpoint: "https://api.telemetry.confluent.cloud",
          auth: { type: "api_key", key: "k", secret: "s" },
        });
      }
    });

    it("should synthesize telemetry from confluent_cloud.auth when no telemetry block is present", () => {
      const result = mcpConfigSchema.safeParse({
        connections: {
          production: {
            type: "direct",
            confluent_cloud: {
              auth: { type: "api_key", key: "cckey", secret: "ccsecret" },
            },
          },
        },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.connections["production"]?.telemetry).toEqual({
          endpoint: "https://api.telemetry.confluent.cloud",
          auth: { type: "api_key", key: "cckey", secret: "ccsecret" },
        });
      }
    });

    it("should reject empty telemetry block", () => {
      const result = mcpConfigSchema.safeParse({
        connections: {
          production: { type: "direct", telemetry: {} },
        },
      });
      expect(result.success).toBe(false);
    });

    it("should reject telemetry block with invalid endpoint URL", () => {
      const result = mcpConfigSchema.safeParse({
        connections: {
          production: {
            type: "direct",
            telemetry: { endpoint: "not-a-url" },
          },
        },
      });
      expect(result.success).toBe(false);
    });

    it("should be valid as a standalone block (no kafka, sr, confluent_cloud, tableflow, or flink)", () => {
      const result = mcpConfigSchema.safeParse({
        connections: {
          production: {
            type: "direct",
            telemetry: { auth: { type: "api_key", key: "k", secret: "s" } },
          },
        },
      });
      expect(result.success).toBe(true);
    });
  });

  describe("server block", () => {
    const validConnection = {
      type: "direct" as const,
      kafka: { bootstrap_servers: "broker:9092" },
    };

    it("should apply default server config when server block is omitted", () => {
      const result = mcpConfigSchema.safeParse({
        connections: { production: validConnection },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.server.log_level).toBe("info");
        expect(result.data.server.http.port).toBe(8080);
        expect(result.data.server.http.host).toBe("127.0.0.1");
        expect(result.data.server.auth.disabled).toBe(false);
        expect(result.data.server.auth.allowed_hosts).toEqual([
          "localhost",
          "127.0.0.1",
        ]);
      }
    });

    it("should accept a full server block with all fields", () => {
      const result = mcpConfigSchema.safeParse({
        connections: { production: validConnection },
        server: {
          log_level: "debug",
          http: {
            port: 9090,
            host: "0.0.0.0",
            mcp_endpoint: "/mcp",
            sse_endpoint: "/sse",
            sse_message_endpoint: "/messages",
          },
          auth: {
            api_key: "a".repeat(32),
            disabled: false,
            allowed_hosts: ["localhost", "example.com"],
          },
        },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.server?.log_level).toBe("debug");
        expect(result.data.server?.http?.port).toBe(9090);
        expect(result.data.server?.auth?.api_key).toBe("a".repeat(32));
        expect(result.data.server?.auth?.allowed_hosts).toEqual([
          "localhost",
          "example.com",
        ]);
      }
    });

    it.each(["server", "server.http", "server.auth"])(
      "should reject unknown keys in the %s block",
      (block) => {
        const serverPayload: Record<string, unknown> = {
          server: { bogus: 1 },
          "server.http": { http: { bogus: 1 } },
          "server.auth": { auth: { bogus: 1 } },
        }[block]!;
        const result = mcpConfigSchema.safeParse({
          connections: { production: validConnection },
          server: serverPayload,
        });
        expect(result.success).toBe(false);
      },
    );

    it("should reject server.auth.api_key shorter than 32 characters", () => {
      const result = mcpConfigSchema.safeParse({
        connections: { production: validConnection },
        server: { auth: { api_key: "short" } },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(formatZodIssues(result.error.issues)).toMatch(/32/);
      }
    });

    it("should reject server.auth when disabled:true and api_key are both set", () => {
      const result = mcpConfigSchema.safeParse({
        connections: { production: validConnection },
        server: { auth: { disabled: true, api_key: "a".repeat(32) } },
      });
      expect(result.success).toBe(false);
    });

    it("should accept server.auth with disabled:true and no api_key", () => {
      const result = mcpConfigSchema.safeParse({
        connections: { production: validConnection },
        server: { auth: { disabled: true } },
      });
      expect(result.success).toBe(true);
    });

    it("should accept server.auth with api_key only (no disabled field)", () => {
      const result = mcpConfigSchema.safeParse({
        connections: { production: validConnection },
        server: { auth: { api_key: "a".repeat(32) } },
      });
      expect(result.success).toBe(true);
    });

    it("should reject an invalid server.log_level value", () => {
      const result = mcpConfigSchema.safeParse({
        connections: { production: validConnection },
        server: { log_level: "verbose" },
      });
      expect(result.success).toBe(false);
    });

    it("should coerce server.http.port from a string to a number (post-interpolation values are strings)", () => {
      const result = mcpConfigSchema.safeParse({
        connections: { production: validConnection },
        server: { http: { port: "9090" } },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.server.http.port).toBe(9090);
      }
    });

    it("should default server.transports to [stdio] when omitted", () => {
      const result = mcpConfigSchema.safeParse({
        connections: { production: validConnection },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.server.transports).toEqual(["stdio"]);
      }
    });

    it("should accept an explicit server.transports list", () => {
      const result = mcpConfigSchema.safeParse({
        connections: { production: validConnection },
        server: { transports: ["http", "sse"] },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.server.transports).toEqual(["http", "sse"]);
      }
    });

    it("should reject an empty server.transports array", () => {
      const result = mcpConfigSchema.safeParse({
        connections: { production: validConnection },
        server: { transports: [] },
      });
      expect(result.success).toBe(false);
    });

    it("should reject an unknown transport value in server.transports", () => {
      const result = mcpConfigSchema.safeParse({
        connections: { production: validConnection },
        server: { transports: ["grpc"] },
      });
      expect(result.success).toBe(false);
    });

    it("should reject duplicate entries in server.transports", () => {
      const result = mcpConfigSchema.safeParse({
        connections: { production: validConnection },
        server: { transports: ["http", "http"] },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(formatZodIssues(result.error.issues)).toMatch(/duplicate/i);
      }
    });

    it("should default server.do_not_track to false when omitted", () => {
      const result = mcpConfigSchema.safeParse({
        connections: { production: validConnection },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.server.do_not_track).toBe(false);
      }
    });

    it("should accept server.do_not_track: true", () => {
      const result = mcpConfigSchema.safeParse({
        connections: { production: validConnection },
        server: { do_not_track: true },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.server.do_not_track).toBe(true);
      }
    });
  });

  describe("confluent_cloud block", () => {
    const baseCC = {
      auth: { type: "api_key" as const, key: "k", secret: "s" },
    };

    it("should apply default endpoint when only auth is provided", () => {
      const result = mcpConfigSchema.safeParse({
        connections: {
          production: { type: "direct", confluent_cloud: baseCC },
        },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.connections["production"]?.confluent_cloud).toEqual({
          endpoint: "https://api.confluent.cloud",
          auth: { type: "api_key", key: "k", secret: "s" },
        });
      }
    });

    it("should preserve explicit endpoint when provided", () => {
      const result = mcpConfigSchema.safeParse({
        connections: {
          production: {
            type: "direct",
            confluent_cloud: {
              ...baseCC,
              endpoint: "https://custom.confluent.cloud",
            },
          },
        },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(
          result.data.connections["production"]?.confluent_cloud?.endpoint,
        ).toBe("https://custom.confluent.cloud");
      }
    });

    it("should reject confluent_cloud block with no auth", () => {
      const result = mcpConfigSchema.safeParse({
        connections: {
          production: {
            type: "direct",
            confluent_cloud: { endpoint: "https://api.confluent.cloud" },
          },
        },
      });
      expect(result.success).toBe(false);
    });

    it("should reject empty confluent_cloud block", () => {
      const result = mcpConfigSchema.safeParse({
        connections: {
          production: { type: "direct", confluent_cloud: {} },
        },
      });
      expect(result.success).toBe(false);
    });
  });

  describe("MCPServerConfiguration", () => {
    describe("getConnectionNames", () => {
      it("should return connection names sorted alphabetically", () => {
        const config = new MCPServerConfiguration({
          connections: { staging: directConnection, local: directConnection },
        });

        expect(config.getConnectionNames()).toEqual(["local", "staging"]);
      });
    });

    describe("getSoleConnection", () => {
      it("should return the single defined connection", () => {
        const config = new MCPServerConfiguration({
          connections: { local: directConnection },
        });

        expect(config.getSoleConnection()).toBe(directConnection);
      });

      it("should throw when no connections are defined", () => {
        const config = new MCPServerConfiguration({ connections: {} });

        expect(() => config.getSoleConnection()).toThrow(
          /No connections defined/,
        );
      });

      it("should throw when more than one connection is defined", () => {
        const config = new MCPServerConfiguration({
          connections: {
            local: directConnection,
            staging: {
              type: "direct",
              kafka: { bootstrap_servers: "staging:9092" },
            },
          },
        });

        expect(() => config.getSoleConnection()).toThrow(
          /Multiple connections defined/,
        );
      });
    });

    describe("getCCloudOAuth()", () => {
      it("should return undefined when no oauth config is supplied", () => {
        const config = new MCPServerConfiguration({
          connections: {},
        });
        expect(config.getCCloudOAuth()).toBeUndefined();
      });

      it("should return the supplied config", () => {
        const oauth: CCloudOAuthConfig = { type: "ccloud_oauth", env: "stag" };
        const config = new MCPServerConfiguration({
          connections: {},
          ccloudOAuth: oauth,
        });
        expect(config.getCCloudOAuth()).toEqual(oauth);
      });

      it("should not expose ccloudOAuth as an enumerable property", () => {
        const config = new MCPServerConfiguration({
          connections: {},
          ccloudOAuth: { type: "ccloud_oauth", env: "devel" },
        });
        // Private fields should not appear on Object.keys.
        expect(Object.keys(config)).not.toContain("ccloudOAuth");
        expect(Object.keys(config)).not.toContain("#ccloudOAuth");
      });
    });
  });

  describe("ccloudOAuthConfigSchema", () => {
    it("should accept a valid devel config", () => {
      const result = ccloudOAuthConfigSchema.safeParse({
        type: "ccloud_oauth",
        env: "devel",
      });
      expect(result.success).toBe(true);
    });

    it("should accept stag and prod environments", () => {
      expect(
        ccloudOAuthConfigSchema.safeParse({ type: "ccloud_oauth", env: "stag" })
          .success,
      ).toBe(true);
      expect(
        ccloudOAuthConfigSchema.safeParse({ type: "ccloud_oauth", env: "prod" })
          .success,
      ).toBe(true);
    });

    it("should reject an unknown env value", () => {
      const result = ccloudOAuthConfigSchema.safeParse({
        type: "ccloud_oauth",
        env: "bogus",
      });
      expect(result.success).toBe(false);
    });

    it("should reject a wrong discriminator", () => {
      const result = ccloudOAuthConfigSchema.safeParse({
        type: "direct",
        env: "devel",
      });
      expect(result.success).toBe(false);
    });

    it("should reject when env is missing", () => {
      const result = ccloudOAuthConfigSchema.safeParse({
        type: "ccloud_oauth",
      });
      expect(result.success).toBe(false);
    });

    it("should reject unknown extra keys", () => {
      const result = ccloudOAuthConfigSchema.safeParse({
        type: "ccloud_oauth",
        env: "devel",
        clientId: "should-not-be-here",
      });
      expect(result.success).toBe(false);
    });
  });
});
