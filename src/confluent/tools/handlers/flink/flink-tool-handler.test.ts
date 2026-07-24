import type {
  DirectConnectionConfig,
  FlinkDirectConfig,
  OAuthConnectionConfig,
} from "@src/config/models.js";
import type { CallToolResult } from "@src/confluent/schema.js";
import type { ToolConfig } from "@src/confluent/tools/base-tools.js";
import { READ_ONLY } from "@src/confluent/tools/base-tools.js";
import type { FlinkRoutingArgs } from "@src/confluent/tools/handlers/flink/flink-tool-handler.js";
import { FlinkToolHandler } from "@src/confluent/tools/handlers/flink/flink-tool-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { FLINK_CONN } from "@tests/factories/runtime.js";
import { describe, expect, it } from "vitest";

const FLINK_CONFIG: FlinkDirectConfig = {
  endpoint: "https://flink.example.com",
  auth: { type: "api_key", key: "k", secret: "s" },
  environment_id: "env-from-config",
  organization_id: "org-from-config",
  compute_pool_id: "lfcp-from-config",
};

class StubFlinkHandler extends FlinkToolHandler {
  async handle(): Promise<CallToolResult> {
    return this.createResponse("stub");
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.LIST_FLINK_STATEMENTS,
      description: "stub",
      inputSchema: {},
      annotations: READ_ONLY,
    };
  }
}

describe("flink-tool-handler.ts", () => {
  describe("FlinkToolHandler", () => {
    const handler = new StubFlinkHandler();

    describe("resolveOrgAndEnvIds()", () => {
      const resolveOrgAndEnvIds = handler["resolveOrgAndEnvIds"].bind(
        handler,
      ) as (typeof handler)["resolveOrgAndEnvIds"];

      it("should use orgIdArg for organization_id and fall back to config for environment_id", () => {
        const result = resolveOrgAndEnvIds(
          FLINK_CONFIG,
          "org-from-arg",
          undefined,
        );
        expect(result.organization_id).toBe("org-from-arg");
        expect(result.environment_id).toBe(FLINK_CONFIG.environment_id);
      });

      it("should use envIdArg for environment_id and fall back to config for organization_id", () => {
        const result = resolveOrgAndEnvIds(
          FLINK_CONFIG,
          undefined,
          "env-from-arg",
        );
        expect(result.organization_id).toBe(FLINK_CONFIG.organization_id);
        expect(result.environment_id).toBe("env-from-arg");
      });
    });

    describe("getFlinkDirectConfig()", () => {
      it("should return the flink block when present", () => {
        const conn: DirectConnectionConfig = { type: "direct", ...FLINK_CONN };
        const flink = handler["getFlinkDirectConfig"](conn);
        expect(flink).toBe(conn.flink);
      });

      it("should throw Wacky when the connection has no flink block", () => {
        expect(() =>
          handler["getFlinkDirectConfig"]({ type: "direct" }),
        ).toThrow("Wacky --");
      });
    });

    const directConn: DirectConnectionConfig = {
      type: "direct",
      ...FLINK_CONN,
    };
    const oauthConn: OAuthConnectionConfig = {
      type: "oauth",
      ccloud_env: "devel",
    };

    describe("resolveFlinkRouting()", () => {
      it("should fall back to the flink config block on a direct connection", () => {
        expect(handler["resolveFlinkRouting"](directConn, {})).toEqual({
          organization_id: FLINK_CONN.flink.organization_id,
          environment_id: FLINK_CONN.flink.environment_id,
          compute_pool_id: FLINK_CONN.flink.compute_pool_id,
        });
      });

      it("should prefer explicit args over the config block on a direct connection", () => {
        expect(
          handler["resolveFlinkRouting"](directConn, {
            organizationId: "org-arg",
            environmentId: "env-arg",
            computePoolId: "lfcp-arg",
          }),
        ).toEqual({
          organization_id: "org-arg",
          environment_id: "env-arg",
          compute_pool_id: "lfcp-arg",
        });
      });

      it("should use all three args under OAuth (no config fallback exists)", () => {
        expect(
          handler["resolveFlinkRouting"](oauthConn, {
            organizationId: "org-arg",
            environmentId: "env-arg",
            computePoolId: "lfcp-arg",
          }),
        ).toEqual({
          organization_id: "org-arg",
          environment_id: "env-arg",
          compute_pool_id: "lfcp-arg",
        });
      });

      // Each row drops exactly one of the three required ids so every conjunct
      // of the OAuth guard (!organization_id || !environment_id ||
      // !compute_pool_id) is pinned independently.
      const oauthMissingCases: Array<{
        omitted: string;
        args: FlinkRoutingArgs;
      }> = [
        {
          omitted: "organizationId",
          args: { environmentId: "env-arg", computePoolId: "lfcp-arg" },
        },
        {
          omitted: "environmentId",
          args: { organizationId: "org-arg", computePoolId: "lfcp-arg" },
        },
        {
          omitted: "computePoolId",
          args: { organizationId: "org-arg", environmentId: "env-arg" },
        },
      ];

      it.each(oauthMissingCases)(
        "should throw a discovery hint under OAuth when $omitted is omitted",
        ({ args }) => {
          expect(() => handler["resolveFlinkRouting"](oauthConn, args)).toThrow(
            "required under OAuth connection type",
          );
        },
      );
    });
  });
});
