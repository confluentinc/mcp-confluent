/**
 * Render a list of ids as a double-quoted, comma-separated string for prose
 * (tool descriptions, error messages). The quoting keeps the list unambiguous
 * when an id contains a comma; contained double quotes are backslash-escaped so
 * the wrapping itself stays unambiguous. Returns "" for an empty list, so a
 * caller wanting a placeholder can write `quoteJoinIds(ids) || "none"`.
 */
export function quoteJoinIds(ids: readonly string[]): string {
  return ids.map((id) => `"${id.replaceAll('"', '\\"')}"`).join(", ");
}
