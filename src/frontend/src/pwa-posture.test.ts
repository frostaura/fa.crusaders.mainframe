import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The installed app and the browser tab have to be the same app.
 *
 * <p>
 * They were not. `manifest.webmanifest` declared `theme_color: "#0369A1"` — the accent — while
 * `index.html` declared `theme-color: "#F8FAFC"` — the app background. Installed-PWA chrome and
 * browser-tab chrome therefore wore different colours for the same product, and neither file
 * gave any hint that the other existed. There was also no `color-scheme`, so a browser in dark
 * mode is free to paint the form controls, the scrollbars and the canvas dark behind a palette
 * that has exactly one, light theme.
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

/** The `content` of a `<meta name="…">`, or null. */
const meta = (name: string) =>
  html.match(new RegExp(`<meta\\s+name="${name}"\\s+content="([^"]*)"`, "i"))?.[1] ?? null;

describe("PWA chrome", () => {
  it("uses one theme colour, not one per surface", () => {
    expect(meta("theme-color")).not.toBeNull();
    expect(manifest.theme_color.toUpperCase()).toBe(meta("theme-color")!.toUpperCase());
  });

  it("says which colour scheme it actually has", () => {
    // There is one palette and no `dark:` class anywhere in the product. Declaring it is what
    // stops a dark-mode browser painting its own chrome — native selects, date inputs,
    // scrollbars, the canvas behind the app — dark underneath a light page.
    expect(meta("color-scheme")).toBe("light");
  });

  it("keeps the splash background the app's own background", () => {
    // background_color is what an installed app paints before the first frame. If it disagrees
    // with the page the member lands on, the app flashes a different colour on every cold start.
    expect(manifest.background_color.toUpperCase()).toBe(manifest.theme_color.toUpperCase());
  });
});
