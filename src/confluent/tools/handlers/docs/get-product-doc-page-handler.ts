import { nodeFetch } from "@src/confluent/node-deps.js";
import type { CallToolResult } from "@src/confluent/schema.js";
import type { ToolConfig } from "@src/confluent/tools/base-tools.js";
import {
  BaseToolHandler,
  READ_ONLY,
  ToolCategory,
} from "@src/confluent/tools/base-tools.js";
import { alwaysEnabled } from "@src/confluent/tools/connection-predicates.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { logger } from "@src/logger.js";
import type { ServerRuntime } from "@src/server-runtime.js";
import * as cheerio from "cheerio";
import TurndownService from "turndown";
import { z } from "zod";

type Source =
  | "docs.confluent.io"
  | "developer.confluent.io"
  | "support.confluent.io";

const ALLOWED_HOSTS = new Set<Source>([
  "docs.confluent.io",
  "developer.confluent.io",
  "support.confluent.io",
]);

const USER_AGENT = "mcp-confluent/get-product-doc-page";
const REQUEST_TIMEOUT_MS = 10_000;

const getProductDocPageArguments = z.object({
  url: z
    .url()
    .describe(
      "Absolute URL of a page under https://docs.confluent.io/, https://developer.confluent.io/, or https://support.confluent.io/. Prefer URLs returned by search-product-docs.",
    ),
});

