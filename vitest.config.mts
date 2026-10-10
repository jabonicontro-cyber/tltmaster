import { defineConfig } from "vitest/config";


export default defineConfig({
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
      // server-only throws outside the React server runtime; tests import server modules directly.
      "server-only": new URL("./tests/support/empty.ts", import.meta.url).pathname,
    },
  },
  test: {
    environment: "node",
    projects: [
      {
        extends: true,
        test: { name: "unit", include: ["tests/unit/**/*.test.ts", "tests/unit/**/*.test.tsx"] },
      },
      {
        extends: true,
        test: {
          name: "db",
          include: ["tests/db/**/*.test.ts"],
          // Database tests share one database; run files sequentially.
          fileParallelism: false,
          testTimeout: 20000,
          hookTimeout: 30000,
        },
      },
      {
        extends: true,
        test: {
          // Real Supabase Storage + PostgREST over HTTP (skipped when not running).
          name: "storage",
          include: ["tests/storage/**/*.test.ts"],
          fileParallelism: false,
          testTimeout: 30000,
          hookTimeout: 60000,
        },
      },
    ],
  },
});
