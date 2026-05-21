import type { LibrdKafkaError } from "@confluentinc/kafka-javascript/types/rdkafka.js";

/**
 * Build a {@link LibrdKafkaError} fixture for tests that need a rejection
 * payload matching the upstream native-binding shape. `code` is required —
 * the error code is the load-bearing field every caller branches on, so
 * each test spells it out instead of inheriting a shared default whose
 * semantics drift across call sites. `errno` mirrors `code` unless
 * overridden (matching librdkafka's own convention), and `origin` /
 * `message` default to plausible placeholders the call site can override.
 */
export function fakeLibrdKafkaError(
  overrides: Partial<LibrdKafkaError> & Pick<LibrdKafkaError, "code">,
): LibrdKafkaError {
  return {
    message: "broker error",
    errno: overrides.code,
    origin: "kafka",
    ...overrides,
  };
}
