import type { KafkaMessage } from "@confluentinc/kafka-javascript/types/kafkajs.js";
import {
  KEY_SCHEMA_ID_HEADER,
  SchemaRegistryClient,
  SerdeType,
  VALUE_SCHEMA_ID_HEADER,
} from "@confluentinc/schemaregistry";
import * as schemaRegistryHelper from "@src/confluent/schema-registry-helper.js";
import { logger } from "@src/logger.js";
import { z } from "zod";

/**
 * Shared message-deserialization plumbing for the Kafka consume/search tools.
 *
 * `consume-messages` and `search-messages` both need to turn raw
 * `KafkaMessage` records into the same decoded {@link ProcessedMessage} shape
 * (Schema Registry AVRO/JSON/PROTOBUF decode with raw-bytes fallback, header
 * echoing, timestamp normalization). This module owns that path so neither
 * handler depends on the other — the issue (#476) called this out explicitly.
 */

export const schemaRegistryOptions = z
  .object({
    disableSchemaRegistry: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Set to true to skip Schema Registry decoding and return raw UTF-8 bytes. " +
          "When false (the default), messages are auto-decoded via the registered " +
          "AVRO / JSON / PROTOBUF schema if the connection has Schema Registry " +
          "configured and a schema exists for the subject; otherwise left as raw bytes.",
      ),
    subject: z
      .string()
      .optional()
      .describe(
        "Schema registry subject. Defaults to '<topic>-value' or '<topic>-key'.",
      ),
  })
  // The optional() + default() wrapping lives here on the shared
  // schema so `valueFormat` and `keyFormat` declarations downstream
  // are bare references — one place to change if the omit-by-default
  // contract ever evolves.
  .optional()
  .default({ disableSchemaRegistry: false });

// `ValueOptions` and `KeyOptions` are structurally identical to
// `schemaRegistryOptions` — they exist as named types only to make the
// value-side vs key-side distinction explicit at `processMessage`'s
// signature. The schema fields below use `schemaRegistryOptions` directly;
// no separate runtime schema is needed for each side.
export type ValueOptions = z.infer<typeof schemaRegistryOptions>;
export type KeyOptions = z.infer<typeof schemaRegistryOptions>;

/**
 * Per-invocation memo of `subject` → latest-schema lookup result (a hit, or
 * `null` for a subject with no registered schema). The latest schema for a
 * subject is effectively stable over a single consume/search window, so a
 * caller that processes many records can pass one of these into
 * {@link processMessage} to collapse what would otherwise be one
 * `getLatestSchemaMetadata` REST round-trip *per message per side* into one
 * lookup per subject. Scope it to a single `handle()` call (do not share
 * across calls) so a schema change between invocations is always picked up.
 */
export type SchemaLookupCache = Map<
  string,
  Awaited<ReturnType<typeof schemaRegistryHelper.getLatestSchemaIfExists>>
>;

export interface ProcessedMessage {
  key: unknown;
  value: unknown;
  /**
   * Message timestamp, normalized by {@link formatMessageTimestamp}.
   * Usual case: an ISO 8601 UTC string like `"2026-03-01T17:00:00.000Z"`
   * — surfaced in this format so an LLM consumer can immediately spot
   * mismatches between a requested `start: {timestamp}` filter and the
   * delivered records (ms-since-epoch makes such drift invisible
   * without arithmetic). Two non-ISO outcomes are possible:
   *
   * - The literal sentinel `"(no timestamp)"` when the underlying
   *   Kafka message has no timestamp (Kafka's `-1` sentinel for
   *   pre-0.10.0 message formats, or any record whose producer didn't
   *   set one).
   * - The raw input string passed through unchanged when
   *   `Number(input)` is non-finite — a defensive escape hatch for
   *   degenerate library inputs.
   */
  timestamp: string;
  offset: string;
  /**
   * Record headers echoed back to the caller. Kafka headers are an ordered
   * list whose keys may repeat, so a repeated key is preserved as a
   * `string[]` (multiplicity intact) while a single-occurrence key stays a
   * scalar `string` — mirroring the per-key shape the underlying client
   * surfaces. The schema-id headers decode to their GUID; every other value
   * is stringified element-wise (see {@link echoHeaderValue}).
   */
  headers?: Record<string, string | string[]>;
  topic: string;
  partition: number;
}

/**
 * Format a Kafka message's `message.timestamp` (a string of ms-since-epoch
 * per kafkajs) into an ISO 8601 UTC string. Returns `"(no timestamp)"` for
 * undefined or Kafka's `-1` sentinel (message format pre-0.10.0 or
 * timestamp unset by the producer). Exported for direct unit-test coverage
 * of the four branches plus the empty-string edge case (`Number("")` is
 * `0`, which is finite, so an empty timestamp string formats as epoch).
 */
export function formatMessageTimestamp(ts: string | undefined): string {
  if (ts === undefined || ts === "-1") return "(no timestamp)";
  const ms = Number(ts);
  if (!Number.isFinite(ms)) return ts;
  return new Date(ms).toISOString();
}

