import type { CallToolResult } from "@src/confluent/schema.js";
import { SearchProductDocsHandler } from "@src/confluent/tools/handlers/docs/search-product-docs-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { bareRuntime } from "@tests/factories/runtime.js";
import { type MockedFetch, mockFetch } from "@tests/stubs/index.js";
import { beforeEach, describe, expect, it } from "vitest";

const SWIFTYPE_URL_PREFIX = "https://search-api.swiftype.com/";
const SWIFTYPE_KEY_PAGE_URL = "https://docs.confluent.io/search.html";
const TEST_ENGINE_KEY = "TestEngineKey_123";
const DEVELOPER_URL = "https://developer.confluent.io/api/search";
const SUPPORT_URL_PREFIX = "https://support.confluent.io/";

interface SourceResponses {
  swiftype?: unknown;
  developer?: unknown;
  support?: unknown;
  swiftypeStatus?: number;
  developerStatus?: number;
  supportStatus?: number;
  /** HTML of the docs search page; `null` makes that page answer 503. */
  keyPage?: string | null;
}

function keyPageHtml(engineKey: string): string {
  return `<script>window.SWIFTYPE_CONFIG = { engineKey: '${engineKey}', host: 'https://api.swiftype.com', siteId: 1 };</script>`;
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html" },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function getText(result: CallToolResult): string {
  const item = result.content[0]!;
  if (item.type !== "text") throw new Error("expected text content");
  return item.text;
}

