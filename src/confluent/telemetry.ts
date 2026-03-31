import {
  config,
  crypto,
  fs,
  os,
  path,
  segment,
} from "@src/confluent/node-deps.js";
import { logger } from "@src/logger.js";

export enum TelemetryEvent {
  TOOL_CALL = "Tool Call",
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

  const newId = crypto.randomUUID();
  if (persistMachineId(newId)) return newId;

  return FALLBACK_MACHINE_ID;
}

export class TelemetryService {
  private static instance: TelemetryService | undefined;
  private analytics: InstanceType<typeof segment.Analytics> | null = null;
  private machineId: string;
  private serverSessionId: string;
  private commonProperties: Record<string, unknown>;

  private constructor() {
    const writeKey = process.env.TELEMETRY_WRITE_KEY;
    const disabled = config.env.DO_NOT_TRACK;
    const enabled = !disabled && !!writeKey;

    this.machineId = getOrCreateMachineId();
    this.serverSessionId = crypto.randomUUID();
    this.commonProperties = {
      serverSessionId: this.serverSessionId,
      osPlatform: os.platform(),
      osVersion: os.release(),
      osArch: os.arch(),
    };

    if (enabled) {
      this.analytics = new segment.Analytics({ writeKey });
      logger.info("Telemetry enabled");
    } else {
      logger.info("Telemetry disabled");
    }
  }

  static getInstance(): TelemetryService {
    if (!TelemetryService.instance) {
      TelemetryService.instance = new TelemetryService();
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
