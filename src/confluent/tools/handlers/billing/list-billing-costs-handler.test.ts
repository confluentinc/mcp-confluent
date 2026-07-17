import { READ_ONLY } from "@src/confluent/tools/base-tools.js";
import { ListBillingCostsHandler } from "@src/confluent/tools/handlers/billing/list-billing-costs-handler.js";
import { textOf } from "@tests/call-tool-result.js";
import {
  CCLOUD_CONN,
  DEFAULT_CONNECTION_ID,
  runtimeWith,
  runtimeWithDecoy,
} from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  getMockedClientManager,
} from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

const VALID_ARGS = { startDate: "2026-01-01", endDate: "2026-01-31" };

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
        expect(config.annotations).toBe(READ_ONLY);
      });
    });

    describe("handle()", () => {
      it("should route only to its resolved connection in a multi-connection config", async () => {
        const clientManager = getMockedClientManager();
        clientManager.getConfluentCloudRestClient().GET.mockResolvedValue({
          data: { api_version: "v1", kind: "CostList", data: [] },
        });

        // runtimeWithDecoy plants a same-shaped decoy connection first; the
        // handler must route to DEFAULT_CONNECTION_ID, not enabledIds[0].
        // assertHandleCase injects that id and asserts the decoy's manager
        // stays untouched, so args deliberately omits connectionId.
        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            CCLOUD_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: VALID_ARGS,
          outcome: { resolves: "Successfully retrieved billing costs" },
          clientManager,
        });
      });

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
        );

        const text = textOf(result);
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

        const meta = result._meta as {
          costs: unknown[];
          summary: unknown;
          product_breakdown: Record<string, number>;
          total: unknown;
          pagination: unknown;
        };
        expect(meta.summary).toEqual({
          total_amount: 160,
          original_amount: 175,
          discount_amount: 15,
          line_item_count: 3,
          date_range: { start: "2026-01-01", end: "2026-01-31" },
        });
        expect(meta.product_breakdown).toEqual({ KAFKA: 60, FLINK: 100 });
        expect(meta.total).toBeUndefined();
        expect(meta.pagination).toBeUndefined();
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
        );

        const text = textOf(result);
        expect(result.isError).toBe(false);
        expect(text).toContain("Total Line Items: 0");
        expect(text).not.toContain("Product Breakdown");
        const meta = result._meta as {
          summary: { line_item_count: number; total_amount: number };
          product_breakdown: Record<string, number>;
          total: unknown;
          pagination: unknown;
        };
        expect(meta.summary.line_item_count).toBe(0);
        expect(meta.summary.total_amount).toBe(0);
        expect(meta.product_breakdown).toEqual({});
        expect(meta.total).toBeUndefined();
        expect(meta.pagination).toBeUndefined();
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
        );

        const text = textOf(result);
        expect(result.isError).toBe(false);
        expect(text).toContain("Pagination:");
        expect(text).toContain("Total Items: 42");
        expect(text).toContain("First Page: https://api/page?first");
        expect(text).toContain("Last Page: https://api/page?last");
        expect(text).toContain("Previous Page: https://api/page?prev");
        expect(text).toContain("Next Page: https://api/page?next");
        const meta = result._meta as {
          total: number;
          pagination: Record<string, string>;
        };
        expect(meta.total).toBe(42);
        expect(meta.pagination).toEqual({
          first: "https://api/page?first",
          last: "https://api/page?last",
          prev: "https://api/page?prev",
          next: "https://api/page?next",
        });
      });

      it("should render a Total Items line of 0 when total_size is zero", async () => {
        const clientManager = getMockedClientManager();
        clientManager.getConfluentCloudRestClient().GET.mockResolvedValue({
          data: {
            api_version: "v1",
            kind: "CostList",
            metadata: { total_size: 0 },
            data: [],
          },
        });

        const result = await handler.handle(
          runtimeWith(CCLOUD_CONN, DEFAULT_CONNECTION_ID, clientManager),
          VALID_ARGS,
        );

        expect(result.isError).toBe(false);
        expect(textOf(result)).toContain("Total Items: 0");
        expect((result._meta as { total: unknown }).total).toBe(0);
      });

      it("should omit the pagination section and leave _meta.pagination undefined when metadata is absent", async () => {
        const clientManager = getMockedClientManager();
        clientManager.getConfluentCloudRestClient().GET.mockResolvedValue({
          data: { api_version: "v1", kind: "CostList", data: [] },
        });

        const result = await handler.handle(
          runtimeWith(CCLOUD_CONN, DEFAULT_CONNECTION_ID, clientManager),
          VALID_ARGS,
        );

        const text = textOf(result);
        expect(result.isError).toBe(false);
        expect(text).not.toContain("Pagination:");
        const meta = result._meta as { total: unknown; pagination: unknown };
        expect(meta.total).toBeUndefined();
        expect(meta.pagination).toBeUndefined();
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
        );

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("Failed to fetch billing costs");
        expect(textOf(result)).toContain("forbidden");
        expect(result._meta).toEqual({ error: apiError });
      });

      it.each([
        {
          label: "the top-level kind literal is wrong",
          response: { api_version: "v1", kind: "NotACostList", data: [] },
        },
        {
          label: "a line item is missing required fields",
          response: {
            api_version: "v1",
            kind: "CostList",
            data: [{ product: "KAFKA" }],
          },
        },
      ])(
        "should return a validation-error response when $label",
        async ({ response }) => {
          const clientManager = getMockedClientManager();
          clientManager
            .getConfluentCloudRestClient()
            .GET.mockResolvedValue({ data: response });

          const result = await handler.handle(
            runtimeWith(CCLOUD_CONN, DEFAULT_CONNECTION_ID, clientManager),
            VALID_ARGS,
          );

          expect(result.isError).toBe(true);
          expect(textOf(result)).toContain("Invalid billing costs data");
          expect((result._meta as { error: unknown }).error).toBeInstanceOf(
            ZodError,
          );
        },
      );

      it("should return an error response when the client throws", async () => {
        const clientManager = getMockedClientManager();
        clientManager
          .getConfluentCloudRestClient()
          .GET.mockRejectedValue(new Error("network down"));

        const result = await handler.handle(
          runtimeWith(CCLOUD_CONN, DEFAULT_CONNECTION_ID, clientManager),
          VALID_ARGS,
        );

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("network down");
        expect(result._meta).toEqual({ error: "network down" });
      });

      it.each([
        {
          label: "startDate is not in YYYY-MM-DD format",
          args: { startDate: "01-01-2026", endDate: "2026-01-31" },
        },
        {
          label: "endDate is not in YYYY-MM-DD format",
          args: { startDate: "2026-01-01", endDate: "31-01-2026" },
        },
        {
          label: "startDate is missing",
          args: { endDate: "2026-01-31" },
        },
        {
          label: "endDate is missing",
          args: { startDate: "2026-01-01" },
        },
        {
          label: "pageSize exceeds the 1000 max",
          args: {
            startDate: "2026-01-01",
            endDate: "2026-01-31",
            pageSize: 1001,
          },
        },
        {
          label: "range exceeds the 31-day cap by one day",
          args: { startDate: "2026-01-01", endDate: "2026-02-02" },
        },
        {
          label: "range is a full year, well over the 31-day cap",
          args: { startDate: "2026-01-01", endDate: "2027-01-01" },
        },
        {
          label: "endDate is before startDate",
          args: { startDate: "2026-02-01", endDate: "2026-01-01" },
        },
        {
          label: "startDate matches the format but is not a real calendar date",
          args: { startDate: "2026-02-30", endDate: "2026-02-28" },
        },
        {
          label: "endDate matches the format but is not a real calendar date",
          args: { startDate: "2026-01-01", endDate: "2026-13-01" },
        },
      ])(
        "should throw a ZodError and not call the API when $label",
        async ({ args }) => {
          const clientManager = getMockedClientManager();
          const restClient = clientManager.getConfluentCloudRestClient();

          await expect(
            handler.handle(
              runtimeWith(CCLOUD_CONN, DEFAULT_CONNECTION_ID, clientManager),
              args,
            ),
          ).rejects.toBeInstanceOf(ZodError);

          expect(restClient.GET).not.toHaveBeenCalled();
        },
      );

      it("should name the 31-day cap and the actual span in the ZodError message", async () => {
        const clientManager = getMockedClientManager();

        await expect(
          handler.handle(
            runtimeWith(CCLOUD_CONN, DEFAULT_CONNECTION_ID, clientManager),
            { startDate: "2026-01-01", endDate: "2026-03-01" },
          ),
        ).rejects.toThrowError(/got 59 days.*31 days/);
      });

      it("should accept the inclusive 31-day boundary and call the API", async () => {
        const clientManager = getMockedClientManager();
        const restClient = clientManager.getConfluentCloudRestClient();
        restClient.GET.mockResolvedValue({
          data: { api_version: "v1", kind: "CostList", data: [] },
        });

        const result = await handler.handle(
          runtimeWith(CCLOUD_CONN, DEFAULT_CONNECTION_ID, clientManager),
          { startDate: "2026-01-01", endDate: "2026-02-01" },
        );

        expect(result.isError).toBe(false);
        expect(restClient.GET).toHaveBeenCalledOnce();
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
