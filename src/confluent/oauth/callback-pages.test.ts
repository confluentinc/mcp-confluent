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
    it("should produce HTML containing the Confluent branding and success copy", () => {
      const html = renderSuccessPage();
      expect(html.toLowerCase()).toContain("<!doctype html>");
      expect(html).toContain("Authentication Complete");
      // SVG logo from the template
      expect(html).toContain("<svg");
      // Styles partial inlined
      expect(html).toContain("<style>");
      expect(html).not.toContain("{#include styles/}");
    });

    it("should include the agent-skills install hint, copy button, and beacon endpoint", () => {
      const html = renderSuccessPage();
      // Verbatim install command users will copy
      expect(html).toContain("npx skills add confluentinc/agent-skills");
      // Copy button and target box are wired by id
      expect(html).toContain('id="install-cmd"');
      expect(html).toContain('id="install-cmd-copy"');
      // Telemetry beacon path is referenced from the inline script
      expect(html).toContain("/skills-hint-copied");
    });

    it("should cache the rendered page across calls", () => {
      const readSpy = vi.spyOn(nodeDeps.fs, "readFileSync");
      const first = renderSuccessPage();
      const callsAfterFirst = readSpy.mock.calls.length;
      const second = renderSuccessPage();
      expect(second).toBe(first);
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
