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
import { z } from "zod";

// Swiftype engine key: a public, search-only key that every docs.confluent.io
// page prints (`window.SWIFTYPE_CONFIG.engineKey`). Confluent changes it when
// the docs site changes its Swiftype engine (the key hard-coded until 1.6.0
// answers "402 Payment Required" since the engine behind it was disabled), so
// it is read from the docs search page at run time and cached for the life of
// the server; the constant below is only the fallback when that page cannot
// be read.
const SWIFTYPE_FALLBACK_ENGINE_KEY = "VS5CWUJgxrS_i_xbvZSR";
const SWIFTYPE_ENGINE_KEY_PAGE_URL = "https://docs.confluent.io/search.html";
const SWIFTYPE_ENGINE_KEY_PATTERN = /engineKey\s*:\s*["']([A-Za-z0-9_-]+)["']/;
// Statuses Swiftype answers with when the engine key is no longer valid.
const SWIFTYPE_KEY_REJECTED_STATUSES = new Set([401, 402]);
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
    _runtime: ServerRuntime,
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
    // Whichever backend pushes into a bucket first leads it.
    // dev-proxy is curated, so its hits outrank Swiftype's; Swiftype fills gaps.
    const all = [
      ...extractResults(developerSettled, "developer.confluent.io", warnings),
      ...extractResults(supportSettled, "support.confluent.io", warnings),
      ...extractResults(docsSettled, "docs.confluent.io", warnings),
    ];

    // Bucket by URL hostname, not backend: Swiftype indexes *.confluent.io
    // and dev-proxy returns docs URLs, so backend→bucket would starve slots.
    const buckets: Record<Source, NormalizedResult[]> = {
      "docs.confluent.io": [],
      "developer.confluent.io": [],
      "support.confluent.io": [],
    };
    for (const r of all) buckets[r.source].push(r);

    const merged = interleaveAndDedupe(
      [
        buckets["docs.confluent.io"],
        buckets["developer.confluent.io"],
        buckets["support.confluent.io"],
      ],
      limit,
    );
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

  /** Engine key read from docs.confluent.io, cached for the life of the server. */
  private swiftypeEngineKey: string | null = null;

  private async resolveSwiftypeEngineKey(refresh = false): Promise<string> {
    if (this.swiftypeEngineKey !== null && !refresh) {
      return this.swiftypeEngineKey;
    }
    try {
      const html = await fetchSourceText(
        SWIFTYPE_ENGINE_KEY_PAGE_URL,
        { headers: { "user-agent": USER_AGENT, accept: "text/html" } },
        "docs.confluent.io search page",
      );
      const match = SWIFTYPE_ENGINE_KEY_PATTERN.exec(html);
      if (match?.[1]) {
        this.swiftypeEngineKey = match[1];
        return this.swiftypeEngineKey;
      }
      logger.warn(
        { url: SWIFTYPE_ENGINE_KEY_PAGE_URL },
        "search-product-docs: no Swiftype engine key on the docs search page, using the fallback key",
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn(
        { url: SWIFTYPE_ENGINE_KEY_PAGE_URL, reason },
        "search-product-docs: could not read the docs search page, using the fallback key",
      );
    }
    this.swiftypeEngineKey = SWIFTYPE_FALLBACK_ENGINE_KEY;
    return this.swiftypeEngineKey;
  }

  private async querySwiftype(
    query: string,
    limit: number,
    engineKey: string,
  ): Promise<SwiftypeResponse> {
    // Over-fetch: host-filtering may drop hits before we reach `limit`.
    const params = new URLSearchParams({
      engine_key: engineKey,
      q: query,
      per_page: String(Math.min(50, limit * 3)),
      page: "1",
    });
    return fetchSourceJson<SwiftypeResponse>(
      `${SWIFTYPE_SEARCH_URL}?${params.toString()}`,
      { headers: { "user-agent": USER_AGENT, accept: "application/json" } },
      "Swiftype",
    );
  }

  private async searchSwiftype(
    query: string,
    limit: number,
  ): Promise<NormalizedResult[]> {
    let json: SwiftypeResponse;
    try {
      json = await this.querySwiftype(
        query,
        limit,
        await this.resolveSwiftypeEngineKey(),
      );
    } catch (err) {
      // The cached key no longer matches the docs site's engine: re-read the
      // page and retry once. Any other failure surfaces as before.
      if (
        !(err instanceof SourceHttpError) ||
        !SWIFTYPE_KEY_REJECTED_STATUSES.has(err.status)
      ) {
        throw err;
      }
      json = await this.querySwiftype(
        query,
        limit,
        await this.resolveSwiftypeEngineKey(true),
      );
    }
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
          perPage: limit,
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

  /** Zendesk Help Center public search API — no auth, support hits only. */
  private async searchSupportZendesk(
    query: string,
    limit: number,
  ): Promise<NormalizedResult[]> {
    const params = new URLSearchParams({
      query,
      per_page: String(limit),
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
        "Search Confluent product documentation (docs.confluent.io, developer.confluent.io, support.confluent.io) by keyword.",
      inputSchema: searchProductDocsArguments.shape,
      annotations: READ_ONLY,
    };
  }

  readonly category = ToolCategory.Docs;
  // No service-block requirement; enabled on any connection.
  readonly predicate = alwaysEnabled;
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

/** Non-2xx answer of a source, with the status kept for the caller to inspect. */
class SourceHttpError extends Error {
  constructor(
    label: string,
    readonly status: number,
    statusText: string,
  ) {
    super(`${label} ${status} ${statusText}`);
    this.name = "SourceHttpError";
  }
}

/** Fetches JSON with a timeout. Errors are rethrown prefixed with `label`. */
async function fetchSourceJson<T>(
  url: string,
  init: RequestInit,
  label: string,
): Promise<T> {
  const response = await fetchSource(url, init, label);
  return (await response.json()) as T;
}

/** Fetches a text body with a timeout. Errors are rethrown prefixed with `label`. */
async function fetchSourceText(
  url: string,
  init: RequestInit,
  label: string,
): Promise<string> {
  const response = await fetchSource(url, init, label);
  return response.text();
}

async function fetchSource(
  url: string,
  init: RequestInit,
  label: string,
): Promise<Response> {
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
    throw new SourceHttpError(label, response.status, response.statusText);
  }
  return response;
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

// Indices into [docs, developer, support]: docs and dev get 2× weight, support 1×.
const PICKUP_PATTERN = [0, 1, 1, 0, 2] as const;

/** Interleaves sources per PICKUP_PATTERN, dedupes by URL, stops at `limit`. */
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
    for (const s of PICKUP_PATTERN) {
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
 * Title may be a string or a `[seo, display]` array; pick the shorter one
 * (usually the cleaner display title). Returns null if no usable title.
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
    .replaceAll(/<[^>]+>/g, " ")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll(/\s+/g, " ")
    .trim();
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + "…";
}