describe("search-product-docs-handler.ts", () => {
  describe("SearchProductDocsHandler", () => {
    // A fresh handler per test: the engine key is cached on the instance.
    let handler: SearchProductDocsHandler;
    const runtime = bareRuntime();
    let fetchSpy: MockedFetch;

    beforeEach(() => {
      handler = new SearchProductDocsHandler();
      fetchSpy = mockFetch();
    });

    function setupAllSources(opts: SourceResponses): void {
      fetchSpy.mockImplementation(async (input) => {
        const url = String(input);
        if (url === SWIFTYPE_KEY_PAGE_URL) {
          return opts.keyPage === null
            ? htmlResponse("Service Unavailable", 503)
            : htmlResponse(opts.keyPage ?? keyPageHtml(TEST_ENGINE_KEY));
        }
        if (url.startsWith(SWIFTYPE_URL_PREFIX)) {
          return jsonResponse(opts.swiftype ?? {}, opts.swiftypeStatus ?? 200);
        }
        if (url === DEVELOPER_URL) {
          return jsonResponse(
            opts.developer ?? {},
            opts.developerStatus ?? 200,
          );
        }
        if (url.startsWith(SUPPORT_URL_PREFIX)) {
          return jsonResponse(opts.support ?? {}, opts.supportStatus ?? 200);
        }
        throw new Error(`Unexpected URL in test: ${url}`);
      });
    }

    describe("getToolConfig()", () => {
      it("should be a read-only tool named SEARCH_PRODUCT_DOCS", () => {
        const config = handler.getToolConfig();

        expect(config.name).toBe(ToolName.SEARCH_PRODUCT_DOCS);
        expect(config.annotations).toEqual({ readOnlyHint: true });
        expect(config.inputSchema).toHaveProperty("query");
        expect(config.inputSchema).toHaveProperty("limit");
      });
    });

    describe("handle()", () => {
      it("should reject blank queries", async () => {
        await expect(
          handler.handle(runtime, { query: "   " }),
        ).rejects.toThrow();
      });

      it("should reject limits greater than 50", async () => {
        await expect(
          handler.handle(runtime, { query: "kafka", limit: 51 }),
        ).rejects.toThrow();
      });

      it("should fetch all three sources in parallel and merge round-robin", async () => {
        setupAllSources({
          swiftype: {
            records: {
              page: [
                {
                  title: "Kafka Quick Start",
                  url: "https://docs.confluent.io/platform/quickstart.html",
                  body: "Get started with Kafka",
                },
              ],
            },
          },
          developer: {
            tutorial: {
              items: [
                {
                  title: [
                    "Long full SEO title that is way too verbose for display",
                    "Apache Kafka 101",
                  ],
                  url: "https://developer.confluent.io/learn-kafka/",
                  description: "Free Kafka course",
                },
              ],
            },
          },
          support: {
            results: [
              {
                title: "Reset consumer offsets",
                html_url:
                  "https://support.confluent.io/hc/en-us/articles/123-reset.html",
                snippet: "Steps to <em>reset</em>&nbsp;offsets",
              },
            ],
          },
        });

        const result = await handler.handle(runtime, {
          query: "kafka",
          limit: 10,
        });

        expect(result.isError).toBeFalsy();
        // Three backends plus one read of the docs search page for the engine key.
        expect(fetchSpy).toHaveBeenCalledTimes(4);
        const parsed = JSON.parse(getText(result)) as {
          results: Array<{
            title: string;
            url: string;
            source: string;
            description: string;
          }>;
          warnings: string[];
        };

        expect(parsed.results.map((r) => r.source)).toEqual([
          "docs.confluent.io",
          "developer.confluent.io",
          "support.confluent.io",
        ]);

        const dev = parsed.results.find(
          (r) => r.source === "developer.confluent.io",
        )!;
        expect(dev.title).toBe("Apache Kafka 101");

        const support = parsed.results.find(
          (r) => r.source === "support.confluent.io",
        )!;
        expect(support.description).toBe("Steps to reset offsets");

        expect(parsed.warnings).toEqual([]);
      });

      it("should drop URLs outside the allowlist and bucket allowed cross-source URLs by hostname", async () => {
        setupAllSources({
          swiftype: {
            records: {
              page: [
                { title: "External", url: "https://example.com/blog" },
                {
                  title: "Insecure",
                  url: "http://docs.confluent.io/page.html",
                },
                {
                  title: "Cross to dev",
                  url: "https://developer.confluent.io/x.html",
                  body: "x",
                },
                {
                  title: "Docs",
                  url: "https://docs.confluent.io/ok.html",
                  body: "ok",
                },
              ],
            },
          },
        });

        const result = await handler.handle(runtime, { query: "x" });
        const parsed = JSON.parse(getText(result)) as {
          results: Array<{ url: string; source: string }>;
        };

        // example.com + http:// dropped; the Swiftype-returned developer URL
        // is bucketed as developer (not as docs).
        expect(
          parsed.results.map((r) => ({ url: r.url, source: r.source })),
        ).toEqual([
          {
            url: "https://docs.confluent.io/ok.html",
            source: "docs.confluent.io",
          },
          {
            url: "https://developer.confluent.io/x.html",
            source: "developer.confluent.io",
          },
        ]);
      });

      it("should dedupe results that appear in multiple backends", async () => {
        const sharedUrl = "https://developer.confluent.io/learn-kafka/";
        setupAllSources({
          swiftype: {
            records: {
              page: [{ title: "Dup", url: sharedUrl, body: "swiftype copy" }],
            },
          },
          developer: {
            tutorial: {
              items: [{ title: "Dup", url: sharedUrl, body: "developer copy" }],
            },
          },
        });

        const result = await handler.handle(runtime, { query: "dup" });
        const parsed = JSON.parse(getText(result)) as {
          results: Array<{ url: string }>;
        };

        expect(parsed.results).toHaveLength(1);
        expect(parsed.results[0]!.url).toBe(sharedUrl);
      });

      it("should respect the requested limit when interleaving", async () => {
        setupAllSources({
          swiftype: {
            records: {
              page: Array.from({ length: 5 }, (_, i) => ({
                title: `D${i}`,
                url: `https://docs.confluent.io/d${i}.html`,
              })),
            },
          },
          developer: {
            tutorial: {
              items: Array.from({ length: 5 }, (_, i) => ({
                title: `V${i}`,
                url: `https://developer.confluent.io/v${i}/`,
              })),
            },
          },
        });

        const result = await handler.handle(runtime, {
          query: "x",
          limit: 3,
        });
        const parsed = JSON.parse(getText(result)) as {
          results: unknown[];
        };

        expect(parsed.results).toHaveLength(3);
      });

      it("should follow the docs/dev/dev/docs/support pickup pattern when docs has surplus", async () => {
        setupAllSources({
          swiftype: {
            records: {
              page: [
                { title: "D0", url: "https://docs.confluent.io/d0.html" },
                { title: "D1", url: "https://docs.confluent.io/d1.html" },
                { title: "D2", url: "https://docs.confluent.io/d2.html" },
              ],
            },
          },
          developer: {
            tutorial: {
              items: [
                { title: "V0", url: "https://developer.confluent.io/v0/" },
                { title: "V1", url: "https://developer.confluent.io/v1/" },
              ],
            },
          },
          support: {
            results: [
              {
                title: "S0",
                html_url: "https://support.confluent.io/s0.html",
              },
            ],
          },
        });

        const result = await handler.handle(runtime, {
          query: "x",
          limit: 6,
        });
        const parsed = JSON.parse(getText(result)) as {
          results: Array<{ title: string }>;
        };

        // Pattern [docs, dev, dev, docs, support] cycle 1 takes 5 slots
        // (D0, V0, V1, D1, S0); cycle 2 fills the last with D2.
        expect(parsed.results.map((r) => r.title)).toEqual([
          "D0",
          "V0",
          "V1",
          "D1",
          "S0",
          "D2",
        ]);
      });

      it("should return an empty result set with a friendly message when all sources return no hits", async () => {
        setupAllSources({});

        const result = await handler.handle(runtime, { query: "kafka" });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse(getText(result)) as {
          results: unknown[];
          warnings: string[];
          message: string;
        };
        expect(parsed.results).toEqual([]);
        expect(parsed.warnings).toEqual([]);
        expect(parsed.message).toContain('No results found for "kafka"');
      });

      it("should record a warning when one source fails but still return others", async () => {
        setupAllSources({
          swiftype: {
            records: {
              page: [
                {
                  title: "OK",
                  url: "https://docs.confluent.io/ok.html",
                },
              ],
            },
          },
          developerStatus: 500,
        });

        const result = await handler.handle(runtime, { query: "x" });
        const parsed = JSON.parse(getText(result)) as {
          results: unknown[];
          warnings: string[];
        };

        expect(result.isError).toBeFalsy();
        expect(parsed.results).toHaveLength(1);
        expect(parsed.warnings).toHaveLength(1);
        expect(parsed.warnings[0]).toMatch(/developer\.confluent\.io/);
      });

      it("should record a labeled timeout warning when an upstream stalls past the request budget", async () => {
        fetchSpy.mockImplementation(async (input) => {
          const url = String(input);
          if (url === DEVELOPER_URL) {
            const err = new Error("aborted");
            err.name = "TimeoutError";
            throw err;
          }
          return jsonResponse({});
        });

        const result = await handler.handle(runtime, { query: "x" });
        const parsed = JSON.parse(getText(result)) as { warnings: string[] };

        expect(parsed.warnings).toHaveLength(1);
        expect(parsed.warnings[0]).toContain("developer.confluent.io");
        expect(parsed.warnings[0]).toMatch(/timed out after \d+ms/);
      });

      it("should return an error response when every source fails", async () => {
        fetchSpy.mockImplementation(async () => {
          throw new Error("network down");
        });

        const result = await handler.handle(runtime, { query: "kafka" });

        expect(result.isError).toBe(true);
        const parsed = JSON.parse(getText(result)) as {
          results: unknown[];
          warnings: string[];
          message: string;
        };
        expect(parsed.results).toEqual([]);
        expect(parsed.message).toContain('No results found for "kafka"');
        expect(parsed.warnings.join(" ")).toContain("network down");
      });

      it("should send the expected query params to Swiftype", async () => {
        setupAllSources({});

        await handler.handle(runtime, {
          query: "kafka topics",
          limit: 5,
        });

        const call = fetchSpy.mock.calls.find(([input]) =>
          String(input).startsWith(SWIFTYPE_URL_PREFIX),
        );
        expect(call).toBeDefined();
        const url = new URL(String(call![0]));
        expect(url.searchParams.get("q")).toBe("kafka topics");
        expect(url.searchParams.get("engine_key")).toBe(TEST_ENGINE_KEY);
        // Over-fetch by 3x so host filtering still yields `limit` results.
        expect(url.searchParams.get("per_page")).toBe("15");
        expect(url.searchParams.get("page")).toBe("1");
      });

      it("should read the Swiftype engine key from the docs search page once and reuse it", async () => {
        setupAllSources({});

        await handler.handle(runtime, { query: "kafka", limit: 5 });
        await handler.handle(runtime, { query: "flink", limit: 5 });

        const keyPageReads = fetchSpy.mock.calls.filter(
          ([input]) => String(input) === SWIFTYPE_KEY_PAGE_URL,
        );
        expect(keyPageReads).toHaveLength(1);
        const swiftypeCalls = fetchSpy.mock.calls.filter(([input]) =>
          String(input).startsWith(SWIFTYPE_URL_PREFIX),
        );
        expect(swiftypeCalls).toHaveLength(2);
        for (const [input] of swiftypeCalls) {
          expect(new URL(String(input)).searchParams.get("engine_key")).toBe(
            TEST_ENGINE_KEY,
          );
        }
      });

      it("should fall back to the built-in engine key when the docs search page cannot be read", async () => {
        setupAllSources({ keyPage: null });

        const result = await handler.handle(runtime, {
          query: "kafka",
          limit: 5,
        });

        const call = fetchSpy.mock.calls.find(([input]) =>
          String(input).startsWith(SWIFTYPE_URL_PREFIX),
        );
        expect(call).toBeDefined();
        const engineKey = new URL(String(call![0])).searchParams.get(
          "engine_key",
        );
        expect(engineKey).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(engineKey).not.toBe(TEST_ENGINE_KEY);
        // The unreadable page is not a search failure: no warning is recorded.
        const parsed = JSON.parse(getText(result)) as { warnings: string[] };
        expect(parsed.warnings).toEqual([]);
      });

      it("should re-read the engine key and retry once when Swiftype rejects it with 402", async () => {
        const docsHit = {
          title: "Kafka Quick Start",
          url: "https://docs.confluent.io/platform/quickstart.html",
          body: "Get started with Kafka",
        };
        let keyPageReads = 0;
        fetchSpy.mockImplementation(async (input) => {
          const url = String(input);
          if (url === SWIFTYPE_KEY_PAGE_URL) {
            keyPageReads += 1;
            // The docs site rotated its engine between the two reads.
            return htmlResponse(
              keyPageHtml(keyPageReads === 1 ? "StaleKey" : "FreshKey"),
            );
          }
          if (url.startsWith(SWIFTYPE_URL_PREFIX)) {
            const engineKey = new URL(url).searchParams.get("engine_key");
            return engineKey === "FreshKey"
              ? jsonResponse({ records: { page: [docsHit] } })
              : jsonResponse(
                  { error: "API access for your account has been disabled." },
                  402,
                );
          }
          return jsonResponse({});
        });

        const result = await handler.handle(runtime, {
          query: "kafka",
          limit: 5,
        });

        const parsed = JSON.parse(getText(result)) as {
          results: Array<{ url: string }>;
          warnings: string[];
        };
        expect(parsed.warnings).toEqual([]);
        expect(parsed.results.map((r) => r.url)).toEqual([docsHit.url]);
        expect(keyPageReads).toBe(2);
        const swiftypeKeys = fetchSpy.mock.calls
          .map(([input]) => String(input))
          .filter((url) => url.startsWith(SWIFTYPE_URL_PREFIX))
          .map((url) => new URL(url).searchParams.get("engine_key"));
        expect(swiftypeKeys).toEqual(["StaleKey", "FreshKey"]);
      });

      it("should give up after one retry when Swiftype keeps rejecting the key", async () => {
        setupAllSources({
          swiftype: { error: "API access for your account has been disabled." },
          swiftypeStatus: 402,
        });

        const result = await handler.handle(runtime, {
          query: "kafka",
          limit: 5,
        });

        const parsed = JSON.parse(getText(result)) as { warnings: string[] };
        expect(parsed.warnings).toHaveLength(1);
        expect(parsed.warnings[0]).toMatch(
          /^docs\.confluent\.io search failed: Swiftype 402/,
        );
        const swiftypeCalls = fetchSpy.mock.calls.filter(([input]) =>
          String(input).startsWith(SWIFTYPE_URL_PREFIX),
        );
        expect(swiftypeCalls).toHaveLength(2);
      });

      it("should POST a JSON body to the developer.confluent.io search proxy", async () => {
        setupAllSources({});

        await handler.handle(runtime, { query: "flink", limit: 4 });

        const call = fetchSpy.mock.calls.find(
          ([input]) => input === DEVELOPER_URL,
        );
        expect(call).toBeDefined();
        const init = call![1] as RequestInit;
        expect(init.method).toBe("POST");
        const body = JSON.parse(init.body as string) as {
          query: string;
          page: number;
          perPage: number;
          contentTypes: string[];
        };
        expect(body.query).toBe("flink");
        expect(body.page).toBe(1);
        expect(body.perPage).toBe(4);
        expect(body.contentTypes).toEqual(
          expect.arrayContaining(["documentation", "tutorial"]),
        );
      });

      it("should send the expected query params to the Zendesk help center", async () => {
        setupAllSources({});

        await handler.handle(runtime, { query: "ssl", limit: 6 });

        const call = fetchSpy.mock.calls.find(([input]) =>
          String(input).startsWith(SUPPORT_URL_PREFIX),
        );
        expect(call).toBeDefined();
        const url = new URL(String(call![0]));
        expect(url.searchParams.get("query")).toBe("ssl");
        expect(url.searchParams.get("per_page")).toBe("6");
      });
    });
  });
});
