import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * R7 perf (X6-3) — the display and code faces are our own Latin cuts (`assets/fonts/`, see the
 * note at the top of `index.css`): Fontsource's Archivo-with-width (90 kB) and JetBrains Mono
 * (40 kB) arrived in the same 1.6 Mbps window as My Code's and Bookings' code on a first visit.
 */

const CSS = readFileSync(join(__dirname, "index.css"), "utf8");
const FONTS = join(__dirname, "assets", "fonts");
/** Fontsource's `latin` subset — the cut must cover exactly what the face it replaces covered. */
const LATIN = "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";

type Face = { family: string; weight: string; stretch: string | null; src: string; range: string };

function faces(): Face[] {
  return [...CSS.matchAll(/@font-face\s*{([^}]*)}/g)].map(([, body]) => {
    const get = (prop: string) => body.match(new RegExp(`${prop}:\\s*([^;]+);`))?.[1].trim() ?? null;
    return { family: get("font-family")!.replace(/"/g, ""), weight: get("font-weight")!, stretch: get("font-stretch"), src: get("src")!, range: get("unicode-range")! };
  });
}

describe("the display and code faces", () => {
  it("are not Fontsource's full faces any more", () => {
    expect(CSS).not.toMatch(/@import\s+["']@fontsource-variable\/archivo/);
    expect(CSS).not.toMatch(/@import\s+["']@fontsource-variable\/jetbrains-mono/);
  });

  it("draw Latin from the cuts, which stay inside their budget", () => {
    const latin = faces().filter((f) => f.range === LATIN && f.family !== "Figtree Variable");
    expect(latin.map((f) => [f.family, f.src])).toEqual([
      ["Archivo Variable", 'url("./assets/fonts/archivo-display.woff2") format("woff2-variations")'],
      ["JetBrains Mono Variable", 'url("./assets/fonts/jetbrains-mono-code.woff2") format("woff2-variations")'],
    ]);
    expect(statSync(join(FONTS, "archivo-display.woff2")).size).toBeLessThan(40_000);
    expect(statSync(join(FONTS, "jetbrains-mono-code.woff2")).size).toBeLessThan(16_000);
    expect(readFileSync(join(FONTS, "OFL.txt"), "utf8")).toMatch(/SIL Open Font License/);
  });

  it("declare one weight/width range per family, the range the product draws", () => {
    // Chrome matches ONE group of faces by these capabilities; a latin face narrower than its
    // latin-ext sibling could leave Latin text in the fallback face.
    const byFamily = new Map<string, Set<string>>();
    for (const f of faces()) {
      if (f.family === "Figtree Variable") continue;
      byFamily.set(f.family, (byFamily.get(f.family) ?? new Set()).add(`${f.weight} / ${f.stretch}`));
    }
    expect(Object.fromEntries([...byFamily].map(([k, v]) => [k, [...v]]))).toEqual({
      "Archivo Variable": ["600 800 / 100% 112%"],
      "JetBrains Mono Variable": ["400 700 / null"],
    });
  });

  it("are only drawn inside that range: Archivo at 600–800 and 100–112 %", () => {
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name) ? [join(dir, e.name)] : []);
    const outside: string[] = [];
    for (const file of walk(__dirname)) {
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        if (!/(^|[\s"'`])font-display(\s|["'`]|$)/.test(line)) return;
        const where = `${file.slice(__dirname.length + 1)}:${i + 1}`;
        if (/\bfont-(thin|extralight|light|normal|medium|black)\b/.test(line)) outside.push(`${where} weight`);
        for (const m of line.matchAll(/\[font-stretch:(\d+)%\]/g)) if (+m[1] < 100 || +m[1] > 112) outside.push(`${where} stretch ${m[1]}%`);
      });
    }
    expect(outside).toEqual([]);
  });
});
