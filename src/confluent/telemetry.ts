import { fs, os, path, segment } from "@src/confluent/node-deps.js";
import { logger } from "@src/logger.js";
import { randomUUID } from "node:crypto";

export enum TelemetryEvent {
  /**
   * Emitted once after successful startup so we can count boots independently
   * of tool calls.
   */
  SERVER_START = "Server Start",
  /**
   * Emitted once for every tool call for telemetry on tool usage.
   */
  TOOL_CALL = "Tool Call",
  /**
   * Emitted once per terminal OAuth PKCE login attempt (success or failure).
   * Refresh-token rotations are not tracked here.
   */
  CCLOUD_AUTHENTICATION = "CCloud Authentication",
}

/**
 * Inputs to {@link TelemetryService.initialize}. `writeKey` is whatever the
 * caller resolved (YAML override, build-config injected value, or undefined);
 * the service treats `undefined`/`""` as "telemetry off" and otherwise hands
 * the value to the Segment Analytics constructor.
 */
export interface TelemetryInitOptions {
  readonly doNotTrack: boolean;
  readonly writeKey: string | undefined;
}

export const FALLBACK_MACHINE_ID = "00000000-0000-0000-0000-000000000000";
const CONFIG_DIR = ".mcp-confluent";
const MACHINE_ID_FILE = "machine-id";

function getMachineIdFilePath(): string {
  return path.join(os.homedir(), CONFIG_DIR, MACHINE_ID_FILE);
}

function readPersistedMachineId(): string | null {
  try {
    const id = fs.readFileSync(getMachineIdFilePath(), "utf-8").trim();
    if (id) return id;
  } catch {
    // File missing or unreadable
  }
  return null;
}

function persistMachineId(id: string): boolean {
  try {
    fs.mkdirSync(path.join(os.homedir(), CONFIG_DIR), { recursive: true });
    fs.writeFileSync(getMachineIdFilePath(), id, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function getOrCreateMachineId(): string {
  const existingId = readPersistedMachineId();
  if (existingId) return existingId;

  const newId = randomUUID();
  if (persistMachineId(newId)) return newId;

  return FALLBACK_MACHINE_ID;
}

export class TelemetryService {
  private static instance: TelemetryService | undefined;
  private analytics: InstanceType<typeof segment.Analytics> | null = null;
  private machineId: string;
  private serverSessionId: string;
  private commonProperties: Record<string, unknown>;

  private constructor(opts: TelemetryInitOptions) {
    const enabled = !opts.doNotTrack && !!opts.writeKey;

    this.machineId = getOrCreateMachineId();
    this.serverSessionId = randomUUID();
    this.commonProperties = {
      serverSessionId: this.serverSessionId,
      osPlatform: os.platform(),
      osVersion: os.release(),
      osArch: os.arch(),
    };

    if (enabled) {
      this.analytics = new segment.Analytics({ writeKey: opts.writeKey });
      logger.info("Telemetry enabled");
    } else {
      logger.info("Telemetry disabled");
    }
  }

  /**
   * Bootstrap-time entry point. The caller (main()) is responsible for
   * resolving `writeKey` from its sources — typically
   * `mcpConfig.server.analytics?.write_key ?? buildConfig.TELEMETRY_WRITE_KEY`
   * — before invoking this. A falsy `writeKey` (`undefined` or `""`) keeps
   * analytics disabled even when `doNotTrack` is false.
   */
  static initialize(opts: TelemetryInitOptions): void {
    if (TelemetryService.instance) {
      throw new Error(
        "TelemetryService has already been initialized — initialize() must be called exactly once before getInstance()",
      );
    }
    TelemetryService.instance = new TelemetryService(opts);
  }

  static getInstance(): TelemetryService {
    if (!TelemetryService.instance) {
      throw new Error(
        "TelemetryService.initialize() must be called before getInstance()",
      );
    }
    return TelemetryService.instance;
  }

  setCommonProperties(properties: Record<string, unknown>): void {
    Object.assign(this.commonProperties, properties);
  }

  track(event: TelemetryEvent, properties: Record<string, unknown>): void {
    if (!this.analytics) return;
    this.analytics.track({
      event,
      properties: { ...this.commonProperties, ...properties },
      userId: this.machineId,
    });
  }

  identify(userId: string, traits: Record<string, unknown>): void {
    if (!this.analytics) return;
    this.analytics.identify({ userId, traits });
  }

  async shutdown(): Promise<void> {
    if (!this.analytics) return;
    await this.analytics.closeAndFlush({ timeout: 5000 });
    this.analytics = null;
  }
}
