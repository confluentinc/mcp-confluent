import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export type CallToolResult = z.infer<typeof CallToolResultSchema>;

export const SerializerType = {
  AVRO: "AVRO",
  JSON: "JSON",
  PROTOBUF: "PROTOBUF",
} as const;

export type SerializerTypeKey = keyof typeof SerializerType;
