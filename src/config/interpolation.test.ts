import { interpolateValues } from "@src/config/interpolation.js";
import { describe, expect, it } from "vitest";

describe("config/interpolation.ts", () => {
  describe("interpolateValues", () => {
    const env = {
      MY_VAR: "hello",
      MY_VAR_99: "99",
      EMPTY_VAR: "",
      MULTI: "a,b,c",
    };

    describe("basic ${VAR} substitution", () => {
      it("should replace a known variable", () => {
        expect(interpolateValues("${MY_VAR}", env)).toBe("hello");
      });

      it("should replace a variable with a numeric suffix", () => {
        expect(interpolateValues("${MY_VAR_99}", env)).toBe("99");
      });

      it("should replace a variable embedded in a larger string", () => {
        expect(interpolateValues("prefix-${MY_VAR}-suffix", env)).toBe(
          "prefix-hello-suffix",
        );
      });

      it("should replace multiple variables in one string", () => {
        expect(interpolateValues("${MY_VAR}:${MULTI}", env)).toBe(
          "hello:a,b,c",
        );
      });

      it("should substitute an empty-string variable as empty string", () => {
        expect(interpolateValues("${EMPTY_VAR}", env)).toBe("");
      });
    });

    describe("${VAR:-default} default values", () => {
      it("should use the default when the variable is absent", () => {
        expect(interpolateValues("${MISSING:-fallback}", env)).toBe("fallback");
      });

      it("should use the actual value when the variable is present", () => {
        expect(interpolateValues("${MY_VAR:-fallback}", env)).toBe("hello");
      });

      it("should use the actual value (empty string) when the variable is present but empty", () => {
        // Variable exists in env with value ""; default should NOT kick in
        expect(interpolateValues("${EMPTY_VAR:-fallback}", env)).toBe("");
      });

      it("should use an empty default when specified as ${VAR:-}", () => {
        expect(interpolateValues("${MISSING:-}", env)).toBe("");
      });
    });

    describe("$${...} escape sequences", () => {
      it("should render $${LITERAL} as literal ${LITERAL}", () => {
        expect(interpolateValues("$${LITERAL}", env)).toBe("${LITERAL}");
      });

      it("should not interpolate the escaped variable name", () => {
        // MY_VAR is in env, but $${MY_VAR} should not be substituted
        expect(interpolateValues("$${MY_VAR}", env)).toBe("${MY_VAR}");
      });

      it("should handle escape alongside a real substitution", () => {
        expect(
          interpolateValues("real=${MY_VAR} escaped=$${MY_VAR}", env),
        ).toBe("real=hello escaped=${MY_VAR}");
      });
    });

    describe("missing variable error handling", () => {
      it("should throw a descriptive error for an undefined variable", () => {
        expect(() => interpolateValues("${MISSING}", env)).toThrow(
          "Environment variable not found: MISSING (referenced in ${MISSING})",
        );
      });
    });

    describe("recursive interpolation", () => {
      it("should interpolate values in a nested object", () => {
        const input = {
          outer: "${MY_VAR}",
          nested: {
            inner: "${MULTI}",
            deep: {
              value: "${MY_VAR}-${MULTI}",
            },
          },
        };
        expect(interpolateValues(input, env)).toStrictEqual({
          outer: "hello",
          nested: {
            inner: "a,b,c",
            deep: {
              value: "hello-a,b,c",
            },
          },
        });
      });

      it("should interpolate values inside arrays", () => {
        const input = ["${MY_VAR}", "${MULTI}", "literal"];
        expect(interpolateValues(input, env)).toStrictEqual([
          "hello",
          "a,b,c",
          "literal",
        ]);
      });

      it("should interpolate strings inside arrays nested in objects", () => {
        const input = { items: ["${MY_VAR}", "${MULTI}"] };
        expect(interpolateValues(input, env)).toStrictEqual({
          items: ["hello", "a,b,c"],
        });
      });
    });

    describe("non-string values are unchanged", () => {
      it("should leave numbers unchanged", () => {
        expect(interpolateValues(42, env)).toBe(42);
      });

      it("should leave booleans unchanged", () => {
        expect(interpolateValues(true, env)).toBe(true);
        expect(interpolateValues(false, env)).toBe(false);
      });

      it("should leave null unchanged", () => {
        expect(interpolateValues(null, env)).toBeNull();
      });

      it("should leave undefined unchanged", () => {
        expect(interpolateValues(undefined, env)).toBeUndefined();
      });

      it("should leave number fields in objects unchanged", () => {
        const input = { port: 9092, host: "${MY_VAR}" };
        expect(interpolateValues(input, env)).toStrictEqual({
          port: 9092,
          host: "hello",
        });
      });
    });
  });
});
