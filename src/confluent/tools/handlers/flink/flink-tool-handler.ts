import { BaseToolHandler } from "@src/confluent/tools/base-tools.js";
import {
  connectionIdsWhere,
  hasFlink,
} from "@src/confluent/tools/connection-predicates.js";
import { ServerRuntime } from "@src/server-runtime.js";

export abstract class FlinkToolHandler extends BaseToolHandler {
  enabledConnectionIds(runtime: ServerRuntime): string[] {
    return connectionIdsWhere(runtime.config.connections, hasFlink);
  }
}
