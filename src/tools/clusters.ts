import { z } from "zod";
import { ToolConfig } from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";

export const getClustersTool: ToolConfig = {
  name: ToolName.LIST_CLUSTERS,
  description: "Get all clusters in the Confluent Cloud environment",
  inputSchema: {
    environmentId: z
      .string()
      .optional()
      .describe("The environment ID to filter clusters by"),
  },
};
