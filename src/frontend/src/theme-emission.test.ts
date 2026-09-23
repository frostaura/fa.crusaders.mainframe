import { readFileSync } from "node:fs";
import { join } from "node:path";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import { describe, expect, it } from "vitest";
import config from "../tailwind.config";
import { cssVariables, themes } from "./lib/tokens";
import { THEME_STORAGE_KEY } from "./lib/theme";

/**
 * What the Tailwind plugin actually writes — compiled, not assumed.
 *
 * <p>
 * The dark theme is nothing but a second block of custom properties. If `.dark` is missing a
 * key `:root` has, that role silently keeps its LIGHT value at night — a white card on a navy
 * page — and nothing in a unit test, a type check or a build notices. So this runs the real
 * PostCSS + Tailwind pipeline over the real config and reads the stylesheet it produces.
 * </p>
 *
 * <p>
 * It also pins the class that started all of this: an opacity modifier on a themed colour.
 * With the old `var(--x, #hex)` form Tailwind emitted NO rule for `ring-accent-strong/30` — not
 * a wrong colour, no rule — and three live classes vanished that way.
 * </p>
 */

const PROBE = [
  "bg-bg-app", "bg-overlay", "bg-overlay/50", "ring-accent-strong/30", "hover:border-accent-strong/60",
  "text-slot-mine-ink", "bg-slot-available-fill", "shadow-md", "z-popover", "min-h-touch", "size-touch",
  "max-w-narrow", "font-display", "font-heading", "tracking-overline", "duration-sheet", "animate-pop-in",
  "rounded-lg", "text-xs", "border", "ring-2",
].join(" ");

async function compile(): Promise<string> {
  const result = await postcss([
    tailwindcss({ ...config, content: [{ raw: `<div class="${PROBE}"></div>`, extension: "html" }] }),
  ]).process("@tailwind base;\n@tailwind utilities;", { from: undefined });
  return result.css;
}

