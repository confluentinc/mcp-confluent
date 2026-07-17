import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  READ_ONLY,
  ToolCategory,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { hasConfluentCloudOrOAuth } from "@src/confluent/tools/connection-predicates.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { logger } from "@src/logger.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { z } from "zod";

const BILLING_RANGE_MAX_DAYS = 31;
const MS_PER_DAY = 86_400_000;

const listBillingCostsObject = z.object({
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

const listBillingCostsArguments = listBillingCostsObject
  .refine(
    ({ startDate, endDate }) =>
      Number.isFinite(Date.parse(startDate)) &&
      Number.isFinite(Date.parse(endDate)),
    {
      error: (issue) => {
        const { startDate, endDate } = issue.input as {
          startDate: string;
          endDate: string;
        };
        const invalid = Number.isFinite(Date.parse(startDate))
          ? `endDate=${endDate}`
          : `startDate=${startDate}`;
        return `Date must be a valid calendar date (got ${invalid}).`;
      },
      path: ["endDate"],
    },
  )
  .refine(
    ({ startDate, endDate }) => Date.parse(endDate) >= Date.parse(startDate),
    {
      error: (issue) => {
        const { startDate, endDate } = issue.input as {
          startDate: string;
          endDate: string;
        };
        return `endDate (${endDate}) must be on or after startDate (${startDate}).`;
      },
      path: ["endDate"],
    },
  )
  .refine(
    ({ startDate, endDate }) => {
      const diffDays =
        (Date.parse(endDate) - Date.parse(startDate)) / MS_PER_DAY;
      return diffDays <= BILLING_RANGE_MAX_DAYS;
    },
    {
      error: (issue) => {
        const { startDate, endDate } = issue.input as {
          startDate: string;
          endDate: string;
        };
        const diffDays =
          (Date.parse(endDate) - Date.parse(startDate)) / MS_PER_DAY;
        return `Date range must be ${BILLING_RANGE_MAX_DAYS} days or fewer (got ${diffDays} days). The CCloud billing API caps queries at ${BILLING_RANGE_MAX_DAYS} days.`;
      },
      path: ["endDate"],
    },
  );

/**
 * Schema for validating billing cost line items
 */
const costLineItemSchema = z.object({
  start_date: z.string(),
  end_date: z.string(),
  product: z.string(),
  type: z.string().optional(),
  price: z.number().optional(),
  unit: z.string().optional(),
  quantity: z.number().optional(),
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
type BillingCostsMetadata = BillingCostsList["metadata"];

export class ListBillingCostsHandler extends BaseToolHandler {
  async handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const { startDate, endDate, pageSize, pageToken } =
      listBillingCostsArguments.parse(toolArguments);
    const { clientManager } = this.resolveConnection(runtime, toolArguments);

    try {
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

      return this.renderCostsResponse(response, startDate, endDate);
    } catch (error) {
      logger.error({ error }, "Error in ListBillingCostsHandler");
      return this.createResponse(
        `Failed to fetch billing costs: ${error instanceof Error ? error.message : String(error)}`,
        true,
        { error: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  /**
   * Validate the raw costs payload and turn it into the tool's text + structured
   * response, or an error response when the payload fails schema validation.
   */
  private renderCostsResponse(
    response: unknown,
    startDate: string,
    endDate: string,
  ): CallToolResult {
    try {
      const validatedResponse = billingCostsSchema.parse(
        response,
      ) as BillingCostsList;

      const {
        productCosts,
        totalAmount,
        totalOriginalAmount,
        totalDiscountAmount,
      } = summarizeCosts(validatedResponse.data);

      const costSummary = `
Cost Summary (${startDate} to ${endDate}):
  Total Amount: $${totalAmount.toFixed(2)}
  Original Amount: $${totalOriginalAmount.toFixed(2)}
  Total Discount: $${totalDiscountAmount.toFixed(2)}
  Total Line Items: ${validatedResponse.data.length}
`;
      const productBreakdown = formatProductBreakdown(productCosts);
      const metadata = validatedResponse.metadata;
      const paginationInfo = formatPaginationSection(metadata);

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
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.LIST_BILLING_COSTS,
      description:
        "Retrieve billing cost data for a Confluent Cloud organization within a specified date range with pagination support",
      inputSchema: listBillingCostsObject.shape,
      annotations: READ_ONLY,
    };
  }
  readonly category = ToolCategory.Billing;
  readonly predicate = hasConfluentCloudOrOAuth;
}

/**
 * Running totals plus per-product amounts accumulated across billing line items.
 */
interface CostTotals {
  productCosts: Map<string, number>;
  totalAmount: number;
  totalOriginalAmount: number;
  totalDiscountAmount: number;
}

/**
 * Sum line-item amounts and bucket them by product in a single pass.
 */
function summarizeCosts(data: BillingCostsList["data"]): CostTotals {
  const productCosts = new Map<string, number>();
  let totalAmount = 0;
  let totalOriginalAmount = 0;
  let totalDiscountAmount = 0;

  for (const item of data) {
    totalAmount += item.amount;
    totalOriginalAmount += item.original_amount;
    totalDiscountAmount += item.discount_amount ?? 0;
    productCosts.set(
      item.product,
      (productCosts.get(item.product) ?? 0) + item.amount,
    );
  }

  return {
    productCosts,
    totalAmount,
    totalOriginalAmount,
    totalDiscountAmount,
  };
}

/**
 * Render the product-breakdown section, highest amount first; empty string when
 * there are no products so the summary text collapses cleanly.
 */
function formatProductBreakdown(productCosts: Map<string, number>): string {
  if (productCosts.size === 0) {
    return "";
  }
  const lines = Array.from(productCosts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([product, amount]) => `  ${product}: $${amount.toFixed(2)}`)
    .join("\n");
  return `
Product Breakdown:
${lines}
`;
}

/**
 * Render the pagination section, omitting individual rows whose value is absent.
 * Empty string when the response carried no metadata block at all.
 */
function formatPaginationSection(metadata: BillingCostsMetadata): string {
  if (!metadata) {
    return "";
  }
  const rows: ReadonlyArray<[string, string | number | undefined]> = [
    ["Total Items", metadata.total_size],
    ["First Page", metadata.first],
    ["Last Page", metadata.last],
    ["Previous Page", metadata.prev],
    ["Next Page", metadata.next],
  ];
  const body = rows
    .filter(([, value]) => Boolean(value))
    .map(([label, value]) => `\n  ${label}: ${value}`)
    .join("");
  return `
Pagination:${body}
`;
}
