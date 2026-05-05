import { nodeFetch } from "@src/confluent/node-deps.js";
import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  READ_ONLY,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { logger } from "@src/logger.js";
import { ServerRuntime } from "@src/server-runtime.js";
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

const USER_AGENT = "mcp-confluent/get-product-doc-pages";
const REQUEST_TIMEOUT_MS = 10_000;

const getProductDocPagesArguments = z.object({
  url: z
    .string()
    .url()
    .describe(
      "Absolute URL of a page under https://docs.confluent.io/, https://developer.confluent.io/, or https://support.confluent.io/. Prefer URLs returned by search-product-docs.",
    ),
});

export class GetProductDocPagesHandler extends BaseToolHandler {
  private readonly turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });

  async handle(
    _runtime: ServerRuntime,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const { url } = getProductDocPagesArguments.parse(toolArguments);
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      !ALLOWED_HOSTS.has(parsed.hostname as Source)
    ) {
      return this.createResponse(
        "URL host not allowed. Only https://docs.confluent.io/, https://developer.confluent.io/, and https://support.confluent.io/ are supported.",
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
      logger.warn(
        { url, error: message },
        "get-product-doc-pages fetch failed",
      );
      return this.createResponse(`Failed to fetch ${url}: ${message}`, true);
    }
  }

  // docs.confluent.io (Sphinx) publishes the source markdown at the same path
  // with .md substituted for .html, which avoids HTML parsing entirely. Falls
  // back to rendering HTML if the .md twin is unavailable.
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

    const html = await this.fetchHtml(parsed);
    const $ = cheerio.load(html);
    const main = $("div.rst-content").first();
    const target = main.length > 0 ? main : $("body");
    return this.formatResponse(
      parsed,
      undefined,
      this.toMarkdown(target.html()),
    );
  }

  // developer.confluent.io (Gatsby) has no semantic <main>, but renders Swiftype
  // indexing attributes marking the article body and excluded sections. These
  // are stable across builds, unlike the hashed CSS classes.
  private async fetchFromDeveloperConfluent(
    parsed: URL,
  ): Promise<CallToolResult> {
    const html = await this.fetchHtml(parsed);
    const $ = cheerio.load(html);
    const title = $('[data-swiftype-name="title"]').first().text().trim();

    let bodyHtml: string | null = null;
    const swiftypeBody = $('[data-swiftype-name="body"]').first();
    if (swiftypeBody.length > 0) {
      swiftypeBody.find('[data-swiftype-index="false"]').remove();
      bodyHtml = swiftypeBody.html();
    } else {
      // Quickstart-style pages have no Swiftype body marker; their content
      // lives in <section data-test-id="section"> blocks instead.
      const sections = $('section[data-test-id="section"]');
      if (sections.length > 0) {
        sections.find('[data-swiftype-index="false"]').remove();
        bodyHtml = sections
          .map((_, el) => $.html(el))
          .get()
          .join("\n");
      } else {
        // Tutorial-style pages (/confluent-tutorials/...) have neither marker —
        // content lives between semantic <header> and <footer> in hashed Gatsby
        // CSS classes. Fall back to <body> minus chrome.
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

  // support.confluent.io is a Zendesk Help Center. Public articles are exposed
  // via a documented JSON API that returns clean HTML for the body. Falls back
  // to fetching the rendered page if the API is unavailable.
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

  private async fetchHtml(parsed: URL): Promise<string> {
    const response = await fetchWithTimeout(parsed.toString(), {
      headers: { "user-agent": USER_AGENT },
    });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
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
      name: ToolName.GET_PRODUCT_DOC_PAGES,
      description:
        "Fetch the full markdown content of a Confluent product documentation page. Accepts URLs under https://docs.confluent.io/, https://developer.confluent.io/, or https://support.confluent.io/. Use this after search-product-docs to read a result's full content.",
      inputSchema: getProductDocPagesArguments.shape,
      annotations: READ_ONLY,
    };
  }

  enabledConnectionIds(runtime: ServerRuntime): string[] {
    return Object.keys(runtime.config.connections);
  }
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

// Wraps {@linkcode nodeFetch.fetch} with a 10s deadline and rethrows TimeoutError
// as a labeled `Error` so the surrounding catch can surface it cleanly.
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await nodeFetch.fetch(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
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
