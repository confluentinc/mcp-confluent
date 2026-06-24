import { quoteJoinIds } from "@src/utils/quote-join-ids.js";
import { describe, expect, it } from "vitest";

describe("quote-join-ids.ts", () => {
  describe("quoteJoinIds()", () => {
    it.each([
      ["an empty list", [], ""],
      ["a single id", ["a"], '"a"'],
      ["a plain multi-id list", ["a", "b"], '"a", "b"'],
      [
        "an id containing a comma (wrapped so the comma stays inside the quotes)",
        ["c,d"],
        '"c,d"',
      ],
      [
        "an id containing a double quote (backslash-escaped)",
        ['a"b'],
        '"a\\"b"',
      ],
      [
        "multiple ids each carrying a comma or quote",
        ['a"b', "c,d"],
        '"a\\"b", "c,d"',
      ],
      ["an id that is only a double quote", ['"'], '"\\""'],
    ])("should render %s", (_label, ids: string[], expected) => {
      expect(quoteJoinIds(ids)).toBe(expected);
    });

    it("should preserve the caller's order rather than sorting", () => {
      expect(quoteJoinIds(["z", "a", "m"])).toBe('"z", "a", "m"');
    });
  });
});
