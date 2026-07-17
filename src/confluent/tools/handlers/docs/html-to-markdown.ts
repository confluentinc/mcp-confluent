import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";

// Confluent doc pages only ever exercise a small, known set of tags (headings,
// paragraphs, lists, links, code, tables, images), per the real-page samples
// pulled via search-product-docs during evaluation. This covers that set
// directly with cheerio instead of pulling in a general-purpose HTML-to-
// Markdown library and its own bundled HTML parser dependency.

const INDENT = "  ";

// Tags that always start a new block. Anything else encountered directly
// inside a container (bare text, <a>, <img>, <strong>, ...) is a loose
// inline run, e.g. `<div>See <a href="...">this</a></div>`, and gets
// grouped into one paragraph rather than losing its markup.
const BLOCK_TAGS = new Set([
  "p",
  "div",
  "section",
  "article",
  "aside",
  "main",
  "header",
  "footer",
  "figure",
  "blockquote",
  "pre",
  "ul",
  "ol",
  "li",
  "table",
  "hr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
]);

export function htmlToMarkdown(html: string | null): string {
  if (!html) return "";
  const $ = cheerio.load(html);
  const body = $("body").get(0);
  if (!body) return "";
  return renderBlockChildren($, body)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function renderBlockChildren(
  $: cheerio.CheerioAPI,
  el: AnyNode,
  depth = 0,
): string {
  const blocks: string[] = [];
  let inlineRun: AnyNode[] = [];

  const flushInlineRun = () => {
    const text = inlineRun.map((node) => renderInlineNode($, node)).join("");
    const trimmed = text.trim();
    if (trimmed) blocks.push(trimmed);
    inlineRun = [];
  };

  $(el)
    .contents()
    .each((_, node) => {
      if (node.type === "tag" && BLOCK_TAGS.has(node.tagName.toLowerCase())) {
        flushInlineRun();
        const rendered = renderBlockNode($, node, depth).trim();
        if (rendered) blocks.push(rendered);
      } else {
        inlineRun.push(node);
      }
    });
  flushInlineRun();

  return blocks.join("\n\n");
}

function renderBlockNode(
  $: cheerio.CheerioAPI,
  node: AnyNode,
  depth: number,
): string {
  if (node.type !== "tag") return "";

  const tag = node.tagName.toLowerCase();
  switch (tag) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return renderHeading($, node, tag);
    case "p":
      return renderInlineChildren($, node).trim();
    case "blockquote":
      return renderBlockquote($, node, depth);
    case "pre":
      return renderCodeBlock($, node);
    case "ul":
    case "ol":
      return renderList($, node, tag, depth);
    case "table":
      return renderTable($, node);
    case "hr":
      return "---";
    default:
      // Wrapping containers (div, section, article, aside, ...) aren't
      // structural on their own, so flatten to the blocks they contain.
      return renderBlockChildren($, node, depth);
  }
}

function renderHeading(
  $: cheerio.CheerioAPI,
  el: AnyNode,
  tag: string,
): string {
  const level = Number(tag[1]);
  return `${"#".repeat(level)} ${renderInlineChildren($, el).trim()}`;
}

function renderBlockquote(
  $: cheerio.CheerioAPI,
  el: AnyNode,
  depth: number,
): string {
  const inner = renderBlockChildren($, el, depth);
  return inner
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
}

function renderCodeBlock($: cheerio.CheerioAPI, el: AnyNode): string {
  const code = $(el).find("code").first();
  const text = (code.length > 0 ? code.text() : $(el).text()).replace(
    /\n+$/,
    "",
  );
  return "```\n" + text + "\n```";
}

function renderList(
  $: cheerio.CheerioAPI,
  el: AnyNode,
  tag: string,
  depth: number,
): string {
  const ordered = tag === "ol";
  return $(el)
    .children("li")
    .toArray()
    .map((li, index) => renderListItem($, li, ordered, index, depth))
    .join("\n");
}

function renderListItem(
  $: cheerio.CheerioAPI,
  li: AnyNode,
  ordered: boolean,
  index: number,
  depth: number,
): string {
  const marker = ordered ? `${index + 1}.` : "-";
  const nested = $(li).children("ul, ol");
  const ownContent = $(li).clone();
  ownContent.children("ul, ol").remove();
  const text = renderInlineChildren($, ownContent.get(0)!).trim();

  const lines = [`${INDENT.repeat(depth)}${marker} ${text}`];
  nested.each((_, nestedList) => {
    lines.push(renderList($, nestedList, nestedList.tagName, depth + 1));
  });
  return lines.join("\n");
}

function renderTable($: cheerio.CheerioAPI, el: AnyNode): string {
  // Real-world tables vary: proper <thead>/<th>, <th> rows with no <thead>
  // wrapper, and Zendesk's plain <td>-only markup. All three are just "first
  // row is the header, the rest is body", so there's no need to special-case <thead>.
  const rowCells = (tr: AnyNode) =>
    $(tr)
      .find("th, td")
      .toArray()
      .map((cell) => renderInlineChildren($, cell).trim());

  const [headerRow, ...bodyRows] = $(el).find("tr").toArray();
  if (!headerRow) return "";
  const header = rowCells(headerRow);
  if (header.length === 0) return "";

  const headerLine = `| ${header.join(" | ")} |`;
  const separatorLine = `| ${header.map(() => "---").join(" | ")} |`;
  const bodyLines = bodyRows.map((tr) => `| ${rowCells(tr).join(" | ")} |`);
  return [headerLine, separatorLine, ...bodyLines].join("\n");
}

function renderInlineChildren($: cheerio.CheerioAPI, el: AnyNode): string {
  return $(el)
    .contents()
    .toArray()
    .map((node) => renderInlineNode($, node))
    .join("");
}

function renderInlineNode($: cheerio.CheerioAPI, node: AnyNode): string {
  if (node.type === "text") return escapeText(node.data ?? "");
  if (node.type !== "tag") return "";

  const tag = node.tagName.toLowerCase();
  switch (tag) {
    case "strong":
    case "b":
      return `**${renderInlineChildren($, node).trim()}**`;
    case "em":
    case "i":
      return `_${renderInlineChildren($, node).trim()}_`;
    case "code":
      return `\`${$(node).text()}\``;
    case "a":
      return renderLink($, node);
    case "img":
      return `![${$(node).attr("alt") ?? ""}](${$(node).attr("src") ?? ""})`;
    case "br":
      return "\n";
    case "script":
    case "style":
    case "noscript":
      return "";
    default:
      return renderInlineChildren($, node);
  }
}

function renderLink($: cheerio.CheerioAPI, el: AnyNode): string {
  const href = $(el).attr("href");
  const text = renderInlineChildren($, el).trim();
  // Drop empty-text anchors (e.g. heading permalink icons) rather than
  // emitting a bare, meaningless `[](url)`.
  if (!text) return "";
  return href ? `[${text}](${href})` : text;
}

// Collapses HTML source whitespace/newlines to single spaces and escapes the
// handful of characters that would otherwise be misread as Markdown syntax.
function escapeText(text: string): string {
  return text.replace(/\s+/g, " ").replace(/[*_`\\]/g, "\\$&");
}
