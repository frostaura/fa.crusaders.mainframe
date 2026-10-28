import { beforeEach, describe, expect, it } from "vitest";
import {
  CSS_CACHE_KEY, STYLE_ELEMENT_ID, accentRoles, applyStoredOverrides, loadOverrides, resolveOverrides, saveOverrides,
} from "./themeOverrides";
import { contrastRatio, roles, themes } from "./tokens";

describe("resolveOverrides", () => {
  it("applies a readable override and compiles it against the right theme", () => {
    const { applied, rejected, css } = resolveOverrides({ light: { "bg-app": "#FFF8E7" } });
    expect(rejected).toEqual([]);
    expect(applied.light).toEqual({ "bg-app": "#FFF8E7" });
    expect(css).toBe("@media not print{html:not(.dark){--color-bg-app:255 248 231}}");
  });

  it("refuses text that cannot be read on the shipped surfaces, naming the pair", () => {
    const { applied, rejected, css } = resolveOverrides({ light: { "text-primary": "#EEEEEE" } });
    expect(applied.light).toBeUndefined();
    expect(css).toBe("");
    expect(rejected[0]).toMatchObject({ role: "text-primary", theme: "light" });
    expect(rejected[0].reason).toMatch(/text primary on [a-z ]+ would be [\d.]+:1 — needs 4\.5:1/);
  });

  it("refuses a background that breaks the fixed status colours drawn on it", () => {
    // A mid-green page: success-strong text on it falls under 4.5:1.
    const { rejected } = resolveOverrides({ light: { "bg-muted": "#15803D" } });
    expect(rejected.map((r) => r.role)).toContain("bg-muted");
  });

  it("rejects malformed values without throwing", () => {
    const { rejected } = resolveOverrides({ dark: { ring: "red" as string } });
    expect(rejected[0].reason).toMatch(/#RRGGBB/);
  });

  it("keeps the other overrides when one is refused", () => {
    const { applied } = resolveOverrides({ light: { "bg-app": "#FFF8E7", "text-primary": "#EEEEEE" } });
    expect(applied.light).toEqual({ "bg-app": "#FFF8E7" });
  });

  it("does not blame the member for a pair the shipped palette already fails", () => {
    // Whatever the base theme fails today must not reject an unrelated, harmless override.
    const r = resolveOverrides({ dark: { border: "#30405F" } });
    expect(r.rejected).toEqual([]);
  });
});

describe("accentRoles", () => {
  it("derives an accent that passes for a deep colour in both themes", () => {
    for (const theme of ["light", "dark"] as const) {
      const set = accentRoles("#6D28D9", theme);
      const { rejected } = resolveOverrides({ [theme]: set });
      const r: Record<string, string> = { ...roles(theme), ...(set as Record<string, string>) };
      expect(contrastRatio(r["primary-ink"], r.primary)).toBeGreaterThanOrEqual(4.5);
      expect(rejected.filter((x) => x.role === "primary-ink")).toEqual([]);
    }
  });

  it("refuses a yellow accent in the light theme rather than bending it", () => {
    const { applied, rejected } = resolveOverrides({ light: accentRoles("#FFEB3B", "light") });
    expect(rejected.length).toBeGreaterThan(0);
    expect(applied.light?.["accent-strong"]).toBeUndefined();
  });

  it("never touches the crest or status roles", () => {
    expect(Object.keys(accentRoles("#6D28D9", "light")).some((k) => k.startsWith("brand") || k.startsWith("danger"))).toBe(false);
    expect(themes.light.brand.strong).toBe("#00498D");
  });
});

describe("persistence", () => {
  beforeEach(() => { window.localStorage.clear(); document.getElementById(STYLE_ELEMENT_ID)?.remove(); });

  it("stores per member, paints, and caches the css for the boot script", () => {
    saveOverrides("u1", { light: { "bg-app": "#FFF8E7" } });
    expect(document.getElementById(STYLE_ELEMENT_ID)?.textContent).toContain("--color-bg-app:255 248 231");
    expect(window.localStorage.getItem(CSS_CACHE_KEY)).toContain("255 248 231");
    expect(loadOverrides("u2")).toEqual({});
    expect(loadOverrides("u1").light).toEqual({ "bg-app": "#FFF8E7" });
  });

  it("switching member repaints with the new member's colours, or none", () => {
    saveOverrides("u1", { light: { "bg-app": "#FFF8E7" } });
    applyStoredOverrides("u2");
    expect(document.getElementById(STYLE_ELEMENT_ID)).toBeNull();
    expect(window.localStorage.getItem(CSS_CACHE_KEY)).toBeNull();
  });

  it("ignores corrupt storage and unknown roles", () => {
    window.localStorage.setItem("crusaders:theme-overrides:u1", "{nope");
    expect(loadOverrides("u1")).toEqual({});
    window.localStorage.setItem("crusaders:theme-overrides:u1", JSON.stringify({ light: { brand: "#000000", "bg-app": "#FFFFFF" } }));
    expect(loadOverrides("u1")).toEqual({ light: { "bg-app": "#FFFFFF" } });
  });

  it("an empty request clears everything", () => {
    saveOverrides("u1", { light: { "bg-app": "#FFF8E7" } });
    saveOverrides("u1", {});
    expect(window.localStorage.getItem("crusaders:theme-overrides:u1")).toBeNull();
    expect(document.getElementById(STYLE_ELEMENT_ID)).toBeNull();
  });
});
