import * as nodeDeps from "@src/confluent/node-deps.js";
import { TelemetryService } from "@src/confluent/telemetry.js";
import { type MockInstance, vi } from "vitest";

/**
 * Spy returned by {@linkcode mockTelemetryService}. Tests assert on
 * `.toHaveBeenCalledWith(event, properties)` to verify what was tracked.
 * Auto-restored between tests by the `restoreMocks: true` setting in
 * `vitest.config.ts`; the singleton itself is reset by the same helper on
 * subsequent calls.
 */
export type MockedTelemetryService = MockInstance<
  typeof TelemetryService.prototype.track
>;

/**
 * Initialize {@linkcode TelemetryService} in disabled mode so production code
 * that calls {@linkcode TelemetryService.getInstance} has a singleton to find
 * but no real Segment Analytics traffic leaks out. Stubs the filesystem
 * primitives the constructor reads (machine-id file, homedir) so the helper
 * is filesystem-free.
 *
 * Returns a spy on `TelemetryService.prototype.track` so tests can assert
 * which events would have been emitted.
 *
 * @example
 * ```ts
 * const trackSpy = mockTelemetryService();
 * // ... run code that calls TelemetryService.getInstance().track(...)
 * expect(trackSpy).toHaveBeenCalledWith(TelemetryEvent.TOOL_CALL, { ... });
 * ```
 */
export function mockTelemetryService(): MockedTelemetryService {
  vi.spyOn(nodeDeps.os, "homedir").mockReturnValue("/tmp/test-home");
  vi.spyOn(nodeDeps.fs, "readFileSync").mockReturnValue("test-machine-id");
  vi.spyOn(nodeDeps.fs, "mkdirSync").mockImplementation(
    () => undefined as ReturnType<typeof nodeDeps.fs.mkdirSync>,
  );
  vi.spyOn(nodeDeps.fs, "writeFileSync").mockImplementation(() => undefined);
  TelemetryService["instance"] = undefined;
  TelemetryService.initialize({ doNotTrack: false, writeKey: undefined });
  return vi.spyOn(TelemetryService.prototype, "track");
}

/**
 * Reset the {@linkcode TelemetryService} singleton — call from `afterEach`
 * when {@linkcode mockTelemetryService} was used so the next test starts
 * with a clean slate. `restoreMocks: true` only restores `vi.spyOn` originals,
 * not the static instance field.
 */
export function resetTelemetryService(): void {
  TelemetryService["instance"] = undefined;
}
