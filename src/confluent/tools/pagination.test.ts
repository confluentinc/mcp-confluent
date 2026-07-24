import {
  renderPaginationSection,
  toPaginationMeta,
} from "@src/confluent/tools/pagination.js";
import { describe, expect, it } from "vitest";

describe("pagination.ts", () => {
  describe("renderPaginationSection", () => {
    it("should return an empty string when metadata is undefined", () => {
      expect(renderPaginationSection(undefined, "Total Items")).toBe("");
    });

    it("should render the header but no link lines when metadata is present but empty", () => {
      const rendered = renderPaginationSection({}, "Total Items");
      expect(rendered).toContain("Pagination:");
      expect(rendered).not.toContain("Total Items:");
      expect(rendered).not.toContain("First Page:");
      expect(rendered).not.toContain("Last Page:");
      expect(rendered).not.toContain("Previous Page:");
      expect(rendered).not.toContain("Next Page:");
    });

    it("should render a total line of 0 when total_size is zero", () => {
      // Regression guard: a truthiness filter drops 0, omitting a legitimate
      // total. The filter must be undefined-based so a real zero still renders.
      expect(
        renderPaginationSection({ total_size: 0 }, "Total Environments"),
      ).toContain("Total Environments: 0");
    });

    it("should render every populated link line under the caller's total label", () => {
      const rendered = renderPaginationSection(
        {
          total_size: 7,
          first: "url-first",
          last: "url-last",
          prev: "url-prev",
          next: "url-next",
        },
        "Total Items",
      );
      expect(rendered).toContain("Total Items: 7");
      expect(rendered).toContain("First Page: url-first");
      expect(rendered).toContain("Last Page: url-last");
      expect(rendered).toContain("Previous Page: url-prev");
      expect(rendered).toContain("Next Page: url-next");
    });
  });

  describe("toPaginationMeta", () => {
    it("should return undefined when metadata is undefined", () => {
      expect(toPaginationMeta(undefined)).toBeUndefined();
    });

    it("should project only the four link fields, dropping total_size", () => {
      expect(
        toPaginationMeta({
          total_size: 7,
          first: "f",
          last: "l",
          prev: "p",
          next: "n",
        }),
      ).toEqual({ first: "f", last: "l", prev: "p", next: "n" });
    });

    it("should carry undefined link fields through when metadata is empty", () => {
      expect(toPaginationMeta({})).toEqual({
        first: undefined,
        last: undefined,
        prev: undefined,
        next: undefined,
      });
    });
  });
});
