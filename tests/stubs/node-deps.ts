import * as nodeDeps from "@src/confluent/node-deps.js";
import sinon from "sinon";

/** Stubbed fs wrapper methods from {@link nodeDeps.fs}. */
export type StubbedFsWrappers = {
  existsSync: sinon.SinonStub;
  readFileSync: sinon.SinonStub;
  writeFileSync: sinon.SinonStub;
  mkdirSync: sinon.SinonStub;
};

/**
 * Stubs all fs wrapper methods in {@link nodeDeps.fs} using the provided sandbox.
 * The stubs are automatically restored when the sandbox is restored.
 *
 * @param sandbox - Sinon sandbox to use for stubbing
 * @returns Object containing all installed stubs
 *
 * @example
 * ```typescript
 * const sandbox = sinon.createSandbox();
 * const fsStubs = createFsWrappers(sandbox);
 * fsStubs.existsSync.returns(true);
 * fsStubs.readFileSync.returns("file contents");
 * // ... run tests ...
 * sandbox.restore(); // automatically restores all stubs
 * ```
 */
export function createFsWrappers(
  sandbox: sinon.SinonSandbox,
): StubbedFsWrappers {
  return {
    existsSync: sandbox.stub(nodeDeps.fs, "existsSync"),
    readFileSync: sandbox.stub(nodeDeps.fs, "readFileSync"),
    writeFileSync: sandbox.stub(nodeDeps.fs, "writeFileSync"),
    mkdirSync: sandbox.stub(nodeDeps.fs, "mkdirSync"),
  };
}
