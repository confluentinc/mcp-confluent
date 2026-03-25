import { KafkaJS } from "@confluentinc/kafka-javascript";
import sinon from "sinon";

/** {@link KafkaJS.Admin} with all methods replaced by {@link stubs}. */
export type StubbedAdmin = {
  [K in keyof KafkaJS.Admin]: sinon.SinonStub;
};

/**
 * Creates a {@link KafkaJS.Admin} stub with all methods replaced by
 * {@link SinonStub stubs}. Each method resolves with a sensible empty default.
 */
export function createStubAdmin(): StubbedAdmin {
  return {
    connect: sinon.stub().resolves(),
    disconnect: sinon.stub().resolves(),
    createTopics: sinon.stub().resolves(true),
    deleteTopics: sinon.stub().resolves(),
    listTopics: sinon.stub().resolves([]),
    listGroups: sinon.stub().resolves({ groups: [], errors: [] }),
    describeGroups: sinon.stub().resolves({ groups: [] }),
    deleteGroups: sinon.stub().resolves([]),
    fetchOffsets: sinon.stub().resolves([]),
    deleteTopicRecords: sinon.stub().resolves([]),
    fetchTopicMetadata: sinon.stub().resolves({ topics: [] }),
    fetchTopicOffsets: sinon.stub().resolves([]),
    fetchTopicOffsetsByTimestamp: sinon.stub().resolves([]),
  };
}
