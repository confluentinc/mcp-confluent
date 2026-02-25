import { ClientManager } from "@src/confluent/client-manager.js";
import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { EnvVar } from "@src/env-schema.js";
import env from "@src/env.js";
import { logger } from "@src/logger.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { z } from "zod";

const listBillingCostsArguments = z.object({
  baseUrl: z
    .string()
    .describe("The base URL of the Confluent Cloud REST API.")
    .url()
    .default(() => env.CONFLUENT_CLOUD_REST_ENDPOINT ?? "")
    .optional(),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format")
    .describe("Start date for billing costs in YYYY-MM-DD format"),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format")
    .describe("End date for billing costs in YYYY-MM-DD format"),
  pageSize: z
    .number()
    .int()
    .positive()
    .max(1000)
    .optional()
    .describe("Number of results per page (max 1000)"),
  pageToken: z
    .string()
    .optional()
    .describe("Token for the next page of results"),
});

/**
 * Schema for validating billing cost line items
 */
const costLineItemSchema = z.object({
  start_date: z.string(),
  end_date: z.string(),
  product: z.string(),
  type: z.string().optional(),
  price: z.number(),
  unit: z.string(),
  quantity: z.number(),
  original_amount: z.number(),
  discount_amount: z.number().optional(),
  amount: z.number(),
  network_access_type: z.string().optional(),
});

/**
 * Schema for validating Confluent Cloud billing costs responses
 */
const billingCostsSchema = z.object({
  api_version: z.literal("v1"),
  kind: z.literal("CostList"),
  metadata: z
    .object({
      first: z.string().optional(),
      last: z.string().optional(),
      prev: z.string().optional(),
      next: z.string().optional(),
      total_size: z.number().optional(),
    })
    .optional(),
  data: z.array(costLineItemSchema),
});

type BillingCostsList = z.infer<typeof billingCostsSchema>;

export class ListBillingCostsHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const { baseUrl, startDate, endDate, pageSize, pageToken } =
      listBillingCostsArguments.parse(toolArguments);

    try {
      if (baseUrl !== undefined && baseUrl !== "") {
        clientManager.setConfluentCloudRestEndpoint(baseUrl);
      }

      const pathBasedClient = wrapAsPathBasedClient(
        clientManager.getConfluentCloudRestClient(),
      );

      const { data: response, error } = await pathBasedClient[
        "/billing/v1/costs"
      ].GET({
        params: {
          query: {
            start_date: startDate,
            end_date: endDate,
            page_size: pageSize,
            page_token: pageToken,
          },
        },
      });

      if (error) {
        logger.error({ error }, "API Error");
        return this.createResponse(
          `Failed to fetch billing costs: ${JSON.stringify(error)}`,
          true,
          { error },
        );
      }

      try {
        const validatedResponse = billingCostsSchema.parse(
          response,
        ) as BillingCostsList;

        // Calculate totals and group by product
        const productCosts = new Map<string, number>();
        let totalAmount = 0;
        let totalOriginalAmount = 0;
        let totalDiscountAmount = 0;

        validatedResponse.data.forEach((item) => {
          totalAmount += item.amount;
          totalOriginalAmount += item.original_amount;
          totalDiscountAmount += item.discount_amount || 0;

          const currentProductCost = productCosts.get(item.product) || 0;
          productCosts.set(item.product, currentProductCost + item.amount);
        });

        // Format cost details for display
        const costSummary = `
Cost Summary (${startDate} to ${endDate}):
  Total Amount: $${totalAmount.toFixed(2)}
  Original Amount: $${totalOriginalAmount.toFixed(2)}
  Total Discount: $${totalDiscountAmount.toFixed(2)}
  Total Line Items: ${validatedResponse.data.length}
`;

        const productBreakdown =
          productCosts.size > 0
            ? `
Product Breakdown:
${Array.from(productCosts.entries())
  .sort((a, b) => b[1] - a[1])
  .map(([product, amount]) => `  ${product}: $${amount.toFixed(2)}`)
  .join("\n")}
`
            : "";

        const metadata = validatedResponse.metadata;
        const paginationInfo = metadata
          ? `
Pagination:${metadata.total_size ? `\n  Total Items: ${metadata.total_size}` : ""}${metadata.first ? `\n  First Page: ${metadata.first}` : ""}${metadata.last ? `\n  Last Page: ${metadata.last}` : ""}${metadata.prev ? `\n  Previous Page: ${metadata.prev}` : ""}${metadata.next ? `\n  Next Page: ${metadata.next}` : ""}
`
          : "";

        return this.createResponse(
          `Successfully retrieved billing costs:\n${costSummary}${productBreakdown}${paginationInfo}`,
          false,
          {
            costs: validatedResponse.data,
            summary: {
              total_amount: totalAmount,
              original_amount: totalOriginalAmount,
              discount_amount: totalDiscountAmount,
              line_item_count: validatedResponse.data.length,
              date_range: {
                start: startDate,
                end: endDate,
              },
            },
            product_breakdown: Object.fromEntries(productCosts),
            total: metadata?.total_size,
            pagination: metadata
              ? {
                  first: metadata.first,
                  last: metadata.last,
                  prev: metadata.prev,
                  next: metadata.next,
                }
              : undefined,
          },
        );
      } catch (validationError) {
        logger.error(
          { error: validationError },
          "Billing costs validation error",
        );
        return this.createResponse(
          `Invalid billing costs data: ${validationError instanceof Error ? validationError.message : String(validationError)}`,
          true,
          { error: validationError },
        );
      }
    } catch (error) {
      logger.error({ error }, "Error in ListBillingCostsHandler");
      return this.createResponse(
        `Failed to fetch billing costs: ${error instanceof Error ? error.message : String(error)}`,
        true,
        { error: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.LIST_BILLING_COSTS,
      description:
        "Retrieve billing cost data for a Confluent Cloud organization within a specified date range with pagination support",
      inputSchema: listBillingCostsArguments.shape,
    };
  }

  getRequiredEnvVars(): EnvVar[] {
    return ["CONFLUENT_CLOUD_API_KEY", "CONFLUENT_CLOUD_API_SECRET"];
  }

  isConfluentCloudOnly(): boolean {
    return true;
  }
}