export class GetProductDocPageHandler extends BaseToolHandler {
  private readonly turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });

  async handle(
    _runtime: ServerRuntime,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const { url } = getProductDocPageArguments.parse(toolArguments);
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      !ALLOWED_HOSTS.has(parsed.hostname as Source)
    ) {
      return this.createResponse(
        `Hostname '${parsed.hostname}' is not allowed. Only docs.confluent.io, developer.confluent.io, and support.confluent.io are supported.`,
        true,
      );
    }

    try {
      switch (parsed.hostname as Source) {
        case "docs.confluent.io":
          return await this.fetchFromDocsConfluent(parsed);
        case "developer.confluent.io":
          return await this.fetchFromDeveloperConfluent(parsed);
        case "support.confluent.io":
          return await this.fetchFromSupportZendesk(parsed);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn({ url, error: message }, "get-product-doc-page fetch failed");
      return this.createResponse(`Failed to fetch ${url}: ${message}`, true);
    }
  }

  // Sphinx publishes a .md twin at the same path; HTML scrape is the fallback.
  private async fetchFromDocsConfluent(parsed: URL): Promise<CallToolResult> {
    const mdResponse = await fetchWithTimeout(toMarkdownTwin(parsed), {
      headers: { "user-agent": USER_AGENT, accept: "text/markdown,text/plain" },
    });
    if (
      mdResponse.ok &&
      (mdResponse.headers.get("content-type") ?? "")
        .toLowerCase()
        .includes("markdown")
    ) {
      const body = (await mdResponse.text()).trim();
      return this.formatResponse(parsed, undefined, body);
    }

    // 404s on docs.confluent.io soft-redirect to /index.html; reject path
    // changes so we don't return the homepage as if it were the requested page.
    const html = await this.fetchHtml(parsed, { rejectRedirect: true });
    const $ = cheerio.load(html);
    const main = $("div.rst-content").first();
    const target = main.length > 0 ? main : $("body");
    return this.formatResponse(
      parsed,
      undefined,
      this.toMarkdown(target.html()),
    );
  }

  // Gatsby site has hashed CSS classes; key off stable data-swiftype-* attributes.
  private async fetchFromDeveloperConfluent(
    parsed: URL,
  ): Promise<CallToolResult> {
    const html = await this.fetchHtml(parsed);
    const $ = cheerio.load(html);

    // <section data-test-id="section"> wraps both content and footer chrome
    // (Cloud promo, newsletter). Real content is 3KB+ text; chrome is < 1KB.
    $('section[data-test-id="section"]').each((_, el) => {
      if ($(el).text().trim().length < 1500) $(el).remove();
    });

    const title = $('[data-swiftype-name="title"]').first().text().trim();

    let bodyHtml: string | null = null;
    const swiftypeBody = $('[data-swiftype-name="body"]').first();
    if (swiftypeBody.length > 0) {
      swiftypeBody.find('[data-swiftype-index="false"]').remove();
      bodyHtml = swiftypeBody.html();
    } else {
      const fromPageData = await this.fetchFromGatsbyPageData(parsed);
      if (fromPageData) return fromPageData;

      // Quickstart pages have no Swiftype body — content lives in <section> blocks.
      const sections = $('section[data-test-id="section"]');
      if (sections.length > 0) {
        sections.find('[data-swiftype-index="false"]').remove();
        bodyHtml = sections
          .map((_, el) => $.html(el))
          .get()
          .join("\n");
      } else {
        // Tutorial pages (/confluent-tutorials/...) have neither marker —
        // strip <body> chrome and keep the rest.
        const body = $("body");
        body
          .find(
            'header, footer, nav, script, style, noscript, [data-swiftype-index="false"]',
          )
          .remove();
        const stripped = body.html()?.trim();
        if (stripped) bodyHtml = stripped;
      }
    }

    if (!bodyHtml) {
      return this.createResponse(
        `Could not locate article body for ${parsed.toString()}. The page structure may have changed.`,
        true,
      );
    }
    return this.formatResponse(
      parsed,
      title || undefined,
      this.toMarkdown(bodyHtml),
    );
  }

  // Zendesk Help Center: prefer the public JSON API for clean body; HTML scrape is the fallback.
  private async fetchFromSupportZendesk(parsed: URL): Promise<CallToolResult> {
    const articleId = parsed.pathname.match(/\/articles\/(\d+)/)?.[1];
    if (articleId) {
      const apiResponse = await fetchWithTimeout(
        `https://support.confluent.io/api/v2/help_center/articles/${articleId}.json`,
        {
          headers: { "user-agent": USER_AGENT, accept: "application/json" },
        },
      );
      if (apiResponse.ok) {
        const { article } =
          (await apiResponse.json()) as ZendeskArticleResponse;
        if (article?.body) {
          return this.formatResponse(
            parsed,
            article.title,
            this.toMarkdown(article.body),
          );
        }
      }
    }

    const html = await this.fetchHtml(parsed);
    const $ = cheerio.load(html);
    const article = $("article#main-content").first();
    if (article.length === 0) {
      return this.createResponse(
        `Could not locate article body for ${parsed.toString()}. ` +
          `This URL may be a Help Center index or category page; only article URLs (containing "/articles/<id>") are supported.`,
        true,
      );
    }
    return this.formatResponse(
      parsed,
      undefined,
      this.toMarkdown(article.html()),
    );
  }

  // CSR pages (e.g. /get-started/<lang>/) expose their real content as JSON
  // at /page-data/<path>/page-data.json instead of in the SSR HTML.
  private async fetchFromGatsbyPageData(
    parsed: URL,
  ): Promise<CallToolResult | null> {
    const pageDataUrl = `${parsed.origin}/page-data${parsed.pathname.replace(/\/?$/, "/")}page-data.json`;
    const resp = await fetchWithTimeout(pageDataUrl, {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
    });
    if (!resp.ok) return null;
    let data: GatsbyPageData;
    try {
      data = (await resp.json()) as GatsbyPageData;
    } catch {
      return null;
    }
    const ctx = data?.result?.pageContext;
    const cm = ctx?.contentMappings;
    if (!cm || typeof cm !== "object") return null;

    // If the URL has a fragment (e.g. #produce-events), return only that section.
    const sections =
      parsed.hash && cm[parsed.hash] ? [cm[parsed.hash]] : Object.values(cm);
    const html = sections.join("\n");
    if (!html) return null;

    const title = ctx?.hero?.title ?? ctx?.seo?.title;
    return this.formatResponse(
      parsed,
      title || undefined,
      this.toMarkdown(html),
    );
  }

  private async fetchHtml(
    parsed: URL,
    opts?: { rejectRedirect?: boolean },
  ): Promise<string> {
    const response = await fetchWithTimeout(parsed.toString(), {
      headers: { "user-agent": USER_AGENT },
    });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    if (opts?.rejectRedirect) {
      const finalPath = new URL(response.url || parsed.toString()).pathname;
      if (finalPath !== parsed.pathname) {
        throw new Error(
          `${parsed.toString()} redirected to ${finalPath}; page may have been moved or removed.`,
        );
      }
    }
    return response.text();
  }

  private toMarkdown(html: string | null): string {
    return this.turndown.turndown(html ?? "").trim();
  }

  private formatResponse(
    parsed: URL,
    title: string | undefined,
    body: string,
  ): CallToolResult {
    const heading = title ? `# ${title}\n\n` : "";
    return this.createResponse(
      `# Source: ${parsed.toString()}\n\n${heading}${body}`,
    );
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.GET_PRODUCT_DOC_PAGE,
      description:
        "Fetch the full markdown content of a Confluent product documentation page. Accepts URLs under https://docs.confluent.io/, https://developer.confluent.io/, or https://support.confluent.io/. Use this after search-product-docs to read a result's full content.",
      inputSchema: getProductDocPageArguments.shape,
      annotations: READ_ONLY,
    };
  }

  readonly category = ToolCategory.Docs;
  readonly predicate = alwaysEnabled;
}

function toMarkdownTwin(parsed: URL): string {
  const twin = new URL(parsed.toString());
  if (twin.pathname.endsWith(".html")) {
    twin.pathname = twin.pathname.slice(0, -".html".length) + ".md";
  } else if (twin.pathname.endsWith("/")) {
    twin.pathname += "index.md";
  } else {
    twin.pathname += ".md";
  }
  return twin.toString();
}

// Adds a 10s deadline and re-checks the post-redirect host so a 3xx
// can't escape ALLOWED_HOSTS. Relabels TimeoutError with URL and budget.
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    const response = await nodeFetch.fetch(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const finalHost = new URL(response.url || url).hostname;
    if (!ALLOWED_HOSTS.has(finalHost as Source)) {
      throw new Error(
        `Request to ${url} redirected to disallowed host ${finalHost}`,
      );
    }
    return response;
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error(
        `Request to ${url} timed out after ${REQUEST_TIMEOUT_MS}ms`,
      );
    }
    throw err;
  }
}

interface ZendeskArticleResponse {
  article?: {
    title?: string;
    body?: string;
  };
}

interface GatsbyPageData {
  result?: {
    pageContext?: {
      contentMappings?: Record<string, string>;
      hero?: { title?: string };
      seo?: { title?: string };
    };
  };
}
