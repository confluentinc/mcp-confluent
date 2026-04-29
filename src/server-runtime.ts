import { MCPServerConfiguration } from "@src/config/index.js";
import {
  constructClientManagerForConnection,
  type ClientManager,
} from "@src/confluent/client-manager.js";

/**
 * Aggregate of all runtime state threaded through the server.
 *
 * Carries config and per-connection client managers.
 */
export class ServerRuntime {
  readonly config: MCPServerConfiguration;
  readonly clientManagers: Record<string, ClientManager>;

  constructor(
    config: MCPServerConfiguration,
    clientManagers: Record<string, ClientManager>,
  ) {
    this.config = config;
    this.clientManagers = clientManagers;
  }

  /**
   * Convenience accessor for the single-connection period.
   * Remove (or make multi-connection-aware) when issue #151 lands.
   */
  get clientManager(): ClientManager {
    const managers = Object.values(this.clientManagers);
    if (managers.length === 0) {
      throw new Error("ServerRuntime has no client managers");
    }
    if (managers.length > 1) {
      // enforceSingleConnectionOnly() in config/models.ts should prevent this at parse time;
      // this guard is the runtime mirror of that constraint.
      throw new Error(
        "ServerRuntime has multiple client managers; use clientManagers[id] directly",
      );
    }
    return managers[0]!;
  }

  static fromConfig(config: MCPServerConfiguration): ServerRuntime {
    // Construct a ClientManager for each connection in the config.
    // (although currently there will only be one, see `enforceSingleConnectionOnly()`)

    const clientManagers = Object.fromEntries(
      Object.entries(config.connections).map(([id, conn]) => [
        id,
        constructClientManagerForConnection(conn),
      ]),
    );
    return new ServerRuntime(config, clientManagers);
  }
}
