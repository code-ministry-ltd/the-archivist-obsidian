import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

// Obsidian's own recommended rules, which its automated plugin review also applies.
export default defineConfig([
  { ignores: ["main.js", "node_modules/**", "esbuild.config.mjs", "version-bump.mjs", "vitest.config.ts"] },
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: { projectService: { allowDefaultProject: ["eslint.config.*"] } },
    },
    rules: {
      "obsidianmd/ui/sentence-case": [
        "warn",
        { brands: ["The Archivist", "Obsidian"], acronyms: ["MB"] },
      ],
    },
  },
  // Tests run in Node, and name `.obsidian` on purpose.
  {
    files: ["test/**"],
    rules: {
      "obsidianmd/prefer-window-timers": "off",
      "obsidianmd/hardcoded-config-path": "off",
      "obsidianmd/no-global-this": "off",
    },
  },
]);
