import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * R7 perf (P5-7) — what every member downloads before the first paint is the static import closure
 * of `main.tsx`. A copy module that one shell file imports for a single function lands in it whole:
 * `lib/adminAttention` (the app shell's Admin tab) took `disputesAttentionLabel` from `playCopy`,
 * and with it `playCopy` and `playersCopy` — ~65 kB of source, ~5 kB gzip of every first load.
 *
 * <p>
 * This walks the SOURCE graph, statically: value imports and re-exports, never `import type` and
 * never `import()`. It is the cheap tripwire; the build (`vite build`, gzip of what `index.html`
 * names) is the measure.
 * </p>
 */

const SRC = __dirname;
const EXTENSIONS = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];
const VALUE_IMPORT = /^\s*(?:import|export)\s+(?!type\s)(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/gm;

function resolveImport(from: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? join(SRC, spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(from), spec) : null;
  if (base === null) return null; // a package
  for (const ext of EXTENSIONS) {
    const file = base + ext;
    if (existsSync(file) && /\.(ts|tsx)$/.test(file)) return file;
  }
  return null; // css, svg, …
}

function entryClosure(): Set<string> {
  const seen = new Set<string>();
  const stack = [join(SRC, "main.tsx")];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(VALUE_IMPORT)) {
      const next = resolveImport(file, match[1]);
      if (next) stack.push(next);
    }
  }
  return new Set([...seen].map((file) => file.slice(SRC.length + 1)));
}

describe("the first load's source graph", () => {
  const closure = entryClosure();

  it("is walked at all (the shell and My Code are in it)", () => {
    expect(closure.has("App.tsx")).toBe(true);
    expect(closure.has("pages/MyCode.tsx")).toBe(true);
    expect(closure.has("lib/adminAttention.ts")).toBe(true);
  });

  it("does not carry the play copy for the admin badge's one sentence", () => {
    expect(closure.has("lib/playCopy.ts"), "lib/playCopy.ts is statically reachable from main.tsx").toBe(false);
  });

  // R7 P5-7 — the wallet's names and the invite-link note came out of playersCopy, so the whole
  // players copy (with its PLAYERS_COPY object) is no longer in every member's first load.
  it("does not carry the players copy for the wallet's names or the invite note", () => {
    expect(closure.has("lib/playersCopy.ts"), "lib/playersCopy.ts is statically reachable from main.tsx").toBe(false);
  });
});
