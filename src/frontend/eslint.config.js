import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "node_modules"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: { ecmaVersion: 2022, globals: globals.browser },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  // Test-only modules are never served by Vite, so Fast Refresh (the reason for this rule) never applies to them.
  {
    files: ["src/test/**", "**/__tests__/**", "**/*.test.{ts,tsx}"],
    rules: { "react-refresh/only-export-components": "off" },
  },
  // Icons come through ONE barrel (design-system.md, Icons): per-icon paths, one reviewable
  // vocabulary, no package-root import that drags in ~1 500 icons. `src/icons.test.ts` holds the
  // same line on every commit. lucide-react is gone from the manifest, and banned so it stays gone.
  {
    files: ["**/*.{ts,tsx}"],
    ignores: ["src/components/ui/icons.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["@phosphor-icons/react", "@phosphor-icons/react/*"],
          message: "Import icons from \"@/components/ui/icons\" — add a re-export line there if one is missing.",
        }, {
          group: ["lucide-react", "lucide-react/*"],
          message: "The icon set is Phosphor, through \"@/components/ui/icons\".",
        }],
      }],
    },
  }
);
