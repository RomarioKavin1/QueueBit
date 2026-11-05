import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/node_modules/**",
      // Generated: WXT build output and types.
      "**/.output/**",
      "**/.wxt/**",
      "**/playwright-report/**",
      "**/test-results/**",
      // Generated: wasm-bindgen glue.
      "**/wasm/**",
      "contracts/**",
      "devnet/**",
      "docs/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    files: ["apps/extension/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser, ...globals.webextensions } },
  },
  {
    // React code only: Playwright fixtures also call a function named `use`.
    files: ["apps/extension/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  prettier,
);
