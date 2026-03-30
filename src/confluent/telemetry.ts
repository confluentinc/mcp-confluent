import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, homedir, platform, release } from "node:os";
import { join } from "node:path";
import { Analytics } from "@segment/analytics-node";
import env from "@src/env.js";
import { logger } from "@src/logger.js";

export enum TelemetryEvent {
  TOOL_CALL = "Tool Call",
}

const FALLBACK_MACHINE_ID = "mcp-confluent-anonymous";
const CONFIG_DIR = ".mcp-confluent";
const MACHINE_ID_FILE = "machine-id";

function getMachineIdFilePath(): string {
  return join(homedir(), CONFIG_DIR, MACHINE_ID_FILE);
}

function readPersistedMachineId(): string | null {
  try {
    const id = readFileSync(getMachineIdFilePath(), "utf-8").trim();
    if (id) return id;
  } catch {
    // File missing or unreadable
  }
  return null;
}

function persistMachineId(id: string): boolean {
  try {
    mkdirSync(join(homedir(), CONFIG_DIR), { recursive: true });
    writeFileSync(getMachineIdFilePath(), id, { mode: 0o600 });
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
  private analytics: Analytics | null = null;
  private machineId: string;
  private serverSessionId: string;
  private commonProperties: Record<string, unknown>;

  private constructor() {
    const writeKey = process.env.TELEMETRY_WRITE_KEY;
    const disabled = env.DO_NOT_TRACK;
    const enabled = !disabled && !!writeKey;

    this.machineId = getOrCreateMachineId();
    this.serverSessionId = randomUUID();
    this.commonProperties = {
      serverSessionId: this.serverSessionId,
      osPlatform: platform(),
      osVersion: release(),
      osArch: arch(),
    };

    if (enabled) {
      this.analytics = new Analytics({ writeKey });
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

  // For testing only
  static resetInstance(): void {
    TelemetryService.instance = undefined;
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
