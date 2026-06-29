import {
  ConnectionConfig,
  DirectConnectionConfig,
  FlinkDirectConfig,
} from "@src/config/models.js";
import {
  BaseToolHandler,
  ToolCategory,
} from "@src/confluent/tools/base-tools.js";
import { hasFlinkOrOAuth } from "@src/confluent/tools/connection-predicates.js";

/** Arguments routed into a Flink REST call, in tool-arg (camelCase) form. */
export interface FlinkRoutingArgs {
  organizationId?: string;
  environmentId?: string;
  computePoolId?: string;
}

/** Intermediate base class for Flink tool handlers */
export abstract class FlinkToolHandler extends BaseToolHandler {
  readonly category = ToolCategory.Flink;
  readonly predicate = hasFlinkOrOAuth;

  /**
   * Extracts the Flink config block from the resolved connection, asserting it exists.
   * Throws "Wacky -- " if called on a connection without a flink block (should be
   * impossible in production given the hasFlink gate, but caught here rather than
   * silently propagating undefined).
   */
  protected getFlinkDirectConfig(
    conn: DirectConnectionConfig,
  ): FlinkDirectConfig {
    const flink = conn.flink;
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

  /**
   * Resolves the org / env / compute-pool IDs that route a Flink REST call,
   * handling both connection arms. The compute pool ID is always required —
   * the Flink REST host is regional and resolved from it under OAuth, and on
   * direct connections the `flink` block always carries one (the config schema
   * makes `flink.compute_pool_id` mandatory).
   *
   * - Direct: explicit args win, falling back to the `flink.*` config block.
   * - OAuth: all three are required as arguments (an OAuth connection carries
   *   no `flink` block to default from); throws a discovery hint when any is
   *   missing.
   */
  protected resolveFlinkRouting(
    conn: ConnectionConfig,
    args: FlinkRoutingArgs,
  ): {
    organization_id: string;
    environment_id: string;
    compute_pool_id: string;
  } {
    if (conn.type === "oauth") {
      const organization_id = args.organizationId?.trim();
      const environment_id = args.environmentId?.trim();
      const compute_pool_id = args.computePoolId?.trim();
      if (!organization_id || !environment_id || !compute_pool_id) {
        throw new Error(
          "organizationId, environmentId, and computePoolId are required under OAuth connection type. " +
            "Discover the environment via list-environments; the compute pool id (lfcp-...) and its " +
            "region come from the Confluent Cloud console or the Flink compute pools API.",
        );
      }
      return { organization_id, environment_id, compute_pool_id };
    }
    const flink = this.getFlinkDirectConfig(conn);
    const { organization_id, environment_id } = this.resolveOrgAndEnvIds(
      flink,
      args.organizationId,
      args.environmentId,
    );
    return {
      organization_id,
      environment_id,
      compute_pool_id: this.resolveComputePoolId(flink, args.computePoolId),
    };
  }
}
