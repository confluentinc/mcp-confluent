import { KafkaJS } from "@confluentinc/kafka-javascript";
import { SchemaRegistryClient } from "@confluentinc/schemaregistry";
import { nodeCrypto } from "@src/confluent/node-deps.js";
import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  READ_ONLY,
  ToolCategory,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import {
  formatKafkaError,
  resolveKafkaClusterArgs,
} from "@src/confluent/tools/cluster-arg-resolvers.js";
import {
  hasSchemaRegistryOrOAuth,
  kafkaBootstrapOrOAuth,
} from "@src/confluent/tools/connection-predicates.js";
import {
  type ProcessedMessage,
  processMessage,
  type SchemaLookupCache,
  schemaRegistryOptions,
} from "@src/confluent/tools/handlers/kafka/message-processing.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { logger } from "@src/logger.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { z } from "zod";

export const searchMessagesArgs = z.object({
  topicNames: z
    .array(z.string().min(1))
    .nonempty()
    .describe("Kafka topic name(s) to search. Searches every partition."),
  query: z
    .string()
    .min(1)
    .describe(
      "The search term to look for. Interpreted as a case-insensitive " +
        "substring by default, or as a regular expression when " +
        "`queryMode` is 'regex' (e.g. 'checkout.*failed' or the " +
        "regex-literal form '/checkout.*failed/i' to pass flags).",
    ),
  queryMode: z
    .enum(["substring", "regex"])
    .optional()
    .default("substring")
    .describe(
      "How to interpret `query`. 'substring' (default) does a " +
        "case-insensitive substring match; 'regex' compiles `query` as a " +
        "JavaScript RegExp — either a bare pattern ('checkout.*failed') or " +
        "regex-literal syntax with flags ('/checkout.*failed/i'). Invalid " +
        "patterns are rejected up front.",
    ),
  searchIn: z
    .array(z.enum(["key", "value", "headers"]))
    .nonempty()
    .optional()
    .default(["value"])
    .describe(
      "Which parts of each message to match against. Defaults to " +
        "['value']. For 'headers', both header names and string-coerced " +
        "header values are matched.",
    ),
  maxMatches: z
    .number()
    .int()
    .positive()
    .optional()
    .default(10)
    .describe("Stop once this many matching messages have been found."),
  maxScanned: z
    .number()
    .int()
    .positive()
    .optional()
    .default(1000)
    .describe(
      "Upper bound on the number of messages scanned, even if no match is " +
        "found — guards against runaway scans on busy topics.",
    ),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .default(10000)
    .describe(
      "Maximum time in milliseconds to spend scanning before stopping.",
    ),
  valueFormat: schemaRegistryOptions.describe(
    "VALUE format. Default: auto-decode via Schema Registry when configured. " +
      "Set `disableSchemaRegistry: true` for raw UTF-8. Matching runs " +
      "against the decoded representation.",
  ),
  keyFormat: schemaRegistryOptions.describe(
    "KEY format. Default: auto-decode via Schema Registry when configured. " +
      "Set `disableSchemaRegistry: true` for raw UTF-8. Matching runs " +
      "against the decoded representation.",
  ),
  cluster_id: z
    .string()
    .optional()
    .describe(
      "Confluent Cloud logical Kafka cluster ID (lkc-...). Discover via list-clusters.",
    ),
  environment_id: z
    .string()
    .optional()
    .describe(
      "Confluent Cloud environment ID (env-...) that owns the cluster. Discover via list-environments.",
    ),
});

type SearchIn = z.infer<typeof searchMessagesArgs>["searchIn"][number];

/**
 * A predicate that tests a single string against the caller's `query`.
 * Built once per call by {@link buildMatcher}; substring mode lowercases
 * both sides for case-insensitivity, regex mode delegates to a compiled
 * `RegExp`.
 */
type Matcher = (text: string) => boolean;

/**
 * Matches a regex-literal-shaped query: `/pattern/flags` (flags optional).
 * Capture 1 is the pattern body, capture 2 the flag string. The body uses
 * a greedy `.+`, so it extends to the LAST `/` (backtracking from the end);
 * that lets an embedded `/` inside the pattern (e.g. `/a\/b/i`) stay part of
 * the body while the final `/flags` segment remains the boundary.
 */
const REGEX_LITERAL = /^\/(.+)\/([a-z]*)$/;

/**
 * Compile the caller's `query`/`queryMode` into a {@link Matcher}. Regex
 * mode accepts either a bare pattern (`checkout.*failed`) or JavaScript
 * regex-literal syntax with flags (`/checkout.*failed/i`) — the latter is
 * how the issue's examples are written and is the only way to pass flags
 * such as case-insensitivity. An invalid pattern throws here so the handler
 * can reject up front with a clear error rather than crashing mid-consume.
 */
