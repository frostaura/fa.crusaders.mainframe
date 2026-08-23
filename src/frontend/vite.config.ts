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
