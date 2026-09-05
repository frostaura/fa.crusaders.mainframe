import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: {
    port: Number(process.env.VITE_DEV_PORT ?? 4173),
    proxy: {
      "/api": { target: process.env.VITE_API_TARGET ?? "http://localhost:5238", changeOrigin: true },
      "/healthz": { target: process.env.VITE_API_TARGET ?? "http://localhost:5238", changeOrigin: true },

      // Uploaded member photos. The API stores a relative path
      // (/uploads/<tenant>/photos/<hash>.png) and the browser resolves it against the WEB
      // origin, so without this the dev server answered every photo with the SPA's
      // index.html and each avatar rendered as a broken image. nginx has carried
      // `location /uploads/` since it was written; only the dev config disagreed — which
      // meant photo-on-the-grid, the identification mechanism the whole registration flow
      // makes photos mandatory for, could never be seen working locally.
      "/uploads": { target: process.env.VITE_API_TARGET ?? "http://localhost:5238", changeOrigin: true },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],

    // vitest's default include is `**/*.{test,spec}.?(c|m)[jt]s?(x)` from the project
    // root, which swallows the Playwright specs in e2e/ and then fails with
    // "Playwright Test did not expect test() to be called here" — a message that
    // reads as a broken Playwright install and is not one. Two runners, two
    // directories: unit tests live under src/, browser tests under e2e/.
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
});
