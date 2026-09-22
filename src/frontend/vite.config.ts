import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";
import fs from "node:fs";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: {
    port: Number(process.env.VITE_DEV_PORT ?? 4173),
    // THE DEV SERVER MUST BE ABLE TO REACH A SYMLINKED node_modules, OR IT SERVES NO FONTS.
    //
    // This product self-hosts Figtree rather than pulling it from a CDN, so the faces come out
    // of node_modules. A git worktree of this repo symlinks node_modules to the primary
    // checkout — which is OUTSIDE the worktree root — and Vite's filesystem allow-list refuses
    // anything outside that root, so every .woff2 is answered 403 with a line in the log that
    // reads like noise: "is outside of Vite serving allow list".
    //
    // Nothing looks broken. The page renders in the fallback face and carries on, and that is
    // the whole problem: a fallback has different metrics from Figtree, so every layout test
    // measuring whether text fits its box is measuring the wrong typeface. A narrow-screen
    // overflow test therefore passed locally and failed on CI, where npm ci puts a real
    // node_modules in place and the real font loads. A test that cannot see the defect is
    // worse than no test, because it is trusted.
    //
    // `realpath` because the allow-list is compared after symlink resolution.
    fs: { allow: [path.resolve(__dirname), fs.realpathSync(path.resolve(__dirname, "node_modules"))] },
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
      // The Playwright suite runs against this same dev server, so until now no browser test
      // could have caught a photo regression either.
      "/uploads": { target: process.env.VITE_API_TARGET ?? "http://localhost:5238", changeOrigin: true },
    },
  },

  // `vite preview` serves the PRODUCTION bundle, and it does not inherit `server.proxy` —
  // without this block a preview answers /api with the SPA's index.html and every screen
  // reads as a broken product. It matters beyond convenience: the dev server is the one
  // artefact that carries the sign-in shortcut (`production-posture.test.ts` proves the
  // built bundle does not), so a reviewer asked to walk the product as a member can only
  // be walking the real sign-in if they are walking a preview. Same three routes as above,
  // same env override, so the two servers cannot drift.
  preview: {
    port: Number(process.env.VITE_PREVIEW_PORT ?? 4174),
    proxy: {
      "/api": { target: process.env.VITE_API_TARGET ?? "http://localhost:5238", changeOrigin: true },
      "/healthz": { target: process.env.VITE_API_TARGET ?? "http://localhost:5238", changeOrigin: true },
      "/uploads": { target: process.env.VITE_API_TARGET ?? "http://localhost:5238", changeOrigin: true },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    // The club under test is in Johannesburg and several suites assert a wall-clock time a
    // member would read ("opens for you at 18:30"). Without this the runner's own zone decides
    // the answer: green on a Mac in SAST, red on a CI runner in UTC, and nothing in the failure
    // says why. Pinned here rather than in each test so the next one cannot forget.
    //
    // R3-3 — and the pin is also a blind spot, so it has a door in it. The club's zone IS the
    // runner's zone, so a doors formatter that silently used the browser's produced exactly the
    // same string as one that used the club's, and the whole suite agreed with a screen that was
    // a day out in Auckland. `VITEST_TZ=Pacific/Auckland npx vitest run src/lib/clubClock.test.ts`
    // runs a suite somewhere else on purpose. It is NOT `TZ`: a CI image that exports TZ=UTC
    // would otherwise silently unpin every clock assertion in the product.
    env: { TZ: process.env.VITEST_TZ ?? "Africa/Johannesburg" },
    setupFiles: ["./src/test/setup.ts"],

    // vitest's default include is `**/*.{test,spec}.?(c|m)[jt]s?(x)` from the project
    // root, which swallows the Playwright specs in e2e/ and then fails with
    // "Playwright Test did not expect test() to be called here" — a message that
    // reads as a broken Playwright install and is not one. Two runners, two
    // directories: unit tests live under src/, browser tests under e2e/.
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
});
