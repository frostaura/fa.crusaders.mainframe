import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import * as icons from "./components/ui/icons";

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

  it("provides the product's defaults for IconContext", () => {
    expect(icons.ICON_DEFAULTS).toMatchObject({ size: 20, weight: "regular", color: "currentColor" });
    expect(icons.IconContext).toBeTruthy();
  });
});
