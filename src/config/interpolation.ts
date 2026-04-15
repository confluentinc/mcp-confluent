// Matches either:
//   $${...}         — escape sequence (group 1 = inner text)
//   ${VAR}          — basic substitution (group 2 = var name, group 3 = undefined)
//   ${VAR:-default} — substitution with default (group 2 = var name, group 3 = default)
const INTERPOLATION_RE =
  /\$\$\{([^}]*)\}|\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([\s\S]*?))?\}/g;

function interpolateString(
  value: string,
  env: Record<string, string | undefined>,
): string {
  return value.replaceAll(
    INTERPOLATION_RE,
    (
      match,
      escaped: string | undefined,
      varName: string | undefined,
      defaultValue: string | undefined,
    ) => {
      // $${...} → literal ${...}
      if (escaped !== undefined) {
        return `\${${escaped}}`;
      }

      // ${VAR} or ${VAR:-default}
      const resolved = varName ? env[varName] : undefined;
      if (resolved !== undefined) {
        return resolved;
      }

      // Variable is absent from env — use default if provided
      if (defaultValue !== undefined) {
        return defaultValue;
      }

      throw new Error(
        `Environment variable not found: ${varName} (referenced in \${${varName}})`,
      );
    },
  );
}

/**
 * Recursively interpolates `${VAR}` and `${VAR:-default}` patterns in all
 * string values of the given object/array/primitive. Non-string leaves
 * (numbers, booleans, null, undefined) are returned unchanged.
 *
 * Escaping: `$${LITERAL}` is replaced with the literal text `${LITERAL}`.
 */
export function interpolateValues(
  obj: unknown,
  env: Record<string, string | undefined>,
): unknown {
  function walk(value: unknown): unknown {
    if (typeof value === "string") {
      return interpolateString(value, env);
    }
    if (Array.isArray(value)) {
      return value.map(walk);
    }
    if (value !== null && typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        result[k] = walk(v);
      }
      return result;
    }
    // number, boolean, null, undefined — unchanged
    return value;
  }

  return walk(obj);
}
