import {
  CallToolResultSchema,
  ToolSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export type CallToolResult = z.infer<typeof CallToolResultSchema>;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const ToolInputSchema = ToolSchema.shape.inputSchema;
