import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    ".dev-stack/**",
    // Local scratch files (git-ignored).
    ".tmp/**",
    // Vendored design skills (reviewed copies; .claude/skills/TAVIRON-NOTES.md).
    ".claude/**",
  ]),
]);

export default eslintConfig;
