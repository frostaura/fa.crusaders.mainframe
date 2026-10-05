import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const FRONTEND = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * R16 X16-1 — a member's install set (`precache.json` `first`) holds every file a member page
 * needs to RUN, read off a real build.
 *
 * <p>
 * The set left out any chunk carrying a module under `components/reports/` — meant for the chart
 * code, but `reports/range.ts` and `reports/ReportParts.tsx` are STATIC imports of the wallet's
 * pages (WalletMiniTotals, WalletActivity). So `/wallet` and `/wallet/activity` could not open
 * offline after a fresh install or an update until the slow second pass happened to finish, and
 * the page said this phone had never opened them. Only a LAZY edge may leave a file for later: a
 * static import is part of the importer, and a page whose import is missing does not run at all.
 * </p>
 *
 * <p>
 * Read from the artefact, like `production-posture.test.ts`: the rule is about what Rollup put in
 * which chunk, which no source scan can see.
 * </p>
 */

type ManifestChunk = { file: string; src?: string; isEntry?: boolean; isDynamicEntry?: boolean; imports?: string[]; dynamicImports?: string[]; css?: string[] };
type Manifest = Record<string, ManifestChunk>;

/** The desk's pages and frame — the only lazy routes a member's install may leave for later. */
const DESK = /^src\/(?:pages\/(?:admin\/|monitoring\/|Admin[A-Z]|DevPrimitives|dev\/)|adminFrame\.ts$)/;

let out = "";
let manifest: Manifest = {};
let first = new Set<string>();

beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), "crusaders-precache-"));
  execFileSync(
    process.execPath,
    [join(FRONTEND, "node_modules", "vite", "bin", "vite.js"), "build", "--mode", "production", "--outDir", out, "--emptyOutDir", "--manifest"],
    // NODE_ENV for the reason `production-posture.test.ts` gives: vitest's `test` would leak in.
    { cwd: FRONTEND, stdio: "pipe", env: { ...process.env, NODE_ENV: "production" } },
  );
  manifest = JSON.parse(readFileSync(join(out, ".vite", "manifest.json"), "utf8")) as Manifest;
  first = new Set((JSON.parse(readFileSync(join(out, "precache.json"), "utf8")) as { first: string[] }).first);
}, 180_000);

afterAll(() => {
  if (out && existsSync(out)) rmSync(out, { recursive: true, force: true });
});

/** Every file a chunk needs before it can run: itself, its CSS, and its static imports, transitively. */
function staticClosure(key: string, seen = new Set<string>()): Set<string> {
  const chunk = manifest[key];
  if (!chunk || seen.has(`/${chunk.file}`)) return seen;
  seen.add(`/${chunk.file}`);
  for (const css of chunk.css ?? []) seen.add(`/${css}`);
  for (const dep of chunk.imports ?? []) staticClosure(dep, seen);
  return seen;
}

/** The member's pages: every lazy route the entry names that is not the desk's. */
function memberPages(): string[] {
  const entry = Object.keys(manifest).find((k) => manifest[k].isEntry)!;
  return (manifest[entry].dynamicImports ?? []).filter((k) => manifest[k]?.src?.startsWith("src/pages/") && !DESK.test(manifest[k].src!));
}

describe("a member's install set holds every page's static imports (R16 X16-1)", () => {
  it("finds the member pages it guards, the wallet's two among them", () => {
    const pages = memberPages().map((k) => manifest[k].src);
    expect(pages).toEqual(expect.arrayContaining(["src/pages/Wallet.tsx", "src/pages/WalletActivity.tsx", "src/pages/Schedule.tsx", "src/pages/TopUp.tsx"]));
  });

  it("the entry's own static graph is in the set", () => {
    const entry = Object.keys(manifest).find((k) => manifest[k].isEntry)!;
    expect([...staticClosure(entry)].filter((f) => !first.has(f))).toEqual([]);
  });

  it("every member page's static import graph is in the set", () => {
    const missing = memberPages().flatMap((k) => [...staticClosure(k)].filter((f) => !first.has(f)).map((f) => `${manifest[k].src} needs ${f}`));
    expect(missing).toEqual([]);
  });

  it("still leaves the chart library for later: no member page needs it before it draws", () => {
    const charts = Object.values(manifest).find((c) => c.src === "src/components/Charts.tsx");
    expect(charts, "the Charts chunk").toBeDefined();
    expect(first.has(`/${charts!.file}`), "Charts in the member's install set").toBe(false);
  });
});
