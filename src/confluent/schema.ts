import type { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";

export type CallToolResult = z.infer<typeof CallToolResultSchema>;
