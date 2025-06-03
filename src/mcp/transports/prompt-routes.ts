import {
  PromptFactory,
  PromptMetadata,
} from "@src/confluent/prompts/prompt-factory.js";
import { PromptName } from "@src/confluent/prompts/prompt-name.js";
import { logger } from "@src/logger.js";
import { FastifyInstance } from "fastify";

/**
 * Registers routes related to prompt discovery
 */
export function registerPromptRoutes(fastify: FastifyInstance): void {
  // GET endpoint to list all available prompts
  fastify.get(
    "/api/prompts",
    {
      schema: {
        tags: ["prompts"],
        summary: "List all available prompts",
        description:
          "Returns metadata about all available prompts in the MCP server",
        response: {
          200: {
            type: "object",
            properties: {
              prompts: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    description: { type: "string" },
                    arguments: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          name: { type: "string" },
                          description: { type: "string" },
                          required: { type: "boolean" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    async () => {
      try {
        const promptMetadata: PromptMetadata[] =
          PromptFactory.getPromptMetadata();
        return { prompts: promptMetadata };
      } catch (error) {
        logger.error({ error }, "Error while fetching prompt metadata");
        throw error;
      }
    },
  );

  // GET endpoint to get details about a specific prompt
  fastify.get(
    "/api/prompts/:name",
    {
      schema: {
        tags: ["prompts"],
        summary: "Get a specific prompt",
        description: "Returns metadata about a specific prompt",
        params: {
          type: "object",
          properties: {
            name: { type: "string" },
          },
          required: ["name"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              name: { type: "string" },
              description: { type: "string" },
              arguments: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    description: { type: "string" },
                    required: { type: "boolean" },
                  },
                },
              },
            },
          },
          404: {
            type: "object",
            properties: {
              error: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const { name } = request.params as { name: string };
        const promptHandler = PromptFactory.getPromptHandler(
          name as PromptName,
        );

        if (!promptHandler) {
          reply.code(404);
          return {
            error: "NOT_FOUND",
            message: `Prompt with name "${name}" not found`,
          };
        }

        const config = promptHandler.getPromptConfig();
        return {
          name: config.name,
          description: config.description,
          arguments: config.arguments || [],
        };
      } catch (error) {
        logger.error({ error }, "Error while fetching prompt metadata");
        throw error;
      }
    },
  );
}
