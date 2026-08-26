import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      ".corepack/**",
      ".corepack-*/**",
      "**/dist/**",
      "**/tsbuild/**",
      "**/coverage/**",
      "**/temp/**",
      "docs/api/**",
      "examples/**",
      "node_modules/**",
      "pnpm-lock.yaml",
    ],
  },
  {
    files: ["**/*.{js,cjs,mjs}"],
    ...js.configs.recommended,
  },
  {
    files: ["scripts/**/*.{js,cjs,mjs}"],
    languageOptions: {
      globals: {
        process: "readonly",
        AbortController: "readonly",
      },
    },
  },
  {
    files: ["**/*.ts"],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.eslint.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          prefer: "type-imports",
          fixStyle: "inline-type-imports",
        },
      ],
      "@typescript-eslint/no-import-type-side-effects": "error",
    },
  },
  eslintConfigPrettier,
);
