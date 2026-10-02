import { ZodError } from "zod";

/**
 * Thrown when a tool call is missing a required identifier that only the
 * caller (or their connection config) can supply -- e.g. a resource id with
 * no config fallback under an OAuth connection, or a required field absent
 * from both the tool argument and the direct connection's config block.
 *
 * Distinguished from a plain `Error` so the tool-call wrapper in
 * `mcp/server.ts` can skip reporting it to crash reporting: it's an
 * expected, caller-correctable input error -- not an unexpected fault in
 * the server itself.
 */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

/** True for caller-correctable input errors -- skip reporting these to crash reporting. */
export function isExpectedToolError(error: unknown): boolean {
  return error instanceof ZodError || error instanceof ToolInputError;
}
