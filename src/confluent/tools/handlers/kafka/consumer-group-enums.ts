import { KafkaJS } from "@confluentinc/kafka-javascript";
import { logger } from "@src/logger.js";

/**
 * Hand-listed to stay in lockstep with the {@link KafkaJS.ConsumerGroupStates}
 * numeric enum in `@confluentinc/kafka-javascript/types/rdkafka.d.ts`. Not
 * derived via `Object.values(KafkaJS.ConsumerGroupStates)` because TypeScript
 * reverse-maps numeric enums and would surface both names and numbers, which
 * Zod's `z.enum` rejects. The companion pin test in
 * `consumer-group-enums.test.ts` enforces drift detection against the upstream
 * enum.
 */
export const STATE_NAMES = [
  "Unknown",
  "PreparingRebalance",
  "CompletingRebalance",
  "Stable",
  "Dead",
  "Empty",
] as const;

/**
 * Hand-listed to stay in lockstep with the {@link KafkaJS.ConsumerGroupTypes}
 * numeric enum (see {@link STATE_NAMES} for why we don't derive). The
 * `UNKNOWN` slot is deliberately excluded from the input vocabulary —
 * it's the "no value reported" sentinel rather than a queryable protocol
 * type.
 */
export const TYPE_NAMES = ["Classic", "Consumer"] as const;

export type StateName = (typeof STATE_NAMES)[number];
export type TypeName = (typeof TYPE_NAMES)[number];

/**
 * Zod-input name → numeric enum value forwarded to `admin.listGroups`.
 * Used by the `list-consumer-groups` filter; pinned by a test asserting
 * coverage against the upstream {@link KafkaJS.ConsumerGroupStates} enum.
 */
export const STATE_NAME_TO_ENUM: Readonly<
  Record<StateName, KafkaJS.ConsumerGroupStates>
> = {
  Unknown: KafkaJS.ConsumerGroupStates.UNKNOWN,
  PreparingRebalance: KafkaJS.ConsumerGroupStates.PREPARING_REBALANCE,
  CompletingRebalance: KafkaJS.ConsumerGroupStates.COMPLETING_REBALANCE,
  Stable: KafkaJS.ConsumerGroupStates.STABLE,
  Dead: KafkaJS.ConsumerGroupStates.DEAD,
  Empty: KafkaJS.ConsumerGroupStates.EMPTY,
};

/**
 * Zod-input name → numeric enum value forwarded to `admin.listGroups`.
 * Pinned by a test asserting coverage against the upstream
 * {@link KafkaJS.ConsumerGroupTypes} enum (minus the `UNKNOWN` slot,
 * which is deliberately excluded — see {@link TYPE_NAMES}).
 */
export const TYPE_NAME_TO_ENUM: Readonly<
  Record<TypeName, KafkaJS.ConsumerGroupTypes>
> = {
  Classic: KafkaJS.ConsumerGroupTypes.CLASSIC,
  Consumer: KafkaJS.ConsumerGroupTypes.CONSUMER,
};

/** Reverse of {@link STATE_NAME_TO_ENUM} for response payload shaping. */
const ENUM_TO_STATE_NAME: ReadonlyMap<KafkaJS.ConsumerGroupStates, StateName> =
  new Map(
    (
      Object.entries(STATE_NAME_TO_ENUM) as Array<
        [StateName, KafkaJS.ConsumerGroupStates]
      >
    ).map(([name, value]) => [value, name]),
  );

/** Reverse of {@link TYPE_NAME_TO_ENUM} for response payload shaping. */
const ENUM_TO_TYPE_NAME: ReadonlyMap<KafkaJS.ConsumerGroupTypes, TypeName> =
  new Map(
    (
      Object.entries(TYPE_NAME_TO_ENUM) as Array<
        [TypeName, KafkaJS.ConsumerGroupTypes]
      >
    ).map(([name, value]) => [value, name]),
  );

/**
 * Map a numeric librdkafka state enum back to the TitleCase wire string. An
 * unrecognized value is "Wacky --" territory — log it and fall through to
 * `"Unknown"` rather than synthesize a stringified number.
 */
export function stateName(value: KafkaJS.ConsumerGroupStates): StateName {
  const name = ENUM_TO_STATE_NAME.get(value);
  if (name === undefined) {
    logger.warn(
      { value },
      "Wacky -- unrecognized ConsumerGroupStates numeric value from librdkafka; surfacing as 'Unknown'",
    );
    return "Unknown";
  }
  return name;
}

/**
 * Map a numeric librdkafka type enum back to the TitleCase wire string. The
 * librdkafka enum has an `UNKNOWN = 0` slot that is not part of the Zod
 * input vocabulary; surface it as the literal `"Unknown"` so callers see a
 * stable string rather than a number.
 */
export function typeName(value: KafkaJS.ConsumerGroupTypes): string {
  if (value === KafkaJS.ConsumerGroupTypes.UNKNOWN) return "Unknown";
  const name = ENUM_TO_TYPE_NAME.get(value);
  if (name === undefined) {
    logger.warn(
      { value },
      "Wacky -- unrecognized ConsumerGroupTypes numeric value from librdkafka; surfacing as 'Unknown'",
    );
    return "Unknown";
  }
  return name;
}
