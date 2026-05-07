import pluginJs from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended";
import unusedImports from "eslint-plugin-unused-imports";
import globals from "globals";
import tseslint from "typescript-eslint";

/** @type {import('eslint').Linter.Config[]} */
export default [
  { files: ["**/*.{js,mjs,cjs,ts}"] },
  { languageOptions: { globals: globals.browser } },
  {
    ignores: [
      "dist/**",
      "src/confluent/openapi-schema.d.ts",
      "coverage/**",
      ".worktrees/**",
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
      // serves the bootstrap (`initEnv` named export from `src/index.ts`) and
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
];
