import { KafkaJS } from "@confluentinc/kafka-javascript";
import {
  STATE_NAME_TO_ENUM,
  stateName,
  TYPE_NAME_TO_ENUM,
  typeName,
} from "@src/confluent/tools/handlers/kafka/consumer-group-enums.js";
import { describe, expect, it } from "vitest";

describe("consumer-group-enums.ts", () => {
  describe("STATE_NAME_TO_ENUM pin against upstream KafkaJS.ConsumerGroupStates", () => {
    // The hand list in STATE_NAMES (and thus STATE_NAME_TO_ENUM) goes
    // stale silently if librdkafka / @confluentinc/kafka-javascript adds
    // a new ConsumerGroupStates value: `listGroups` would return a
    // numeric we don't recognize and the `stateName()` fallback would
    // surface every group as "Unknown". The set-equality pin makes that
    // drift loud at unit-test time.
    it("should map exactly the numeric ConsumerGroupStates enum values upstream advertises", () => {
      const upstreamNumeric = new Set(
        Object.values(KafkaJS.ConsumerGroupStates).filter(
          (v): v is KafkaJS.ConsumerGroupStates => typeof v === "number",
        ),
      );
      const mapped = new Set(Object.values(STATE_NAME_TO_ENUM));
      // Set equality so the test fires in both directions: upstream
      // gains a value we don't map, OR we map a value upstream removed.
      expect(mapped).toEqual(upstreamNumeric);
    });
  });

  describe("TYPE_NAME_TO_ENUM pin against upstream KafkaJS.ConsumerGroupTypes", () => {
    // Same rationale as STATE_NAME_TO_ENUM, with one wrinkle:
    // `KafkaJS.ConsumerGroupTypes.UNKNOWN` is intentionally excluded
    // from the Zod input vocabulary — it's the "no value reported"
    // sentinel rather than a queryable protocol type. `typeName()`
    // handles it as a runtime fallback for response shaping, not as a
    // filterable input. The pin therefore subtracts UNKNOWN from the
    // upstream set before comparing.
    it("should map exactly the non-UNKNOWN numeric ConsumerGroupTypes enum values upstream advertises", () => {
      const upstreamMinusUnknown = new Set(
        Object.values(KafkaJS.ConsumerGroupTypes).filter(
          (v): v is KafkaJS.ConsumerGroupTypes =>
            typeof v === "number" && v !== KafkaJS.ConsumerGroupTypes.UNKNOWN,
        ),
      );
      const mapped = new Set(Object.values(TYPE_NAME_TO_ENUM));
      expect(mapped).toEqual(upstreamMinusUnknown);
    });
  });

  describe("stateName()", () => {
    it("should map every known numeric state to its TitleCase wire string", () => {
      expect(stateName(KafkaJS.ConsumerGroupStates.STABLE)).toBe("Stable");
      expect(stateName(KafkaJS.ConsumerGroupStates.EMPTY)).toBe("Empty");
      expect(stateName(KafkaJS.ConsumerGroupStates.DEAD)).toBe("Dead");
      expect(stateName(KafkaJS.ConsumerGroupStates.UNKNOWN)).toBe("Unknown");
      expect(stateName(KafkaJS.ConsumerGroupStates.PREPARING_REBALANCE)).toBe(
        "PreparingRebalance",
      );
      expect(stateName(KafkaJS.ConsumerGroupStates.COMPLETING_REBALANCE)).toBe(
        "CompletingRebalance",
      );
    });

    it("should fall through to 'Unknown' for an unrecognized numeric value (wacky path)", () => {
      expect(stateName(9999 as KafkaJS.ConsumerGroupStates)).toBe("Unknown");
    });
  });

  describe("typeName()", () => {
    it("should map every known numeric type to its TitleCase wire string", () => {
      expect(typeName(KafkaJS.ConsumerGroupTypes.CLASSIC)).toBe("Classic");
      expect(typeName(KafkaJS.ConsumerGroupTypes.CONSUMER)).toBe("Consumer");
    });

    it("should map the UNKNOWN sentinel to the literal 'Unknown' string", () => {
      expect(typeName(KafkaJS.ConsumerGroupTypes.UNKNOWN)).toBe("Unknown");
    });

    it("should fall through to 'Unknown' for an unrecognized numeric value (wacky path)", () => {
      expect(typeName(9999 as KafkaJS.ConsumerGroupTypes)).toBe("Unknown");
    });
  });
});
