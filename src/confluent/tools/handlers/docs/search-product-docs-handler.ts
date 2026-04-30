import { ClientManager } from "@src/confluent/client-manager.js";
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
import { z } from "zod";

// Public search-only key embedded in docs.confluent.io's frontend
// (_static/js/swiftype-search.js). Safe to hardcode.
const SWIFTYPE_ENGINE_KEY = "FbBthqzRNii8B32is9R2";
const SWIFTYPE_SEARCH_URL =
  "https://search-api.swiftype.com/api/v1/public/engines/search.json";
const DEVELOPER_SEARCH_URL = "https://developer.confluent.io/api/search";
const SUPPORT_SEARCH_URL =
  "https://support.confluent.io/api/v2/help_center/articles/search.json";
const ALLOWED_HOSTS = new Set([
  "docs.confluent.io",
  "developer.confluent.io",
  "support.confluent.io",
]);
const DEVELOPER_CONTENT_TYPES = [
  "documentation",
  "tutorial",
  "course",
  "article",
  "quickstart",
  "recipe",
  "pattern",
  "faq",
] as const;
const DESCRIPTION_MAX_LENGTH = 300;
const USER_AGENT = "mcp-confluent/search-product-docs";
const REQUEST_TIMEOUT_MS = 10_000;

type Source =
  | "docs.confluent.io"
  | "developer.confluent.io"
  | "support.confluent.io";

interface NormalizedResult {
  title: string;
  url: string;
  description: string;
  source: Source;
}

const searchProductDocsArguments = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .describe("Keyword or phrase to search for in Confluent product docs."),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(50)
    .default(10)
    .describe("Maximum number of results to return (1-50, default 10)."),
});

export class SearchProductDocsHandler extends BaseToolHandler {
  async handle(
    _clientManager: ClientManager,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const { query, limit } = searchProductDocsArguments.parse(toolArguments);

    const [docsSettled, developerSettled, supportSettled] =
      await Promise.allSettled([
        this.searchSwiftype(query, limit),
        this.searchDeveloperProxy(query, limit),
        this.searchSupportZendesk(query, limit),
      ]);

    const warnings: string[] = [];
    const sources: NormalizedResult[][] = [
      extractResults(docsSettled, "docs.confluent.io", warnings),
      extractResults(developerSettled, "developer.confluent.io", warnings),
      extractResults(supportSettled, "support.confluent.io", warnings),
    ];

    const merged = interleaveAndDedupe(sources, limit);
    const payload: {
      results: NormalizedResult[];
      warnings: string[];
      message?: string;
    } = { results: merged, warnings };
    if (merged.length === 0) {
      payload.message = `No results found for "${query}".`;
    }
    return this.createResponse(
      JSON.stringify(payload, null, 2),
      merged.length === 0 && warnings.length > 0,
    );
  }

  private async searchSwiftype(
    query: string,
    limit: number,
  ): Promise<NormalizedResult[]> {
    // Over-fetch so that host-filtering to allowed domains still yields `limit` results.
    const params = new URLSearchParams({
      engine_key: SWIFTYPE_ENGINE_KEY,
      q: query,
      per_page: String(Math.min(50, limit * 3)),
      page: "1",
    });
    const json = await fetchSourceJson<SwiftypeResponse>(
      `${SWIFTYPE_SEARCH_URL}?${params.toString()}`,
      { headers: { "user-agent": USER_AGENT, accept: "application/json" } },
      "Swiftype",
    );
    const hits = json.records?.page ?? [];
    return hits
      .map((h): NormalizedResult | null => {
        const url = typeof h.url === "string" ? h.url : "";
        const source = sourceForUrl(url);
        if (source === null) return null;
        return {
          title: coerceTitle(h.title) ?? url,
          url,
          description: buildDescription(h.highlight?.body, h.body),
          source,
        };
      })
      .filter((r): r is NormalizedResult => r !== null);
  }

