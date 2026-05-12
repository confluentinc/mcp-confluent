import { KafkaJS } from "@confluentinc/kafka-javascript";
import { SchemaRegistryClient } from "@confluentinc/schemaregistry";
import { DirectClientManager } from "@src/confluent/direct-client-manager.js";
import { kafkaDeps } from "@src/confluent/node-deps.js";
import { paths } from "@src/confluent/openapi-schema.js";
import type { Client } from "openapi-fetch";
import { type Mock, type MockInstance, type Mocked, vi } from "vitest";
import { createMockInstance } from "./mock-instance.js";

// shared shape for the six openapi-fetch REST seams (they differ only in `paths`).
export type MockedRestClient = Mocked<Client<paths, `${string}/${string}`>>;

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
 * Mocks `new Kafka(config)` (via {@linkcode kafkaDeps.Kafka}) to return `fake`.
 * Use when the unit under test is the code that constructs `Kafka` and the
 * assertion is about what config got passed — read it back from
 * `spy.mock.calls[0]![0]` rather than maintaining a closure variable. (The
 * `!` is needed because `noUncheckedIndexedAccess` makes the outer array
 * index possibly-undefined; the inner element type is narrowed by the helper's
 * return type — see below.)
 *
 * `fake` is structurally typed (just the factory methods tests actually mock),
 * not `Partial<KafkaJS.Kafka>`, because partial-of-the-full-class would still
 * require each present method to return the complete `Admin`/`Producer`/
 * `Consumer` interface. Real tests only mock the methods they exercise.
 *
 * Each slot is typed as `(...args: unknown[]) => unknown` — broad enough that
 * both shapes call sites actually use land without casts: a thunk that returns
 * a hand-rolled partial (`{ admin: () => fakeAdmin }`) and a `vi.fn()` whose
 * captured args the test wants to read back (`{ consumer: vi.fn() }`). A
 * narrower `KafkaJS.Kafka["consumer"]` would force every test to satisfy the
 * real `Consumer` return type just to stub two methods.
 *
 * The returned spy declares its constructor signature as `(config:
 * Record<string, unknown>) => Kafka` (required config, not `Partial<...> |
 * undefined` from the real signature) so `mock.calls[0]![0]` reads back as
 * `Record<string, unknown>` rather than `CommonConstructorConfig | undefined`.
 * Production never calls `new Kafka()` without a config, so this isn't a lie.
 *
 * Implemented via `mockImplementation(class { constructor() { return fake; } })`:
 * Vitest rejects `mockReturnValue` on a `new`-called spy (it throws when the
 * spied prop is actually invoked with `new`), and an arrow-function
 * implementation can't be constructed at all. A regular `function () { ... }`
 * body works too if the signature can satisfy the constructor type (e.g.
 * declaring `this: unknown`, as in `telemetry.test.ts`); the class-keyword
 * form is just clearer for this multi-method fake.
 */
export function mockKafkaConstructor(fake: {
  admin?: (...args: unknown[]) => unknown;
  producer?: (...args: unknown[]) => unknown;
  consumer?: (...args: unknown[]) => unknown;
}): MockInstance<(config: Record<string, unknown>) => KafkaJS.Kafka> {
  return vi.spyOn(kafkaDeps, "Kafka").mockImplementation(
    class FakeKafka {
      constructor() {
        return fake as unknown as KafkaJS.Kafka;
      }
    } as unknown as typeof KafkaJS.Kafka,
  ) as unknown as MockInstance<
    (config: Record<string, unknown>) => KafkaJS.Kafka
  >;
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
  // Cluster-aware accessors. On direct, production delegates to the singleton
  // accessors above; getMockedClientManager wires these to do the same so
  // tests configure `getAdminClient` / `getProducer` / `getConsumer` and the
  // cluster-aware getter lands on the same mock.
  getKafkaAdminClient: Mock<
    (clusterId?: string, envId?: string) => Promise<Mocked<KafkaJS.Admin>>
  >;
  getKafkaProducer: Mock<
    (clusterId?: string, envId?: string) => Promise<Mocked<KafkaJS.Producer>>
  >;
  buildKafkaConsumer: Mock<
    (
      clusterId?: string,
      envId?: string,
      groupId?: string,
    ) => Promise<Mocked<KafkaJS.Consumer>>
  >;
  getConfluentCloudFlinkRestClient: Mock<() => MockedRestClient>;
  getConfluentCloudRestClient: Mock<() => MockedRestClient>;
  getConfluentCloudTableflowRestClient: Mock<() => MockedRestClient>;
  getConfluentCloudSchemaRegistryRestClient: Mock<() => MockedRestClient>;
  getConfluentCloudKafkaRestClient: Mock<
    (clusterId?: string, envId?: string) => Promise<MockedRestClient>
  >;
  getConfluentCloudTelemetryRestClient: Mock<() => MockedRestClient>;
  getSchemaRegistryClient: Mock<() => Mocked<SchemaRegistryClient>>;
  getSchemaRegistrySdkClient: Mock<
    (envId?: string) => Promise<Mocked<SchemaRegistryClient>>
  >;
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
 *
 * Two invariants are load-bearing:
 *
 * - **Same getter, same mock.** Getters use `mockReturnValue` (not
 *   `mockReturnValueOnce`), so every call to `cm.getXxx()` returns the same
 *   underlying mock. A reference captured in setup stays valid for
 *   assertions after the handler runs, and the handler's own getter call
 *   lands on the same mock the test wired.
 * - **Build per test, not per suite.** Invoke this once per test — either
 *   inline in each `it` body or by reassigning a suite-scope `let` from a
 *   `beforeEach`. The anti-pattern is a suite-scope `const cm =
 *   getMockedClientManager()` that runs once, since Vitest's
 *   `restoreMocks: true` only restores `vi.spyOn` originals and `vi.fn()`
 *   call histories and configured return values would then leak across
 *   tests.
 *   {@see https://vitest.dev/config/restoremocks}
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
  cm.getConfluentCloudKafkaRestClient.mockResolvedValue(getMockedRestClient());
  cm.getConfluentCloudTelemetryRestClient.mockReturnValue(
    getMockedRestClient(),
  );

  cm.getAdminClient.mockResolvedValue(getMockedAdmin());
  cm.getProducer.mockResolvedValue(getMockedProducer());
  cm.getConsumer.mockResolvedValue(getMockedConsumer());

  // Cluster-aware accessors delegate to the singleton mocks above on direct,
  // matching DirectClientManager's production wiring. Tests can override
  // either layer; the underlying mocks (getAdminClient etc.) stay the
  // canonical configuration point so existing test setup keeps working.
  cm.getKafkaAdminClient.mockImplementation(() => cm.getAdminClient());
  cm.getKafkaProducer.mockImplementation(() => cm.getProducer());
  cm.buildKafkaConsumer.mockImplementation((_cluster, _env, groupId) =>
    cm.getConsumer(groupId),
  );

  cm.getSchemaRegistryClient.mockReturnValue(getMockedSchemaRegistry());
  cm.getSchemaRegistrySdkClient.mockImplementation(async () =>
    cm.getSchemaRegistryClient(),
  );

  return cm;
}
