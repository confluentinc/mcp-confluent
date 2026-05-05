import {
  FlinkDirectConfig,
  MCPServerConfiguration,
} from "@src/config/models.js";
import { BaseToolHandler } from "@src/confluent/tools/base-tools.js";
import {
  connectionIdsWhere,
  hasFlink,
} from "@src/confluent/tools/connection-predicates.js";
import { ServerRuntime } from "@src/server-runtime.js";

/** Intermediate base class for Flink tool handlers */
export abstract class FlinkToolHandler extends BaseToolHandler {
  /** Implementation of enabledConnectionIds gating on having a connection with a valid Flink block.  */
  enabledConnectionIds(runtime: ServerRuntime): string[] {
    return connectionIdsWhere(runtime.config.connections, hasFlink);
  }

  /**
   * Extracts the Flink config block from the sole connection, asserting it exists.
   * Throws "Wacky -- " if called on a connection without a flink block (should be
   * impossible in production given the hasFlink gate, but caught here rather than
   * silently propagating undefined).
   */
  protected getFlinkDirectConfig(
    config: MCPServerConfiguration,
  ): FlinkDirectConfig {
    const flink = config.getSoleDirectConnection().flink;
    if (!flink)
      throw new Error(
        "Wacky -- FlinkToolHandler invoked on a connection without a flink block",
      );
    return flink;
  }

  protected resolveOrgAndEnvIds(
    flink: FlinkDirectConfig,
    orgIdArg: string | undefined,
    envIdArg: string | undefined,
  ): { organization_id: string; environment_id: string } {
    return {
      organization_id: this.resolveParam(
        orgIdArg,
        flink.organization_id,
        "Organization ID",
      ),
      environment_id: this.resolveParam(
        envIdArg,
        flink.environment_id,
        "Environment ID",
      ),
    };
  }

  protected resolveComputePoolId(
    flink: FlinkDirectConfig,
    computePoolIdArg: string | undefined,
  ): string {
    return this.resolveParam(
      computePoolIdArg,
      flink.compute_pool_id,
      "Compute Pool ID",
    );
  }

  protected resolveOptionalComputePoolId(
    flink: FlinkDirectConfig,
    computePoolIdArg: string | undefined,
  ): string | undefined {
    return this.resolveOptionalParam(computePoolIdArg, flink.compute_pool_id);
  }
}
