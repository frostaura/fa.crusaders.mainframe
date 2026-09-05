import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The PWA promise in `docs/specs/feature-spec.md` §12, measured against what is actually shipped.
 *
 * <p>
 * The spec says "installable as a PWA on iOS and Android home screens" and "functional offline
 * for read-only operations (view today's bookings, view balance from cache)";
 * `docs/specs/client-blueprint-deltas.md` marks the blueprint's A.1 done and
 * `docs/system-blueprint.html` calls the member app "installable". `dist/` held an index.html,
 * a favicon and an assets folder — no manifest, no service worker, no apple-touch-icon. Three
 * documents agreed on something the build did not do.
 * </p>
 *
 * <p>
 * These read the SOURCES rather than `dist/`, so they are a real gate rather than an assertion
 * about whether somebody happened to run a build first. Vite copies `public/` verbatim, and the
 * asserted files all live there.
 * </p>
 */

const root = resolve(__dirname, "..");
const read = (rel: string) => readFileSync(resolve(root, rel), "utf8");

describe("installable", () => {
  const manifest = JSON.parse(read("public/manifest.webmanifest")) as {
    name: string; short_name: string; start_url: string; display: string;
    background_color: string; theme_color: string;
    icons: { src: string; sizes: string; type: string; purpose: string }[];
  };

  it("has a manifest the browser will accept as installable", () => {
    // Chrome's installability bar, in full: name, a 192 and a 512 icon, start_url, and a
    // display mode that is not "browser".
    expect(manifest.name).toBeTruthy();
    expect(manifest.short_name).toBeTruthy();
    expect(manifest.start_url).toMatch(/^\//);
    expect(["standalone", "fullscreen", "minimal-ui"]).toContain(manifest.display);
    expect(manifest.background_color).toBeTruthy();
    expect(manifest.theme_color).toBeTruthy();

    const sizes = manifest.icons.map((i) => i.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
    // Android crops a non-maskable icon into a circle and clips the mark; a maskable variant
    // is what makes the home-screen icon look deliberate rather than truncated.
    expect(manifest.icons.some((i) => i.purpose === "maskable")).toBe(true);
  });

  it("ships every icon the manifest names, as a real PNG", () => {
    for (const icon of manifest.icons) {
      const bytes = readFileSync(resolve(root, "public", icon.src.replace(/^\//, "")));
      // The PNG signature. A committed placeholder — an SVG renamed, an empty file — passes a
      // "does the file exist" check and fails on a phone.
      expect(bytes.subarray(0, 8).toString("hex"), `${icon.src} is not a PNG`).toBe("89504e470d0a1a0a");
      expect(bytes.byteLength).toBeGreaterThan(500);
    }
  });

  it("carries the tags iOS reads, because Safari ignores the manifest for Add to Home Screen", () => {
    const html = read("index.html");
    expect(html).toContain('rel="manifest"');
    expect(html).toContain('rel="apple-touch-icon"');
    expect(html).toContain('name="apple-mobile-web-app-capable"');
    const touch = readFileSync(resolve(root, "public/apple-touch-icon.png"));
    expect(touch.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  });
});

describe("the offline shell", () => {
  const sw = read("public/sw.js");

  /**
   * What the worker DOES is asserted in `src/serviceWorker.test.ts`, which evaluates this same
   * file and drives real fetch, message and activate events through it. String matching cannot
   * tell a caching rule from a comment about one — the version of these tests that shipped
   * passed unchanged against a worker that cached three members' wallets in a shared cache.
   * What is left here is the wiring between the app and the worker, which is genuinely a
   * source-level fact.
   */

  it("registers only in a production build", () => {
    // A service worker in front of the dev server serves a stale module graph after every edit,
    // and the symptom is indistinguishable from a broken build.
    expect(read("src/main.tsx")).toMatch(/import\.meta\.env\.PROD.*registerServiceWorker/);
  });

  it("clears the caches on every route by which a session ends, not only the sign-out button", () => {
    const auth = read("src/lib/auth.tsx");
    // endSession — an expiry, a revocation, an admin reset; the 401 handler; and the button.
    // Three call sites, because on a shared club device the button is the rarest of the three.
    expect(auth.match(/clearOfflineCache\(\)/g) ?? []).toHaveLength(3);
    expect(read("src/lib/pwa.ts")).toContain("CLEAR_CACHES");
    expect(sw).toContain("CLEAR_CACHES");
  });
});