/** The declarations of the FIRST top-level rule whose selector is exactly `selector`. */
function block(css: string, selector: string, within = css): Record<string, string> {
  const at = within.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no "${selector}" block in the compiled CSS`);
  const body = within.slice(at + selector.length + 2, within.indexOf("}", at));
  return Object.fromEntries(
    body.split(";").map((d) => d.trim()).filter(Boolean).map((d) => {
      const colon = d.indexOf(":");
      return [d.slice(0, colon).trim(), d.slice(colon + 1).trim()];
    }),
  );
}

const variablesOf = (decls: Record<string, string>) =>
  Object.fromEntries(Object.entries(decls).filter(([key]) => key.startsWith("--")));

describe("the theme variables the plugin emits", async () => {
  const css = await compile();
  const lightBlock = variablesOf(block(css, ":root, .light"));
  const darkBlock = variablesOf(block(css, ".dark"));

  it("declares the identical key set under :root and .dark", () => {
    expect(Object.keys(darkBlock).sort()).toEqual(Object.keys(lightBlock).sort());
    expect(Object.keys(lightBlock).length).toBeGreaterThan(40);
  });

  it("emits exactly what the token module says, in both themes", () => {
    expect(lightBlock).toEqual(cssVariables("light"));
    expect(darkBlock).toEqual(cssVariables("dark"));
  });

  it("tells the browser which scheme each block is", () => {
    expect(block(css, ":root, .light")["color-scheme"]).toBe("light");
    expect(block(css, ".dark")["color-scheme"]).toBe("dark");
  });

  it("prints light even from the dark theme", () => {
    const print = css.slice(css.indexOf("@media print"));
    expect(variablesOf(block(css, ".dark", print))).toEqual(cssVariables("light"));
  });

  it("declares every colour role as channels, never as hex", () => {
    for (const [name, value] of Object.entries(lightBlock)) {
      if (name.startsWith("--color-")) expect(value, name).toMatch(/^\d{1,3} \d{1,3} \d{1,3}$/);
    }
  });
});

describe("the utilities read the variables", async () => {
  const css = await compile();

  it("a themed colour is alpha-capable — the opacity modifier emits a rule", () => {
    expect(css).toMatch(/\.bg-bg-app \{[^}]*rgb\(var\(--color-bg-app\) \/ var\(--tw-bg-opacity, 1\)\)/);
    expect(css).toMatch(/\.ring-accent-strong\\\/30 \{[^}]*rgb\(var\(--color-accent-strong\) \/ 0\.3\)/);
    expect(css).toMatch(/\.hover\\:border-accent-strong\\\/60:hover \{[^}]*rgb\(var\(--color-accent-strong\) \/ 0\.6\)/);
  });

  it("the scrim carries the theme's own alpha, and a modifier scales it", () => {
    expect(css).toMatch(/\.bg-overlay \{[^}]*calc\(var\(--tw-bg-opacity, 1\) \* var\(--alpha-overlay\)\)/);
    expect(css).toMatch(/\.bg-overlay\\\/50 \{[^}]*calc\(0\.5 \* var\(--alpha-overlay\)\)/);
  });

  it("elevation, slot tokens and the named scales resolve", () => {
    expect(css).toMatch(/\.shadow-md \{[^}]*var\(--shadow-md\)/);
    expect(css).toMatch(/\.text-slot-mine-ink \{[^}]*--color-slot-mine-ink/);
    expect(css).toMatch(/\.z-popover \{\s*z-index: 60/);
    expect(css).toMatch(/\.min-h-touch \{\s*min-height: 44px/);
    expect(css).toMatch(/\.size-touch \{\s*width: 44px;\s*height: 44px/);
    expect(css).toMatch(/\.max-w-narrow \{\s*max-width: 36rem/);
    expect(css).toMatch(/\.font-heading \{\s*font-weight: 650/);
    expect(css).toMatch(/\.duration-sheet \{\s*transition-duration: 280ms/);
    expect(css).toMatch(/\.animate-pop-in \{\s*animation: pop-in 220ms/);
    expect(css).toMatch(/\.rounded-lg \{\s*border-radius: 10px/);
  });

  it("a bare border and a bare ring take the theme's hairline and accent, not Tailwind's grays", () => {
    // Preflight's default border colour is gray-200 — a bright line on the dark theme.
    expect(css).toMatch(/border-color: rgb\(var\(--color-border\) \/ 1\)/);
    expect(css).toContain("--tw-ring-color: rgb(var(--color-ring) / 0.5)");
    expect(css).not.toContain("147 197 253");
    expect(css).toContain("--tw-ring-offset-color: rgb(var(--color-bg-surface))");
    expect(css).not.toContain("<alpha-value>");
  });
});

/**
 * `public/theme-boot.js` runs before the app and `lib/theme.tsx` after it. They must agree on
 * the key, the class and the colours, or the first frame and the second disagree — a flash.
 */
describe("the boot script", () => {
  const ROOT = join(__dirname, "..");
  const boot = readFileSync(join(ROOT, "public", "theme-boot.js"), "utf8");
  const html = readFileSync(join(ROOT, "index.html"), "utf8");

  /**
   * Runs the boot script against a fresh document built from the real `index.html` head, with
   * its own storage and a controllable OS scheme — the script's only two inputs.
   */
  function run(stored: string | null, options: { prefersDark?: boolean; storageThrows?: boolean } = {}) {
    const doc = document.implementation.createHTMLDocument("");
    doc.documentElement.innerHTML = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/^[\s\S]*?<html[^>]*>/, "");
    const store = new Map<string, string>(stored === null ? [] : [[THEME_STORAGE_KEY, stored]]);
    const fakeWindow = {
      get localStorage() {
        if (options.storageThrows) throw new Error("blocked");
        return { getItem: (key: string) => store.get(key) ?? null };
      },
      matchMedia: (q: string) => ({ matches: q.includes("dark") && !!options.prefersDark }),
    };
    new Function("window", "document", boot)(fakeWindow, doc);
    const root = doc.documentElement;
    const metas = [...doc.querySelectorAll('meta[name="theme-color"]')].map((m) => m.getAttribute("content"));
    return { dark: root.classList.contains("dark"), scheme: root.style.colorScheme, metas };
  }

  it("uses the provider's storage key and the tokens' canvas colours", () => {
    expect(boot).toContain(`"${THEME_STORAGE_KEY}"`);
    expect(boot).toContain(`light: "${themes.light.bg.app}"`);
    expect(boot).toContain(`dark: "${themes.dark.bg.app}"`);
  });

  it("follows the OS when nothing is stored", () => {
    expect(run(null)).toMatchObject({ dark: false, scheme: "light" });
    expect(run(null, { prefersDark: true })).toMatchObject({ dark: true, scheme: "dark" });
    // …and leaves the media-keyed metas alone, so the browser picks per scheme.
    expect(run(null, { prefersDark: true }).metas).toEqual([themes.light.bg.app, themes.dark.bg.app]);
  });

  it("honours an explicit choice over the OS, and pins the chrome to it", () => {
    expect(run("dark")).toMatchObject({ dark: true, scheme: "dark", metas: [themes.dark.bg.app, themes.dark.bg.app] });
    expect(run("light", { prefersDark: true })).toMatchObject({ dark: false, scheme: "light" });
  });

  it("treats anything unrecognised as system, and survives storage that throws", () => {
    expect(run("purple")).toMatchObject({ dark: false });
    expect(() => run(null, { storageThrows: true, prefersDark: true })).not.toThrow();
    expect(run(null, { storageThrows: true, prefersDark: true })).toMatchObject({ dark: true });
  });

  it("is loaded before any stylesheet and before the app", () => {
    const at = html.indexOf('<script src="/theme-boot.js"></script>');
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(html.indexOf("</head>"));
    expect(at).toBeLessThan(html.indexOf('type="module"'));
    expect(html.slice(0, at)).not.toMatch(/rel="stylesheet"/);
  });
});
