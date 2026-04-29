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
}
