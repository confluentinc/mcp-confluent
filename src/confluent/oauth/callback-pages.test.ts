import * as nodeDeps from "@src/confluent/node-deps.js";
import {
  _resetCallbackPageCacheForTests,
  renderErrorPage,
  renderSuccessPage,
} from "@src/confluent/oauth/callback-pages.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("oauth/callback-pages.ts", () => {
  beforeEach(() => {
    _resetCallbackPageCacheForTests();
  });

  describe("renderSuccessPage", () => {
    const paths = {
      copiedPath: "/skills-hint-copied",
      streamPath: "/skills-hint-stream",
    };

    it("should produce HTML containing the Confluent branding and success copy", () => {
      const html = renderSuccessPage(paths);
      expect(html.toLowerCase()).toContain("<!doctype html>");
      expect(html).toContain("Authentication Complete");
      // SVG logo from the template
      expect(html).toContain("<svg");
      // Styles partial inlined
      expect(html).toContain("<style>");
      expect(html).not.toContain("{#include styles/}");
    });

    it("should include the agent-skills install hint, copy button, and injected endpoints", () => {
      const html = renderSuccessPage(paths);
      // Verbatim install command users will copy
      expect(html).toContain("npx skills add confluentinc/agent-skills");
      // Copy button and target box are wired by id
      expect(html).toContain('id="install-cmd"');
      expect(html).toContain('id="install-cmd-copy"');
      // The server's path constants land verbatim in the rendered HTML so the
      // template and server can't drift.
      expect(html).toContain(paths.copiedPath);
      expect(html).toContain(paths.streamPath);
      // Placeholders are fully substituted.
      expect(html).not.toContain("{{copiedPath}}");
      expect(html).not.toContain("{{streamPath}}");
    });

    it("should substitute different paths per call without rereading the template", () => {
      const readSpy = vi.spyOn(nodeDeps.fs, "readFileSync");
      const first = renderSuccessPage(paths);
      const callsAfterFirst = readSpy.mock.calls.length;
      const second = renderSuccessPage({
        copiedPath: "/alt-copied",
        streamPath: "/alt-stream",
      });
      expect(first).toContain(paths.copiedPath);
      expect(second).toContain("/alt-copied");
      expect(second).toContain("/alt-stream");
      // Template is cached after the first read — placeholder substitution
      // doesn't trigger another readFileSync.
      expect(readSpy.mock.calls.length).toBe(callsAfterFirst);
    });
  });

  describe("renderErrorPage", () => {
    it("should interpolate the message and inline styles", () => {
      const html = renderErrorPage("Something broke");
      expect(html).toContain("Authentication Failed");
      expect(html).toContain("Something broke");
      expect(html).toContain("<style>");
      expect(html).not.toContain("{#include styles/}");
      expect(html).not.toContain("{{error}}");
    });

    it("should HTML-escape the message to prevent injection", () => {
      const html = renderErrorPage(`<script>alert("xss")</script> & 'quotes'`);
      expect(html).not.toContain("<script>");
      expect(html).toContain("&lt;script&gt;");
      expect(html).toContain("&amp;");
      expect(html).toContain("&quot;");
      expect(html).toContain("&#39;");
    });

    it("should cache the failure template but re-interpolate per call", () => {
      const readSpy = vi.spyOn(nodeDeps.fs, "readFileSync");
      const first = renderErrorPage("first");
      const callsAfterFirst = readSpy.mock.calls.length;
      const second = renderErrorPage("second");
      expect(first).toContain("first");
      expect(second).toContain("second");
      expect(readSpy.mock.calls.length).toBe(callsAfterFirst);
    });
  });
});