const SCHEMA_ID_HEADER_KEYS: ReadonlySet<string> = new Set([
  VALUE_SCHEMA_ID_HEADER,
  KEY_SCHEMA_ID_HEADER,
]);

/**
 * Render a record header for the echoed consume response, preserving
 * multiplicity: a repeated-key header (surfaced by the client as an array)
 * maps element-wise to a `string[]`, while a single-occurrence header stays a
 * scalar `string`. Joining the array via `Array.prototype.toString` would
 * collapse `["a", "b"]` to the lossy `"a,b"` — indistinguishable from a
 * single value literally containing a comma (#597).
 */
export function echoHeaderValue(
  key: string,
  value: Buffer | string | (Buffer | string)[] | undefined,
): string | string[] {
  if (Array.isArray(value)) {
    return value.map((element) => echoSingleHeaderValue(key, element));
  }
  return echoSingleHeaderValue(key, value);
}

/**
 * Stringify one header occurrence. The schema-id headers
 * (__value_schema_id / __key_schema_id) carry the schema GUID as raw bytes;
 * decode them to the canonical GUID string so callers see the same schema
 * identifier the CCloud UI and VS Code extension surface. Every other
 * value — and any schema-id header whose bytes don't decode to a GUID — is
 * stringified as-is.
 */
function echoSingleHeaderValue(
  key: string,
  value: Buffer | string | undefined,
): string {
  if (SCHEMA_ID_HEADER_KEYS.has(key) && Buffer.isBuffer(value)) {
    const guid = schemaRegistryHelper.decodeSchemaGuidHeader(value);
    if (guid !== null) {
      return guid;
    }
  }
  return value?.toString() || "";
}

/**
 * Processes a single Kafka message, handling deserialization of both key and value.
 * @param topic - The topic the message was consumed from
 * @param partition - The partition the message was consumed from
 * @param message - The raw Kafka message
 * @param registry - Optional Schema Registry client for deserialization
 * @param valueOptions - Options for value-side deserialization
 * @param keyOptions - Options for key-side deserialization
 * @param schemaCache - Optional per-invocation {@link SchemaLookupCache}. When
 *   supplied, the latest-schema lookup for a subject is memoized for the life
 *   of the cache, so processing N records costs one `getLatestSchemaMetadata`
 *   round-trip per subject rather than per record. Omit it to look up every
 *   time (the prior behavior).
 * @returns A processed message with deserialized key and value
 */
export async function processMessage(
  topic: string,
  partition: number,
  message: KafkaMessage,
  registry: SchemaRegistryClient | undefined,
  valueOptions: ValueOptions,
  keyOptions: KeyOptions,
  schemaCache?: SchemaLookupCache,
): Promise<ProcessedMessage> {
  let processedKey: unknown = message.key?.toString();
  let processedValue: unknown = message.value?.toString();

  const deserializeWithOptions = async (
    buffer: Buffer | undefined,
    options: ValueOptions | KeyOptions,
    serdeType: SerdeType,
  ): Promise<unknown> => {
    // A null/undefined payload (Kafka tombstone, or an absent key/value)
    // can't be decoded — short-circuit before any SR lookup so the
    // deserializer is never handed a non-Buffer and no spurious error is
    // logged on the inevitable failure.
    if (buffer == null) {
      return undefined;
    }
    if (options.disableSchemaRegistry || !registry) {
      return buffer.toString();
    }
    const subject =
      options.subject ||
      `${topic}-${serdeType === SerdeType.KEY ? "key" : "value"}`;
    // `registry` is non-null here (guarded above); the assertion only
    // satisfies the closure, which can't see the narrowing.
    const lookupLatestSchema = async () => {
      if (schemaCache?.has(subject)) {
        return schemaCache.get(subject)!;
      }
      const result = await schemaRegistryHelper.getLatestSchemaIfExists(
        registry!,
        subject,
      );
      schemaCache?.set(subject, result);
      return result;
    };
    const schema = await lookupLatestSchema();
    if (!schema || !schema.schemaType) {
      return buffer.toString();
    }
    try {
      return await schemaRegistryHelper.deserializeMessage(
        topic,
        buffer,
        schema.schemaType,
        registry,
        serdeType,
        message.headers,
      );
    } catch (err) {
      logger.error(
        { error: err, topic, schemaType: schema.schemaType, serdeType },
        `Error deserializing message ${serdeType} for topic ${topic}`,
      );
      return buffer.toString();
    }
  };

  processedValue = await deserializeWithOptions(
    message.value as Buffer,
    valueOptions,
    SerdeType.VALUE,
  );
  if (message.key) {
    processedKey = await deserializeWithOptions(
      message.key as Buffer,
      keyOptions,
      SerdeType.KEY,
    );
  }

  return {
    key: processedKey,
    value: processedValue,
    timestamp: formatMessageTimestamp(message.timestamp),
    offset: message.offset,
    headers: message.headers
      ? Object.fromEntries(
          Object.entries(message.headers).map(([key, value]) => [
            key,
            echoHeaderValue(key, value),
          ]),
        )
      : undefined,
    topic,
    partition,
  };
}
