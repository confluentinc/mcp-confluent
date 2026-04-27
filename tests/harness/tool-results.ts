import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

/** The exact return type of {@linkcode Client.callTool}. The SDK signature
 *  doesn't narrow based on the optional `resultSchema` argument, so this is
 *  the discriminated union of the current `CallToolResult` shape and the
 *  legacy `CompatibilityCallToolResult` shape with `toolResult` instead of
 *  `content`. */
type CallToolResponse = Awaited<ReturnType<Client["callTool"]>>;

/**
 * Concatenates all text-typed content blocks from a tool call result. Empty
 * string when there are no text blocks, or when the response is the legacy
 * compatibility shape with no `content` field at all.
 *
 * Pair this with passing `CallToolResultSchema` as the second argument to
 * `client.callTool()` — that makes the SDK throw on schema-non-conforming
 * payloads at the source, so a real protocol regression surfaces as a thrown
 * error rather than a silent empty string here.
 *
 * @example
 * ```ts
 * const result = await client.callTool(
 *   { name: ToolName.LIST_TOPICS, arguments: {} },
 *   CallToolResultSchema,
 * );
 * expect(textContent(result)).toMatch(/^Kafka topics:/);
 * ```
 */
export function textContent(result: CallToolResponse): string {
  if (!Array.isArray(result.content)) return "";
  return result.content
    .flatMap((c) => (c.type === "text" ? [c.text] : []))
    .join("");
}
