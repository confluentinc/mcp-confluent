import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export type CallToolResult = z.infer<typeof CallToolResultSchema>;
