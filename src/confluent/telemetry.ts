import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Analytics } from "@segment/analytics-node";
import { TELEMETRY_WRITE_KEY } from "@src/confluent/telemetry-config.js";
import env from "@src/env.js";
import { logger } from "@src/logger.js";

export enum TelemetryEvent {
  TOOL_CALL_COMPLETED = "Tool Call Completed",
  TOOL_CALL_FAILED = "Tool Call Failed",
  SERVER_STARTED = "Server Started",
  SERVER_STOPPED = "Server Stopped",
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

  private constructor() {
    const writeKey = process.env.TELEMETRY_WRITE_KEY ?? TELEMETRY_WRITE_KEY;
    const disabled = env.DO_NOT_TRACK;
    const enabled = !disabled && !!writeKey && writeKey !== TELEMETRY_WRITE_KEY;

    this.machineId = getOrCreateMachineId();

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

  static resetInstance(): void {
    TelemetryService.instance = undefined;
  }

  track(event: TelemetryEvent, properties: Record<string, unknown>): void {
    if (!this.analytics) return;
    this.analytics.track({
      event,
      properties,
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
