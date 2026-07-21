import eslintComments from "@eslint-community/eslint-plugin-eslint-comments";
import pluginJs from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended";
import sonarjs from "eslint-plugin-sonarjs";
import unusedImports from "eslint-plugin-unused-imports";
import globals from "globals";
import tseslint from "typescript-eslint";

/** @type {import('eslint').Linter.Config[]} */
export default [
  { files: ["**/*.{js,mjs,cjs,ts}"] },
  // Any `eslint-disable*` comment that no longer suppresses a finding fails the build
  { linterOptions: { reportUnusedDisableDirectives: "error" } },
  { languageOptions: { globals: globals.browser } },
  {
    ignores: [
      "dist/**",
      "src/confluent/openapi-schema.d.ts",
      "coverage/**",
      ".worktrees/**",
      ".claude/**",
    ],
  },
  { files: ["scripts/**"], languageOptions: { globals: globals.node } },
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  eslintPluginPrettierRecommended,
  {
    plugins: {
      "unused-imports": unusedImports,
    },
    rules: {
      // Hand unused-variable/import detection to unused-imports, which adds
      // auto-fix support for import removal. Disabling both the core and TS
      // rules avoids double-reporting on JS and TS files respectively.
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "unused-imports/no-unused-imports": "error",
      "unused-imports/no-unused-vars": [
        "error",
        {
          vars: "all",
          varsIgnorePattern: "^_",
          args: "after-used",
          argsIgnorePattern: "^_",
        },
      ],
      // Production code reads service config from `ConnectionConfig`, not the
      // process env. The env singleton in `@src/env.js` only legitimately
      // serves the bootstrap (`initEnv`, called from `src/server-main.ts`) and
      // the legacy YAML-vs-env-config bridge (`Environment` type from
      // `src/config/env-config.ts`). The default export was retired in #234;
      // this rule slams the door so any future regression surfaces with a
      // useful message rather than a generic TypeScript "no default export"
      // error.
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@src/env.js",
              importNames: ["default"],
              message:
                "Use ConnectionConfig instead. The env singleton is consumed only by the bootstrap (initEnv) and the legacy env-config bridge; production code should not read it directly.",
            },
          ],
        },
      ],
    },
  },
  // Production code reads configuration from `MCPServerConfiguration` /
  // `ConnectionConfig`, never from `process.env`. The bootstrap allowlist
  // below is the only place that consults it: index.ts is the preflight shim
  // (reads NODE_ENV to skip auto-start under test), server-main.ts orchestrates
  // startup, cli.ts performs the -e dotenv mutation, env.ts parses the legacy
  // env-var schema, logger.ts reads LOG_LEVEL/LOG_PRETTY at module-load (before
  // main()). The dotenv mutation in cli.ts is intentional — it seeds
  // linked-library env-var consumption (OpenSSL, cyrus-sasl, krb5, undici)
  // outside our control. See #186 for the full rationale.
  {
    files: ["src/**/*.ts"],
    ignores: [
      "src/index.ts",
      "src/server-main.ts",
      "src/cli.ts",
      "src/env.ts",
      "src/logger.ts",
      "**/*.test.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "MemberExpression[object.name='process'][property.name='env']",
          message:
            "process.env may only be read in the bootstrap allowlist (src/index.ts, src/server-main.ts, src/cli.ts, src/env.ts, src/logger.ts). Read from MCPServerConfiguration or ConnectionConfig instead.",
        },
      ],
    },
  },
  // Mirror SonarQube's cognitive-complexity quality gate (rule
  // typescript:S3776, default threshold 15) locally, so `pnpm run lint` and the
  // pre-push hook flag an over-complex function before it reaches the
  // SonarCloud gate in CI. Only this one rule is enabled (not sonarjs'
  // `recommended` set) to avoid a flood of unrelated findings on existing code.
  // Scoped to non-test src to match `sonar.exclusions` (tests and generated
  // `.d.ts` are excluded from SonarQube analysis).
  {
    files: ["src/**/*.ts"],
    ignores: ["**/*.test.ts", "**/*.d.ts"],
    plugins: { sonarjs, "@eslint-community/eslint-comments": eslintComments },
    rules: {
      "sonarjs/cognitive-complexity": ["error", 15],
      // Prevent turning off complexity guard or generic any guard: no-restricted-disable
      // rejects any disable directive naming the complexity rule, and no-unlimited-disable
      // closes the nameless-directive escape hatch (a bare `eslint-disable-next-line`
      // suppresses all rules, including this one, and would otherwise slip
      // past no-restricted-disable).
      "@eslint-community/eslint-comments/no-restricted-disable": [
        "error",
        "sonarjs/cognitive-complexity",
      ],
      "@eslint-community/eslint-comments/no-unlimited-disable": "error",
    },
  },
];
