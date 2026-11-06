import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/dist-shared/**",
      "**/dist-relay/**",
      "**/coverage/**",
      "**/node_modules/**",
      // Generated: WXT build output and types.
      "**/.output/**",
      "**/.wxt/**",
      // Generated: Next.js build output and types.
      "**/.next/**",
      "apps/web/next-env.d.ts",
      "**/playwright-report/**",
      "**/test-results/**",
      // Generated: wasm-bindgen glue.
      "**/wasm/**",
      "contracts/**",
      "devnet/**",
      // Upstream checkouts / patch series and tool caches are not our source.
      "upstream/**",
      "**/.cache/**",
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
    files: ["apps/web/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser, ...globals.worker } },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    files: ["apps/web/public/sw.js"],
    languageOptions: { globals: { ...globals.serviceworker } },
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
