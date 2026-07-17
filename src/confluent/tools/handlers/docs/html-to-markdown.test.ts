import { htmlToMarkdown } from "@src/confluent/tools/handlers/docs/html-to-markdown.js";
import { describe, expect, it } from "vitest";

describe("html-to-markdown.ts", () => {
  describe("htmlToMarkdown()", () => {
    it("should return an empty string for null or empty input", () => {
      expect(htmlToMarkdown(null)).toBe("");
      expect(htmlToMarkdown("")).toBe("");
    });

    it("should render a heading followed by a paragraph", () => {
      const html = "<h1>Title</h1><p>Some body text.</p>";
      expect(htmlToMarkdown(html)).toBe("# Title\n\nSome body text.");
    });

    it("should render nested heading levels", () => {
      expect(htmlToMarkdown("<h3>Sub-heading</h3>")).toBe("### Sub-heading");
    });

    it("should drop empty headings instead of emitting a bare ###", () => {
      const html = '<h3 id="spacer"> </h3><p>Body.</p>';
      expect(htmlToMarkdown(html)).toBe("Body.");
    });

    it("should render bold, italic, and inline code", () => {
      const html =
        "<p>Some <b>bold</b>, <i>italic</i>, and <code>inline.code</code> text.</p>";
      expect(htmlToMarkdown(html)).toBe(
        "Some **bold**, _italic_, and `inline.code` text.",
      );
    });

    it("should render a link", () => {
      const html = '<p>See <a href="https://example.com">the docs</a>.</p>';
      expect(htmlToMarkdown(html)).toBe("See [the docs](https://example.com).");
    });

    it("should render an image", () => {
      const html = '<img src="/img/arch.png" alt="architecture diagram">';
      expect(htmlToMarkdown(html)).toBe(
        "![architecture diagram](/img/arch.png)",
      );
    });

    it("should render a fenced code block, preserving internal whitespace", () => {
      const html =
        "<pre><code>kafka-topics --create --topic foo\n  --partitions 3</code></pre>";
      expect(htmlToMarkdown(html)).toBe(
        "```\nkafka-topics --create --topic foo\n  --partitions 3\n```",
      );
    });

    it("should render an unordered list", () => {
      const html = "<ul><li>Item one</li><li>Item two</li></ul>";
      expect(htmlToMarkdown(html)).toBe("- Item one\n- Item two");
    });

    it("should render an ordered list", () => {
      const html = "<ol><li>First</li><li>Second</li></ol>";
      expect(htmlToMarkdown(html)).toBe("1. First\n2. Second");
    });

    it("should indent a nested list under its parent item", () => {
      const html =
        "<ul><li>Parent<ul><li>Child one</li><li>Child two</li></ul></li></ul>";
      expect(htmlToMarkdown(html)).toBe(
        "- Parent\n  - Child one\n  - Child two",
      );
    });

    it("should render a blockquote", () => {
      expect(htmlToMarkdown("<blockquote><p>Note this.</p></blockquote>")).toBe(
        "> Note this.",
      );
    });

    it("should render a table with an explicit thead/tbody", () => {
      const html =
        "<table><thead><tr><th>Config</th><th>Default</th></tr></thead>" +
        "<tbody><tr><td>retention.ms</td><td>604800000</td></tr></tbody></table>";
      expect(htmlToMarkdown(html)).toBe(
        "| Config | Default |\n| --- | --- |\n| retention.ms | 604800000 |",
      );
    });

    it("should render a table with a <th> header row but no <thead> wrapper", () => {
      const html =
        "<table><tr><th>Config</th><th>Default</th></tr>" +
        "<tr><td>retention.ms</td><td>604800000</td></tr></table>";
      expect(htmlToMarkdown(html)).toBe(
        "| Config | Default |\n| --- | --- |\n| retention.ms | 604800000 |",
      );
    });

    it("should render a plain <td>-only table (e.g. Zendesk-authored HTML)", () => {
      const html =
        "<table><tr><td>Config</td><td>Default</td></tr>" +
        "<tr><td>retention.ms</td><td>604800000</td></tr></table>";
      expect(htmlToMarkdown(html)).toBe(
        "| Config | Default |\n| --- | --- |\n| retention.ms | 604800000 |",
      );
    });

    it("should flatten wrapping containers like div and section", () => {
      const html =
        '<div class="wrapper"><section><h2>Heading</h2><p>Body.</p></section></div>';
      expect(htmlToMarkdown(html)).toBe("## Heading\n\nBody.");
    });

    it("should keep the link when loose inline content sits directly in a div without a <p>", () => {
      const html =
        '<div style="text-align: right">See <a href="/tutorial/">this tutorial</a>.</div>';
      expect(htmlToMarkdown(html)).toBe("See [this tutorial](/tutorial/).");
    });

    it("should drop empty-text anchors instead of emitting a bare [](url)", () => {
      const html = '<h2>Heading<a href="#heading"><span></span></a></h2>';
      expect(htmlToMarkdown(html)).toBe("## Heading");
    });

    it("should drop script and style tags", () => {
      const html =
        "<p>Visible.</p><script>console.log('x')</script><style>.a{}</style>";
      expect(htmlToMarkdown(html)).toBe("Visible.");
    });

    it("should collapse HTML source whitespace to single spaces", () => {
      const html = "<p>\n  Line one\n  Line two  \n</p>";
      expect(htmlToMarkdown(html)).toBe("Line one Line two");
    });

    it("should escape literal Markdown-significant characters in plain text", () => {
      expect(
        htmlToMarkdown("<p>Use __consumer_offsets and *not* this.</p>"),
      ).toBe("Use \\_\\_consumer\\_offsets and \\*not\\* this.");
    });

    it("should not escape characters inside inline code", () => {
      expect(htmlToMarkdown("<p><code>__consumer_offsets</code></p>")).toBe(
        "`__consumer_offsets`",
      );
    });
  });
});
