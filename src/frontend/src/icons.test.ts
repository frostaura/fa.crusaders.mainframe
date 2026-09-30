import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import * as icons from "./components/ui/icons";
import { SHIPPED_ICON_WEIGHTS } from "./components/ui/iconWeights";

/**
 * One way in to the icon set.
 *
 * <p>
 * Phosphor is imported ONLY through `src/components/ui/icons.ts`, one per-icon `dist/csr/<Name>`
 * path per line. Two reasons. The package root re-exports ~1 500 icons and leaves the bundle
 * size to the tree-shaker's mood; and a barrel is the one place the product's icon vocabulary
 * can be read, reviewed and retired — the thumbs-up ActionGlyph lived for a year because icons
 * were imported wherever somebody needed one. ESLint's `no-restricted-imports` says the same
 * thing at edit time; this says it on every commit, including for files ESLint ignores.
 * </p>
 */

const SRC = __dirname;
const BARREL = join(SRC, "components", "ui", "icons.ts");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

const PHOSPHOR = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["']@phosphor-icons\/react/;

describe("the icon barrel", () => {
  it("is the only module that imports @phosphor-icons/react", () => {
    const offenders = sources(SRC)
      .filter((file) => file !== BARREL && file !== __filename)
      .filter((file) => PHOSPHOR.test(readFileSync(file, "utf8")))
      .map((file) => relative(SRC, file));
    expect(offenders).toEqual([]);
  });

  it("imports per icon, never the package root", () => {
    const barrel = readFileSync(BARREL, "utf8");
    const specifiers = [...barrel.matchAll(/from\s+"(@phosphor-icons\/react[^"]*)"/g)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(40);
    for (const specifier of specifiers) {
      expect(specifier, specifier).toMatch(/^@phosphor-icons\/react\/dist\/(csr\/[A-Z]\w*|lib\/(context|types))$/);
    }
  });

  it("exports every icon under both names, and each is a real component", () => {
    const barrel = readFileSync(BARREL, "utf8");
    const lines = [...barrel.matchAll(/export \{ (\w+)Icon, \1Icon as (\w+) \} from "@phosphor-icons\/react\/dist\/csr\/(\w+)";/g)];
    expect(lines.length).toBeGreaterThan(40);
    for (const [, name, alias, path] of lines) {
      expect(alias, `${name}: alias must be the bare name`).toBe(name);
      expect(path, `${name}: path must be the icon's own file`).toBe(name);
      const table = icons as unknown as Record<string, unknown>;
      expect(table[`${name}Icon`], `${name}Icon`).toBeTruthy();
      expect(table[name], name).toBe(table[`${name}Icon`]);
    }
  });

  it("keeps the thumbs out: no hand glyph stands in for an outcome", () => {
    // R8 retired the thumbs-up/down ActionGlyph. Outcomes are AnimatedCheck / AnimatedAlert.
    expect(Object.keys(icons).filter((name) => /^Thumbs/.test(name))).toEqual([]);
  });

  /**
   * The production build keeps only `SHIPPED_ICON_WEIGHTS` of each icon (`vite.config.ts`,
   * `phosphorWeights`). A weight drawn anywhere but not shipped renders an EMPTY svg — in
   * production only, silently — so every weight named in the source must be on the list.
   */
  it("ships every icon weight the source draws", () => {
    const named = new Set<string>([String(icons.ICON_DEFAULTS.weight)]);
    for (const file of sources(SRC).filter((f) => !/\.test\.tsx?$/.test(f))) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/\bweight=(?:"(\w+)"|\{([^}]*)\})/g)) {
        if (m[1]) named.add(m[1]);
        for (const q of (m[2] ?? "").matchAll(/"(\w+)"/g)) named.add(q[1]);
      }
      for (const m of text.matchAll(/IconWeight\[\]\s*=\s*\[([^\]]*)\]/g)) {
        for (const q of m[1].matchAll(/"(\w+)"/g)) named.add(q[1]);
      }
    }
    expect(named.size).toBeGreaterThanOrEqual(3);
    const shipped = new Set<string>(SHIPPED_ICON_WEIGHTS);
    expect([...named].filter((w) => !shipped.has(w))).toEqual([]);
  });

  it("provides the product's defaults for IconContext", () => {
    expect(icons.ICON_DEFAULTS).toMatchObject({ size: 20, weight: "regular", color: "currentColor" });
    expect(icons.IconContext).toBeTruthy();
  });
});