  private async searchDeveloperProxy(
    query: string,
    limit: number,
  ): Promise<NormalizedResult[]> {
    const json = await fetchSourceJson<DeveloperProxyResponse>(
      DEVELOPER_SEARCH_URL,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": USER_AGENT,
          accept: "application/json",
        },
        body: JSON.stringify({
          query,
          page: 1,
          perPage: Math.min(50, limit * 2),
          contentTypes: DEVELOPER_CONTENT_TYPES,
        }),
      },
      "developer.confluent.io /api/search",
    );
    const results: NormalizedResult[] = [];
    for (const contentType of DEVELOPER_CONTENT_TYPES) {
      const items = json[contentType]?.items ?? [];
      for (const item of items) {
        const url = typeof item.url === "string" ? item.url : "";
        const source = sourceForUrl(url);
        if (source === null) continue;
        results.push({
          title: coerceTitle(item.title) ?? url,
          url,
          description: buildDescription(
            item.highlight?.body,
            item.description,
            item.body,
          ),
          source,
        });
      }
    }
    return results;
  }

  /**
   * support.confluent.io runs on Zendesk Help Center, which exposes a
   * documented public search API requiring no auth.
   */
  private async searchSupportZendesk(
    query: string,
    limit: number,
  ): Promise<NormalizedResult[]> {
    const params = new URLSearchParams({
      query,
      per_page: String(Math.min(50, limit * 2)),
    });
    const json = await fetchSourceJson<ZendeskSearchResponse>(
      `${SUPPORT_SEARCH_URL}?${params.toString()}`,
      { headers: { "user-agent": USER_AGENT, accept: "application/json" } },
      "Zendesk",
    );
    const hits = json.results ?? [];
    return hits
      .map((h): NormalizedResult | null => {
        const url = typeof h.html_url === "string" ? h.html_url : "";
        const source = sourceForUrl(url);
        if (source === null) return null;
        return {
          title: coerceTitle(h.title) ?? url,
          url,
          description: buildDescription(h.snippet, h.body),
          source,
        };
      })
      .filter((r): r is NormalizedResult => r !== null);
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.SEARCH_PRODUCT_DOCS,
      description:
        "Search Confluent product documentation across docs.confluent.io, developer.confluent.io, and support.confluent.io. Returns ranked results with title, url, and a short description.",
      inputSchema: searchProductDocsArguments.shape,
      annotations: READ_ONLY,
    };
  }

  enabledConnectionIds(runtime: ServerRuntime): string[] {
    // Public docs search has no service-block requirement, so it's enabled
    // whenever the runtime has at least one connection configured.
    return Object.keys(runtime.config.connections);
  }
}

interface SwiftypeHit {
  title?: string | string[];
  url?: string;
  body?: string;
  highlight?: { body?: string };
}

interface SwiftypeResponse {
  records?: { page?: SwiftypeHit[] };
}

interface DeveloperProxyItem {
  title?: string | string[];
  url?: string;
  body?: string;
  description?: string;
  highlight?: { body?: string };
}

type DeveloperProxyResponse = Partial<
  Record<
    (typeof DEVELOPER_CONTENT_TYPES)[number],
    { items?: DeveloperProxyItem[] }
  >
>;

interface ZendeskSearchHit {
  title?: string;
  html_url?: string;
  snippet?: string;
  body?: string;
}

interface ZendeskSearchResponse {
  results?: ZendeskSearchHit[];
}

/**
 * Fetches JSON from `url`, bounded by `REQUEST_TIMEOUT_MS`. Any failure —
 * timeout, non-2xx response, or network error — is rethrown as an Error
 * prefixed with `label`, so the caller can tell which source failed.
 */
async function fetchSourceJson<T>(
  url: string,
  init: RequestInit,
  label: string,
): Promise<T> {
  let response: Response;
  try {
    response = await nodeFetch.fetch(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error(`${label} timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw err;
  }
  if (!response.ok) {
    throw new Error(`${label} ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

function extractResults(
  settled: PromiseSettledResult<NormalizedResult[]>,
  source: Source,
  warnings: string[],
): NormalizedResult[] {
  if (settled.status === "fulfilled") return settled.value;
  const reason =
    settled.reason instanceof Error
      ? settled.reason.message
      : String(settled.reason);
  warnings.push(`${source} search failed: ${reason}`);
  logger.warn({ source, reason }, "search-product-docs source failed");
  return [];
}

/**
 * Interleave N ranked lists round-robin so each source contributes early
 * results. Dedupes by URL (different backends sometimes return the same page).
 */
function interleaveAndDedupe(
  sources: NormalizedResult[][],
  limit: number,
): NormalizedResult[] {
  const seen = new Set<string>();
  const out: NormalizedResult[] = [];
  const indices = sources.map(() => 0);
  let progressed = true;
  while (out.length < limit && progressed) {
    progressed = false;
    for (let s = 0; s < sources.length; s++) {
      if (out.length >= limit) break;
      const list = sources[s]!;
      while (indices[s]! < list.length) {
        const r = list[indices[s]!++]!;
        progressed = true;
        if (!seen.has(r.url)) {
          seen.add(r.url);
          out.push(r);
          break;
        }
      }
    }
  }
  return out;
}

function sourceForUrl(url: string): Source | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
    if (ALLOWED_HOSTS.has(parsed.hostname)) return parsed.hostname as Source;
    return null;
  } catch {
    return null;
  }
}

/**
 * Swiftype and the dev proxy sometimes return titles as [long, short] tuples
 * (full SEO title and the display title). Prefer the shorter one.
 */
function coerceTitle(title: unknown): string | null {
  if (typeof title === "string") return title.trim() || null;
  if (Array.isArray(title)) {
    const strings = title.filter((t): t is string => typeof t === "string");
    if (strings.length === 0) return null;
    const sorted = [...strings].sort((a, b) => a.length - b.length);
    return sorted[0]!.trim() || null;
  }
  return null;
}

function buildDescription(...candidates: Array<string | undefined>): string {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const cleaned = stripHtmlAndCollapse(candidate);
    if (cleaned.length > 0) return truncate(cleaned, DESCRIPTION_MAX_LENGTH);
  }
  return "";
}

function stripHtmlAndCollapse(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + "…";
}
