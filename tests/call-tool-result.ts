import type { CallToolResult } from "@src/confluent/schema.js";

/**
 * Flatten the text segments of a {@link CallToolResult} into a single string.
 * Non-text content parts contribute nothing, so an all-image result yields "".
 */
export function textOf(result: CallToolResult): string {
  return result.content.map((c) => ("text" in c ? c.text : "")).join("");
}
