import { CallToolResult } from "@src/confluent/schema.js";
import { GetProductDocPagesHandler } from "@src/confluent/tools/handlers/docs/get-product-doc-pages-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  bareRuntime,
  DEFAULT_CONNECTION_ID,
} from "@tests/factories/runtime.js";
import { type MockedFetch, mockFetch } from "@tests/stubs/index.js";
import { beforeEach, describe, expect, it } from "vitest";

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function markdownResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/markdown" },
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

describe("get-product-doc-pages-handler.ts", () => {
  describe("GetProductDocPagesHandler", () => {
    const handler = new GetProductDocPagesHandler();
    const runtime = bareRuntime();
    let fetchSpy: MockedFetch;

    beforeEach(() => {
      fetchSpy = mockFetch();
    });

    describe("getToolConfig()", () => {
      it("should be a read-only tool named GET_PRODUCT_DOC_PAGES", () => {
        const config = handler.getToolConfig();

        expect(config.name).toBe(ToolName.GET_PRODUCT_DOC_PAGES);
        expect(config.annotations).toEqual({ readOnlyHint: true });
        expect(config.inputSchema).toHaveProperty("url");
      });
    });

    describe("enabledConnectionIds()", () => {
      it("should return every configured connection id (no service-block requirement)", () => {
        expect(handler.enabledConnectionIds(bareRuntime())).toEqual([
          DEFAULT_CONNECTION_ID,
        ]);
      });
    });

    describe("handle()", () => {
      it("should reject non-URL input", async () => {
        await expect(
          handler.handle(runtime, { url: "not a url" }),
        ).rejects.toThrow();
      });

      it.each([
        ["non-allowed host", "https://example.com/anything"],
        ["http on an allowed host", "http://docs.confluent.io/page.html"],
      ])("should reject %s without fetching", async (_label, url) => {
        const result = await handler.handle(runtime, { url });

        expect(result.isError).toBe(true);
        expect(getText(result)).toMatch(/host not allowed/);
        expect(fetchSpy).not.toHaveBeenCalled();
      });

      describe("docs.confluent.io", () => {
        it("should prefer the .md twin when available", async () => {
          fetchSpy.mockResolvedValueOnce(
            markdownResponse("# Real Markdown\n\nSource of truth."),
          );

          const result = await handler.handle(runtime, {
            url: "https://docs.confluent.io/platform/quickstart.html",
          });

          expect(result.isError).toBeFalsy();
          const text = getText(result);
          expect(text).toContain(
            "# Source: https://docs.confluent.io/platform/quickstart.html",
          );
          expect(text).toContain("# Real Markdown");
          expect(text).toContain("Source of truth.");

          const requested = String(fetchSpy.mock.calls[0]![0]);
          expect(requested).toBe(
            "https://docs.confluent.io/platform/quickstart.md",
          );
          expect(fetchSpy).toHaveBeenCalledTimes(1);
        });

        it("should append /index.md to directory-style URLs", async () => {
          fetchSpy.mockResolvedValueOnce(markdownResponse("hello"));

          await handler.handle(runtime, {
            url: "https://docs.confluent.io/platform/",
          });

          expect(String(fetchSpy.mock.calls[0]![0])).toBe(
            "https://docs.confluent.io/platform/index.md",
          );
        });

        it("should fall back to HTML rendering when the .md twin is unavailable", async () => {
          fetchSpy
            .mockResolvedValueOnce(new Response("not found", { status: 404 }))
            .mockResolvedValueOnce(
              htmlResponse(
                '<html><body><div class="rst-content"><h1>Title</h1><p>Body text.</p></div></body></html>',
              ),
            );

          const result = await handler.handle(runtime, {
            url: "https://docs.confluent.io/missing.html",
          });

          expect(result.isError).toBeFalsy();
          const text = getText(result);
          expect(text).toContain("# Title");
          expect(text).toContain("Body text.");
          expect(fetchSpy).toHaveBeenCalledTimes(2);
        });

        it("should ignore non-markdown content-type on the .md endpoint", async () => {
          fetchSpy
            .mockResolvedValueOnce(htmlResponse("<html>redirected</html>"))
            .mockResolvedValueOnce(
              htmlResponse(
                '<html><body><div class="rst-content"><p>Real body</p></div></body></html>',
              ),
            );

          const result = await handler.handle(runtime, {
            url: "https://docs.confluent.io/page.html",
          });

          expect(getText(result)).toContain("Real body");
          expect(fetchSpy).toHaveBeenCalledTimes(2);
        });
      });

      describe("developer.confluent.io", () => {
        it("should extract the Swiftype-marked article body and prepend the title", async () => {
          fetchSpy.mockResolvedValueOnce(
            htmlResponse(`
              <html>
                <body>
                  <h1 data-swiftype-name="title">Apache Kafka 101</h1>
                  <article data-swiftype-name="body">
                    <p>Lesson content.</p>
                    <aside data-swiftype-index="false"><p>Sidebar noise.</p></aside>
                  </article>
                </body>
              </html>
            `),
          );

          const result = await handler.handle(runtime, {
            url: "https://developer.confluent.io/learn-kafka/",
          });

          expect(result.isError).toBeFalsy();
          const text = getText(result);
          expect(text).toContain(
            "# Source: https://developer.confluent.io/learn-kafka/",
          );
          expect(text).toContain("# Apache Kafka 101");
          expect(text).toContain("Lesson content.");
          expect(text).not.toContain("Sidebar noise.");
        });

        it("should fall back to data-test-id sections on quickstart-style pages", async () => {
          fetchSpy.mockResolvedValueOnce(
            htmlResponse(`
              <html>
                <body>
                  <section data-test-id="section"><p>Step one.</p></section>
                  <section data-test-id="section"><p>Step two.</p></section>
                </body>
              </html>
            `),
          );

          const result = await handler.handle(runtime, {
            url: "https://developer.confluent.io/quickstart/",
          });

          expect(result.isError).toBeFalsy();
          const text = getText(result);
          expect(text).toContain("Step one.");
          expect(text).toContain("Step two.");
        });

        it("should fall back to <body> minus chrome on tutorial-style pages", async () => {
          fetchSpy.mockResolvedValueOnce(
            htmlResponse(`
              <html>
                <body>
                  <header><nav data-swiftype-index="false">site nav</nav></header>
                  <h1 data-swiftype-name="title">Avro Console Tutorial</h1>
                  <div class="style-module--content--abc">
                    <p>Tutorial body paragraph.</p>
                    <pre><code>console-consumer --topic foo</code></pre>
                  </div>
                  <footer>copyright</footer>
                </body>
              </html>
            `),
          );

          const result = await handler.handle(runtime, {
            url: "https://developer.confluent.io/confluent-tutorials/console-consumer-producer-avro/",
          });

          expect(result.isError).toBeFalsy();
          const text = getText(result);
          expect(text).toContain("# Avro Console Tutorial");
          expect(text).toContain("Tutorial body paragraph.");
          expect(text).toContain("console-consumer --topic foo");
          expect(text).not.toContain("site nav");
          expect(text).not.toContain("copyright");
        });

        it("should return an error response when even the body fallback is empty", async () => {
          fetchSpy.mockResolvedValueOnce(
            htmlResponse(
              "<html><body><header>nav</header><footer>foot</footer></body></html>",
            ),
          );

          const result = await handler.handle(runtime, {
            url: "https://developer.confluent.io/empty/",
          });

          expect(result.isError).toBe(true);
          expect(getText(result)).toContain("Could not locate article body");
        });
      });

      describe("support.confluent.io", () => {
        it("should prefer the Zendesk JSON API and prepend the article title", async () => {
          fetchSpy.mockResolvedValueOnce(
            jsonResponse({
              article: {
                title: "Reset consumer offsets",
                body: "<p>Open the CLI and run...</p>",
              },
            }),
          );

          const result = await handler.handle(runtime, {
            url: "https://support.confluent.io/hc/en-us/articles/123-reset.html",
          });

          expect(result.isError).toBeFalsy();
          const text = getText(result);
          expect(text).toContain(
            "# Source: https://support.confluent.io/hc/en-us/articles/123-reset.html",
          );
          expect(text).toContain("# Reset consumer offsets");
          expect(text).toContain("Open the CLI and run...");

          expect(String(fetchSpy.mock.calls[0]![0])).toBe(
            "https://support.confluent.io/api/v2/help_center/articles/123.json",
          );
          expect(fetchSpy).toHaveBeenCalledTimes(1);
        });

        it("should fall back to HTML scraping when the Zendesk API errors", async () => {
          fetchSpy
            .mockResolvedValueOnce(new Response("nope", { status: 500 }))
            .mockResolvedValueOnce(
              htmlResponse(
                '<html><body><article id="main-content"><h1>Article</h1><p>Body.</p></article></body></html>',
              ),
            );

          const result = await handler.handle(runtime, {
            url: "https://support.confluent.io/hc/en-us/articles/123-reset.html",
          });

          expect(result.isError).toBeFalsy();
          const text = getText(result);
          expect(text).toContain("# Article");
          expect(text).toContain("Body.");
          expect(fetchSpy).toHaveBeenCalledTimes(2);
        });

        it("should fetch the page directly when the URL has no /articles/<id>", async () => {
          fetchSpy.mockResolvedValueOnce(
            htmlResponse(
              '<html><body><article id="main-content"><p>Help home.</p></article></body></html>',
            ),
          );

          const result = await handler.handle(runtime, {
            url: "https://support.confluent.io/hc/en-us",
          });

          expect(result.isError).toBeFalsy();
          expect(getText(result)).toContain("Help home.");
          expect(String(fetchSpy.mock.calls[0]![0])).toBe(
            "https://support.confluent.io/hc/en-us",
          );
        });

        it("should return an actionable error when both the Zendesk API and HTML fallback fail to find a body", async () => {
          fetchSpy
            .mockResolvedValueOnce(jsonResponse({ article: {} }))
            .mockResolvedValueOnce(
              htmlResponse("<html><body><p>No article tag</p></body></html>"),
            );

          const result = await handler.handle(runtime, {
            url: "https://support.confluent.io/hc/en-us/articles/999",
          });

          expect(result.isError).toBe(true);
          const text = getText(result);
          expect(text).toContain("Could not locate article body");
          expect(text).toMatch(/articles\/<id>/);
        });
      });

      describe("error handling", () => {
        it.each<[label: string, throws: () => never, matches: RegExp]>([
          [
            "a labeled timeout when the upstream stalls past the request budget",
            () => {
              const err = new Error("aborted");
              err.name = "TimeoutError";
              throw err;
            },
            /timed out after \d+ms/,
          ],
          [
            "the underlying network error when fetch rejects",
            () => {
              throw new Error("network down");
            },
            /network down/,
          ],
        ])("should surface %s", async (_label, throwFn, matcher) => {
          fetchSpy.mockImplementation(async () => throwFn());

          const result = await handler.handle(runtime, {
            url: "https://docs.confluent.io/platform/quickstart.html",
          });

          expect(result.isError).toBe(true);
          expect(getText(result)).toMatch(matcher);
        });

        it("should return an error response when the HTML fallback returns a non-2xx status", async () => {
          fetchSpy
            .mockResolvedValueOnce(new Response("not found", { status: 404 }))
            .mockResolvedValueOnce(
              new Response("server error", { status: 502 }),
            );

          const result = await handler.handle(runtime, {
            url: "https://docs.confluent.io/platform/quickstart.html",
          });

          expect(result.isError).toBe(true);
          expect(getText(result)).toMatch(/502/);
        });
      });
    });
  });
});
