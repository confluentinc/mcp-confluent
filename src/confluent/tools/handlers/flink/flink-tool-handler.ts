import { ConnectionConfig } from "@src/config/models.js";
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

  protected resolveOrgAndEnvIds(
    conn: ConnectionConfig,
    orgIdArg: string | undefined,
    envIdArg: string | undefined,
  ): { organization_id: string; environment_id: string } {
    return {
      organization_id: this.resolveParam(
        orgIdArg,
        conn.flink?.organization_id,
        "Organization ID",
      ),
      environment_id: this.resolveParam(
        envIdArg,
        conn.flink?.environment_id,
        "Environment ID",
      ),
    };
  }

  protected resolveComputePoolId(
    conn: ConnectionConfig,
    computePoolIdArg: string | undefined,
  ): string {
    return this.resolveParam(
      computePoolIdArg,
      conn.flink?.compute_pool_id,
      "Compute Pool ID",
    );
  }
}