export function buildMatcher(
  query: string,
  queryMode: "substring" | "regex",
): Matcher {
  if (queryMode === "regex") {
    const literal = REGEX_LITERAL.exec(query);
    // When `literal` matches, group 1 (the pattern body) is always present;
    // `?? query` only satisfies type narrowing. Group 2 (flags) may be an
    // empty string, which `RegExp` accepts.
    const re = literal
      ? new RegExp(literal[1] ?? query, literal[2])
      : new RegExp(query);
    return (text) => re.test(text);
  }
  const needle = query.toLowerCase();
  return (text) => text.toLowerCase().includes(needle);
}

/**
 * Coerce a deserialized key/value into a searchable string. Strings pass
 * through unchanged so substring/regex matching sees exactly what the
 * caller would read; everything else (decoded AVRO/JSON/PROTOBUF objects,
 * numbers, booleans) is JSON-stringified. `undefined`/`null` payloads
 * (tombstones, absent keys) contribute no searchable text.
 */
function stringifyForSearch(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  // Decoded values are arbitrary (AVRO/JSON/PROTOBUF objects, numbers,
  // booleans). `JSON.stringify` throws on a BigInt and on a cyclic structure;
  // an uncaught throw here would reject the whole `eachMessage` callback and
  // fail the entire search. Fall back to `String(value)` so one degenerate
  // record can't sink the call (BigInt stringifies cleanly; a cyclic object
  // degrades to `"[object Object]"`).
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Collect every string from a processed message that the requested
 * `searchIn` parts expose. For 'headers', both the header name and each
 * string-coerced header value are included so a caller can match on either.
 */
function collectSearchableStrings(
  processed: ProcessedMessage,
  searchIn: SearchIn[],
): string[] {
  const strings: string[] = [];
  for (const part of searchIn) {
    if (part === "value") {
      const text = stringifyForSearch(processed.value);
      if (text !== undefined) strings.push(text);
    } else if (part === "key") {
      const text = stringifyForSearch(processed.key);
      if (text !== undefined) strings.push(text);
    } else if (part === "headers" && processed.headers) {
      for (const [name, value] of Object.entries(processed.headers)) {
        strings.push(name);
        if (Array.isArray(value)) strings.push(...value);
        else strings.push(value);
      }
    }
  }
  return strings;
}

/**
 * True when any of the message's searchable strings (per `searchIn`) match
 * the caller's query.
 */
export function messageMatches(
  processed: ProcessedMessage,
  matcher: Matcher,
  searchIn: SearchIn[],
): boolean {
  return collectSearchableStrings(processed, searchIn).some(matcher);
}

/**
 * Handler for full-text search across the messages of one or more Kafka
 * topics. Unlike `consume-messages`, which returns a window of records for
 * the AI assistant to scan, this tool pushes the filter down: it scans up
 * to `maxScanned` messages from earliest across every partition and returns
 * only the (up to `maxMatches`) records whose decoded key/value/headers
 * match the query. Reuses the same Schema Registry deserialization path as
 * `consume-messages` (see {@link processMessage}) so matching runs against
 * the decoded representation, not raw bytes.
 */
export class SearchMessagesHandler extends BaseToolHandler {
  /**
   * Search one or more Kafka topics. Resolves when one of four exit
   * conditions wins a `Promise.race`: `maxMatches` matches collected,
   * `maxScanned` messages scanned, the `timeoutMs` budget elapses, or
   * `consumer.run()` rejects. On the bounded-exit paths the matches found
   * so far are returned (success-shaped response).
   *
   * @param runtime - The {@link ServerRuntime} supplied by the dispatcher.
   * @param toolArguments - Raw tool arguments; parsed with
   *   `searchMessagesArgs` to apply defaults. `resolveConnection`
   *   reads `connectionId` off this unparsed object.
   */
  async handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const parsed = searchMessagesArgs.parse(toolArguments);
    const {
      query,
      queryMode,
      searchIn,
      maxMatches,
      maxScanned,
      timeoutMs,
      valueFormat,
      keyFormat,
    } = parsed;
    // Deduplicate before subscribing — a repeated topic name would otherwise
    // create redundant subscription entries. Mirrors `consume-messages`.
    const topicNames = [...new Set(parsed.topicNames)];

    // Reject an invalid regex up front so we never build a consumer just to
    // crash on the first record.
    let matcher: Matcher;
    try {
      matcher = buildMatcher(query, queryMode);
    } catch (error: unknown) {
      return this.createResponse(
        `Invalid regex query: ${formatKafkaError(error)}`,
        true,
      );
    }

    const { connId, conn, clientManager } = this.resolveConnection(
      runtime,
      toolArguments,
    );
    const resolved = resolveKafkaClusterArgs(parsed, runtime, connId);

    // Auto-decode when SR is reachable on this connection and the caller
    // hasn't opted out on BOTH sides. Either side wanting decode triggers
    // the SR fetch. Mirrors `consume-messages`.
    const userDisabled =
      (valueFormat.disableSchemaRegistry ?? false) &&
      (keyFormat.disableSchemaRegistry ?? false);
    const srReachable = hasSchemaRegistryOrOAuth(conn).enabled;

    let registry: SchemaRegistryClient | undefined;
    if (!userDisabled && srReachable) {
      try {
        registry = await clientManager.getSchemaRegistrySdkClient(
          resolved.envId,
        );
      } catch (error: unknown) {
        // Graceful fallback: user didn't explicitly opt in, so an
        // SR-transport failure shouldn't fail an otherwise-satisfiable
        // search. Per-message decode errors already fall back to raw inside
        // processMessage.
        logger.warn(
          { error, connId },
          "Schema Registry client unavailable; searching raw bytes.",
        );
      }
    }

    const matches: ProcessedMessage[] = [];
    let scanned = 0;
    // Synchronous gate that suppresses further processing once any terminal
    // condition fires; a boolean (not a Promise) because eachMessage must
    // check it on arrival rather than await.
    let accepting = true;
    let consumer: KafkaJS.Consumer | undefined;
    // Memoize the per-subject latest-schema lookup for the life of this
    // search. Without it, scanning up to `maxScanned` (default 1000) records
    // would issue a `getLatestSchemaMetadata` round-trip per record per side;
    // the schema is stable over the scan window, so one lookup per subject
    // suffices. Scoped to this call so a later search re-checks the schema.
    const schemaCache: SchemaLookupCache = new Map();

    try {
      consumer = await clientManager.buildKafkaConsumer({
        clusterId: resolved.clusterId,
        envId: resolved.envId,
        // Per-invocation unique group id: each search call is the sole
        // member of its own consumer group, so concurrent calls can't race
        // for a partition assignment. Matches `consume-messages`.
        groupId: nodeCrypto.randomUUID(),
        offsetReset: "earliest",
      });
      await consumer.connect();
      await consumer.subscribe({ topics: topicNames });

      const bounded = Promise.withResolvers<void>();
      const timedOut = Promise.withResolvers<void>();
      const consumerActive = consumer;

      const eachMessage = async ({
        topic,
        partition,
        message,
      }: {
        topic: string;
        partition: number;
        message: Parameters<typeof processMessage>[2];
      }): Promise<void> => {
        if (!accepting) return;
        scanned++;
        const processed = await processMessage(
          topic,
          partition,
          message,
          registry,
          valueFormat,
          keyFormat,
          schemaCache,
        );
        if (messageMatches(processed, matcher, searchIn)) {
          matches.push(processed);
        }
        if (matches.length >= maxMatches || scanned >= maxScanned) {
          accepting = false;
          bounded.resolve();
        }
      };

      const timer = setTimeout(() => {
        accepting = false;
        timedOut.resolve();
      }, timeoutMs);

      const runPromise = consumerActive.run({ eachMessage });

      try {
        await Promise.race([
          bounded.promise,
          timedOut.promise,
          // Success of `run` means "engine still running" — only its
          // rejection is a terminal condition for the race.
          runPromise.then(() => new Promise<never>(() => {})),
        ]);
      } finally {
        clearTimeout(timer);
        accepting = false;
      }

      return this.createResponse(
        `Found ${matches.length} matches in ${scanned} scanned messages from topics ${topicNames.join(", ")}.\n` +
          `Matches: ${JSON.stringify(matches, null, 2)}`,
        false,
      );
    } catch (error: unknown) {
      return this.createResponse(
        `Failed to search messages: ${formatKafkaError(error)}`,
        true,
      );
    } finally {
      if (consumer) {
        try {
          await consumer.disconnect();
        } catch (error) {
          logger.error({ error }, "Error cleaning up consumer");
        }
      }
    }
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.SEARCH_MESSAGES,
      description:
        "Full-text search across the messages of one or more Kafka topics. " +
        "Scans up to `maxScanned` messages from earliest across every " +
        "partition and returns only the messages whose decoded " +
        "key/value/headers match `query` (substring or regex). " +
        "Auto-deserializes Schema Registry messages (AVRO/JSON/PROTOBUF) " +
        "when SR is configured; matching runs against the decoded form. " +
        "Use this instead of repeatedly calling consume-messages + scanning.",
      inputSchema: searchMessagesArgs.shape,
      annotations: READ_ONLY,
    };
  }

  readonly category = ToolCategory.Kafka;
  readonly predicate = kafkaBootstrapOrOAuth;
}
