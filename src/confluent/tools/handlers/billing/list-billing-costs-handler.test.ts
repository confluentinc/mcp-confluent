import { ListBillingCostsHandler } from "@src/confluent/tools/handlers/billing/list-billing-costs-handler.js";
import {
  CCLOUD_CONN,
  DEFAULT_CONNECTION_ID,
  runtimeWith,
} from "@tests/factories/runtime.js";
import { getMockedClientManager } from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

const VALID_ARGS = { startDate: "2026-01-01", endDate: "2026-01-31" };

function responseText(result: { content: Array<{ text?: string }> }): string {
  return result.content.map((c) => c.text ?? "").join("");
}

describe("list-billing-costs-handler.ts", () => {
  describe("ListBillingCostsHandler", () => {
    const handler = new ListBillingCostsHandler();

    describe("getToolConfig()", () => {
      it("should describe the list-billing-costs tool as read-only", () => {
        const config = handler.getToolConfig();
        expect(config.name).toBe("list-billing-costs");
        expect(config.description).toContain("billing cost data");
        expect(config.inputSchema).toHaveProperty("startDate");
        expect(config.inputSchema).toHaveProperty("endDate");
        expect(config.annotations?.readOnlyHint).toBe(true);
      });
    });

    describe("handle()", () => {
      it("should aggregate line items, sort product breakdown by amount desc, and surface totals in _meta", async () => {
        const clientManager = getMockedClientManager();
        clientManager.getConfluentCloudRestClient().GET.mockResolvedValue({
          data: {
            api_version: "v1",
            kind: "CostList",
            data: [
              {
                start_date: "2026-01-01",
                end_date: "2026-01-02",
                product: "KAFKA",
                original_amount: 50,
                discount_amount: 10,
                amount: 40,
              },
              {
                start_date: "2026-01-01",
                end_date: "2026-01-02",
                product: "KAFKA",
                original_amount: 25,
                discount_amount: 5,
                amount: 20,
              },
              {
                start_date: "2026-01-01",
                end_date: "2026-01-02",
                product: "FLINK",
                original_amount: 100,
                amount: 100,
              },
            ],
          },
        });

        const result = await handler.handle(
          runtimeWith(CCLOUD_CONN, DEFAULT_CONNECTION_ID, clientManager),
          VALID_ARGS,
          undefined,
        );

        const text = responseText(result);
        expect(result.isError).toBe(false);
        expect(text).toContain("Total Amount: $160.00");
        expect(text).toContain("Original Amount: $175.00");
        expect(text).toContain("Total Discount: $15.00");
        expect(text).toContain("Total Line Items: 3");

        const breakdownSection = text.slice(text.indexOf("Product Breakdown:"));
        const flinkIdx = breakdownSection.indexOf("FLINK");
        const kafkaIdx = breakdownSection.indexOf("KAFKA");
        expect(flinkIdx).toBeGreaterThan(-1);
        expect(kafkaIdx).toBeGreaterThan(-1);
        expect(flinkIdx).toBeLessThan(kafkaIdx);
        expect(breakdownSection).toContain("FLINK: $100.00");
        expect(breakdownSection).toContain("KAFKA: $60.00");

        expect(result._meta).toMatchObject({
          summary: {
            total_amount: 160,
            original_amount: 175,
            discount_amount: 15,
            line_item_count: 3,
            date_range: { start: "2026-01-01", end: "2026-01-31" },
          },
          product_breakdown: { KAFKA: 60, FLINK: 100 },
          total: undefined,
          pagination: undefined,
        });
        const meta = result._meta as { costs: unknown[] };
        expect(meta.costs).toHaveLength(3);
      });

      it("should omit the product breakdown section when data is empty", async () => {
        const clientManager = getMockedClientManager();
        clientManager.getConfluentCloudRestClient().GET.mockResolvedValue({
          data: { api_version: "v1", kind: "CostList", data: [] },
        });

        const result = await handler.handle(
          runtimeWith(CCLOUD_CONN, DEFAULT_CONNECTION_ID, clientManager),
          VALID_ARGS,
          undefined,
        );

        const text = responseText(result);
        expect(result.isError).toBe(false);
        expect(text).toContain("Total Line Items: 0");
        expect(text).not.toContain("Product Breakdown");
        expect(result._meta).toMatchObject({
          summary: { line_item_count: 0, total_amount: 0 },
          product_breakdown: {},
          pagination: undefined,
        });
      });

      it("should render a pagination section and populate _meta.pagination when metadata is present", async () => {
        const clientManager = getMockedClientManager();
        clientManager.getConfluentCloudRestClient().GET.mockResolvedValue({
          data: {
            api_version: "v1",
            kind: "CostList",
            metadata: {
              first: "https://api/page?first",
              last: "https://api/page?last",
              prev: "https://api/page?prev",
              next: "https://api/page?next",
              total_size: 42,
            },
            data: [],
          },
        });

        const result = await handler.handle(
          runtimeWith(CCLOUD_CONN, DEFAULT_CONNECTION_ID, clientManager),
          VALID_ARGS,
          undefined,
        );

        const text = responseText(result);
        expect(result.isError).toBe(false);
        expect(text).toContain("Pagination:");
        expect(text).toContain("Total Items: 42");
        expect(text).toContain("First Page: https://api/page?first");
        expect(text).toContain("Last Page: https://api/page?last");
        expect(text).toContain("Previous Page: https://api/page?prev");
        expect(text).toContain("Next Page: https://api/page?next");
        expect(result._meta).toMatchObject({
          total: 42,
          pagination: {
            first: "https://api/page?first",
            last: "https://api/page?last",
            prev: "https://api/page?prev",
            next: "https://api/page?next",
          },
        });
      });

      it("should omit the pagination section and leave _meta.pagination undefined when metadata is absent", async () => {
        const clientManager = getMockedClientManager();
        clientManager.getConfluentCloudRestClient().GET.mockResolvedValue({
          data: { api_version: "v1", kind: "CostList", data: [] },
        });

        const result = await handler.handle(
          runtimeWith(CCLOUD_CONN, DEFAULT_CONNECTION_ID, clientManager),
          VALID_ARGS,
          undefined,
        );

        const text = responseText(result);
        expect(result.isError).toBe(false);
        expect(text).not.toContain("Pagination:");
        expect(result._meta).toMatchObject({
          pagination: undefined,
          total: undefined,
        });
      });

      it("should return an error response when the API responds with { error }", async () => {
        const clientManager = getMockedClientManager();
        const apiError = { status: 403, message: "forbidden" };
        clientManager
          .getConfluentCloudRestClient()
          .GET.mockResolvedValue({ error: apiError });

        const result = await handler.handle(
          runtimeWith(CCLOUD_CONN, DEFAULT_CONNECTION_ID, clientManager),
          VALID_ARGS,
          undefined,
        );

        expect(result.isError).toBe(true);
        expect(responseText(result)).toContain("Failed to fetch billing costs");
        expect(responseText(result)).toContain("forbidden");
        expect(result._meta).toEqual({ error: apiError });
      });

      it("should return a validation-error response when the response fails schema parsing", async () => {
        const clientManager = getMockedClientManager();
        clientManager.getConfluentCloudRestClient().GET.mockResolvedValue({
          data: { api_version: "v1", kind: "NotACostList", data: [] },
        });

        const result = await handler.handle(
          runtimeWith(CCLOUD_CONN, DEFAULT_CONNECTION_ID, clientManager),
          VALID_ARGS,
          undefined,
        );

        expect(result.isError).toBe(true);
        expect(responseText(result)).toContain("Invalid billing costs data");
        expect(result._meta).toBeDefined();
        expect((result._meta as { error: unknown }).error).toBeInstanceOf(
          ZodError,
        );
      });

      it("should return an error response when the client throws", async () => {
        const clientManager = getMockedClientManager();
        clientManager
          .getConfluentCloudRestClient()
          .GET.mockRejectedValue(new Error("network down"));

        const result = await handler.handle(
          runtimeWith(CCLOUD_CONN, DEFAULT_CONNECTION_ID, clientManager),
          VALID_ARGS,
          undefined,
        );

        expect(result.isError).toBe(true);
        expect(responseText(result)).toContain("network down");
        expect(result._meta).toEqual({ error: "network down" });
      });

      it("should throw a ZodError when startDate is not in YYYY-MM-DD format", async () => {
        const clientManager = getMockedClientManager();
        const restClient = clientManager.getConfluentCloudRestClient();

        await expect(
          handler.handle(
            runtimeWith(CCLOUD_CONN, DEFAULT_CONNECTION_ID, clientManager),
            { startDate: "01-01-2026", endDate: "2026-01-31" },
            undefined,
          ),
        ).rejects.toBeInstanceOf(ZodError);

        expect(restClient.GET).not.toHaveBeenCalled();
      });

      it("should forward start/end/page params to the /billing/v1/costs path", async () => {
        const clientManager = getMockedClientManager();
        const restClient = clientManager.getConfluentCloudRestClient();
        restClient.GET.mockResolvedValue({
          data: { api_version: "v1", kind: "CostList", data: [] },
        });

        await handler.handle(
          runtimeWith(CCLOUD_CONN, DEFAULT_CONNECTION_ID, clientManager),
          {
            startDate: "2026-01-01",
            endDate: "2026-01-31",
            pageSize: 100,
            pageToken: "tok",
          },
          undefined,
        );

        expect(restClient.GET).toHaveBeenCalledWith("/billing/v1/costs", {
          params: {
            query: {
              start_date: "2026-01-01",
              end_date: "2026-01-31",
              page_size: 100,
              page_token: "tok",
            },
          },
        });
      });
    });
  });
});
