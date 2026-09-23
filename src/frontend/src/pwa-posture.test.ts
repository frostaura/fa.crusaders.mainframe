import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { themes } from "./lib/tokens";

/**
 * The installed app and the browser tab have to be the same app.
 *
 * <p>
 * They were not. `manifest.webmanifest` declared `theme_color: "#0369A1"` — the accent — while
 * `index.html` declared `theme-color: "#F8FAFC"` — the app background. Installed-PWA chrome and
 * browser-tab chrome therefore wore different colours for the same product, and neither file
 * gave any hint that the other existed. There was also no `color-scheme`. Since D7 the product
 * has two themes, so the page declares both and carries one `theme-color` per scheme.
 * </p>
 *
 * <p>
 * Two files that must agree and nothing that made them: that is what a test is for. Read from
 * disk rather than imported, because the manifest is a static asset that never goes through the
 * bundler.
 * </p>
 */

const ROOT = join(__dirname, "..");
const manifest = JSON.parse(readFileSync(join(ROOT, "public", "manifest.webmanifest"), "utf8")) as {
  theme_color: string;
  background_color: string;
};
const html = readFileSync(join(ROOT, "index.html"), "utf8");

/** The `content` of a `<meta name="…">` that carries no media query, or null. */
const meta = (name: string) =>
  html.match(new RegExp(`<meta\\s+name="${name}"\\s+content="([^"]*)"`, "i"))?.[1] ?? null;

/** Every `theme-color` meta, keyed by its `prefers-color-scheme` media value. */
const themeColors = () => Object.fromEntries(
  [...html.matchAll(/<meta\s+name="theme-color"\s+media="\(prefers-color-scheme:\s*(light|dark)\)"\s+content="([^"]*)"/gi)]
    .map((m) => [m[1].toLowerCase(), m[2]]),
);

describe("PWA chrome", () => {
  it("tints the browser chrome with each theme's own canvas", () => {
    // Two metas with media, one per scheme (D7) — and each is the token, not a transcription.
    expect(themeColors()).toEqual({ light: themes.light.bg.app, dark: themes.dark.bg.app });
    // No third, unconditional one competing with them.
    expect(meta("theme-color")).toBeNull();
  });

  it("gives the installed app the light canvas, the same as the light browser tab", () => {
    // The manifest has no media query; an installed PWA's splash and title bar use this one value.
    expect(manifest.theme_color.toUpperCase()).toBe(themes.light.bg.app.toUpperCase());
  });

  it("says it has both colour schemes", () => {
    // D7 retired "light only": the product ships a dark theme, and declaring both is what lets
    // native controls, scrollbars and the canvas follow whichever one is active. The rule that
    // no component writes `dark:` now lives in theme-vocabulary.test.ts — dark is token-only.
    expect(meta("color-scheme")).toBe("light dark");
  });

  it("keeps the splash background the app's own background", () => {
    // background_color is what an installed app paints before the first frame. If it disagrees
    // with the page the member lands on, the app flashes a different colour on every cold start.
    expect(manifest.background_color.toUpperCase()).toBe(manifest.theme_color.toUpperCase());
  });
});
