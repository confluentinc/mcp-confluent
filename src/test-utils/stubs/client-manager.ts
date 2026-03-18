import sinon, { SinonStubbedInstance } from "sinon";
import { DefaultClientManager } from "@src/confluent/client-manager.js";

/** Creates a sinon-stubbed {@link DefaultClientManager}. */
export function createStubClientManager(): SinonStubbedInstance<DefaultClientManager> {
  return sinon.createStubInstance(DefaultClientManager);
}
