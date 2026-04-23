import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

/**
 * Extracts and concatenates all text-typed content blocks from a tool call result.
 *
 * Validates against {@linkcode CallToolResultSchema} to narrow the discriminated
 * union without a hand-rolled type predicate. Returns an empty string on invalid
 * input, which covers the legacy `CompatibilityCallToolResult` variant that has
 * `toolResult` instead of `content`.
 */
export function textContent(result: unknown): string {
  const parsed = CallToolResultSchema.safeParse(result);
  if (!parsed.success) return "";
  return parsed.data.content
    .flatMap((c) => (c.type === "text" ? [c.text] : []))
    .join("");
}
