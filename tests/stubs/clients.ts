import { KafkaJS } from "@confluentinc/kafka-javascript";
import { SchemaRegistryClient } from "@confluentinc/schemaregistry";
import { DirectClientManager } from "@src/confluent/direct-client-manager.js";
import { paths } from "@src/confluent/openapi-schema.js";
import type { Client } from "openapi-fetch";
import { type Mock, type Mocked, vi } from "vitest";
import { createMockInstance } from "./mock-instance.js";

// shared shape for the six openapi-fetch REST seams (they differ only in `paths`).
type MockedRestClient = Mocked<Client<paths, `${string}/${string}`>>;

/** Returns a bare-mocked openapi-fetch {@link Client} with every HTTP-verb
 *  method as a `vi.fn()`. */
export function getMockedRestClient(): MockedRestClient {
  return {
    GET: vi.fn(),
    POST: vi.fn(),
    PUT: vi.fn(),
    DELETE: vi.fn(),
    PATCH: vi.fn(),
    HEAD: vi.fn(),
    OPTIONS: vi.fn(),
    TRACE: vi.fn(),
  } as unknown as MockedRestClient;
}

/** Returns a bare-mocked {@link KafkaJS.Admin}. `KafkaJS.Admin` is a type alias
 *  (not a runtime class export) in `kafkajs.d.ts`, so methods are listed
 *  explicitly rather than walked via {@linkcode createMockInstance}. */
export function getMockedAdmin(): Mocked<KafkaJS.Admin> {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    createTopics: vi.fn(),
    deleteTopics: vi.fn(),
    listTopics: vi.fn(),
    listGroups: vi.fn(),
    describeGroups: vi.fn(),
    deleteGroups: vi.fn(),
    fetchOffsets: vi.fn(),
    deleteTopicRecords: vi.fn(),
    fetchTopicMetadata: vi.fn(),
    fetchTopicOffsets: vi.fn(),
    fetchTopicOffsetsByTimestamp: vi.fn(),
  } as unknown as Mocked<KafkaJS.Admin>;
}

/** Returns a bare-mocked {@link KafkaJS.Producer}. See {@linkcode getMockedAdmin}
 *  for why methods are listed explicitly. */
export function getMockedProducer(): Mocked<KafkaJS.Producer> {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(),
    sendBatch: vi.fn(),
    flush: vi.fn(),
    transaction: vi.fn(),
    commit: vi.fn(),
    abort: vi.fn(),
    sendOffsets: vi.fn(),
    isActive: vi.fn(),
  } as unknown as Mocked<KafkaJS.Producer>;
}

/** Returns a bare-mocked {@link KafkaJS.Consumer}. See {@linkcode getMockedAdmin}
 *  for why methods are listed explicitly. */
export function getMockedConsumer(): Mocked<KafkaJS.Consumer> {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    subscribe: vi.fn(),
    stop: vi.fn(),
    run: vi.fn(),
    storeOffsets: vi.fn(),
    commitOffsets: vi.fn(),
    committed: vi.fn(),
    seek: vi.fn(),
    pause: vi.fn(),
    paused: vi.fn(),
    resume: vi.fn(),
    assignment: vi.fn(),
  } as unknown as Mocked<KafkaJS.Consumer>;
}

/** Returns a bare-mocked {@link SchemaRegistryClient} via {@linkcode createMockInstance}
 *  (a real runtime class, so its methods come from prototype-walking). */
export function getMockedSchemaRegistry(): Mocked<SchemaRegistryClient> {
  return createMockInstance(SchemaRegistryClient);
}

/**
 * {@link DirectClientManager} where each client-getter's return type is
 * narrowed to the corresponding `Mocked<...>` of the production client. Tests
 * call `cm.getXxxClient()` to retrieve a typed mock and use Vitest mock
 * helpers (`mockResolvedValue`, `mockResolvedValueOnce`, etc.) on the result
 * directly.
 *
 * Each override here pairs with one line of wiring in
 * {@linkcode getMockedClientManager}; adding a new client to
 * `DirectClientManager` requires updating both places.
 *
 * Explicit interface overrides (rather than a derived intersection) are
 * load-bearing: TypeScript treats an intersection of two function-typed keys
 * as an overload set and resolves access to the base signature, stripping
 * the `Mock` helpers from `cm.getXxx()`. Interface extension forces the
 * narrowed types to win.
 */
export interface MockedClientManager extends Mocked<DirectClientManager> {
  getAdminClient: Mock<() => Promise<Mocked<KafkaJS.Admin>>>;
  getProducer: Mock<() => Promise<Mocked<KafkaJS.Producer>>>;
  getConsumer: Mock<(sessionId?: string) => Promise<Mocked<KafkaJS.Consumer>>>;
  getConfluentCloudFlinkRestClient: Mock<() => MockedRestClient>;
  getConfluentCloudRestClient: Mock<() => MockedRestClient>;
  getConfluentCloudTableflowRestClient: Mock<() => MockedRestClient>;
  getConfluentCloudSchemaRegistryRestClient: Mock<() => MockedRestClient>;
  getConfluentCloudKafkaRestClient: Mock<() => MockedRestClient>;
  getConfluentCloudTelemetryRestClient: Mock<() => MockedRestClient>;
  getSchemaRegistryClient: Mock<() => Mocked<SchemaRegistryClient>>;
}

/**
 * Builds a {@link MockedClientManager} with every client getter wired to a
 * fresh bare mock. Tests configure return values per-method on the specific
 * client they exercise:
 *
 * ```ts
 * const cm = getMockedClientManager();
 * cm.getConfluentCloudFlinkRestClient().GET.mockResolvedValue({ data: ... });
 * (await cm.getAdminClient()).listTopics.mockResolvedValue(["topic-a"]);
 * ```
 */
export function getMockedClientManager(): MockedClientManager {
  const cm = createMockInstance(DirectClientManager) as MockedClientManager;

  cm.getConfluentCloudFlinkRestClient.mockReturnValue(getMockedRestClient());
  cm.getConfluentCloudRestClient.mockReturnValue(getMockedRestClient());
  cm.getConfluentCloudTableflowRestClient.mockReturnValue(
    getMockedRestClient(),
  );
  cm.getConfluentCloudSchemaRegistryRestClient.mockReturnValue(
    getMockedRestClient(),
  );
  cm.getConfluentCloudKafkaRestClient.mockReturnValue(getMockedRestClient());
  cm.getConfluentCloudTelemetryRestClient.mockReturnValue(
    getMockedRestClient(),
  );

  cm.getAdminClient.mockResolvedValue(getMockedAdmin());
  cm.getProducer.mockResolvedValue(getMockedProducer());
  cm.getConsumer.mockResolvedValue(getMockedConsumer());

  cm.getSchemaRegistryClient.mockReturnValue(getMockedSchemaRegistry());

  return cm;
}
