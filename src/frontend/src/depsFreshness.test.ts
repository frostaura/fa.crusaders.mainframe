import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { staleDependencies, staleDependenciesMessage } from "./depsFreshness";

/** FM-12: every gate refuses to run over a node_modules older than the lockfile, and says how to fix it. */
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });

function project(installed: Record<string, string | null>, locked: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deps-fresh-"));
  roots.push(root);
  const deps = Object.fromEntries(Object.keys(locked).map((n) => [n, `^${locked[n]}`]));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: deps }));
  fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({
    packages: Object.fromEntries(Object.entries(locked).map(([n, v]) => [`node_modules/${n}`, { version: v }])),
  }));
  for (const [name, version] of Object.entries(installed)) {
    if (version === null) continue;
    fs.mkdirSync(path.join(root, "node_modules", name), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules", name, "package.json"), JSON.stringify({ name, version }));
  }
  return root;
}

describe("dependency freshness", () => {
  it("finds a missing package and an older one, and nothing when the install matches", () => {
    expect(staleDependencies(project({ react: "19.1.0", "radix-ui": "1.4.2" }, { react: "19.1.0", "radix-ui": "1.4.2" }))).toEqual([]);
    expect(staleDependencies(project({ react: "19.1.0", "radix-ui": null }, { react: "19.1.0", "radix-ui": "1.4.2" })))
      .toEqual(["radix-ui: locked 1.4.2, installed nothing"]);
    expect(staleDependencies(project({ react: "19.0.0" }, { react: "19.1.0" }))).toEqual(["react: locked 19.1.0, installed 19.0.0"]);
  });

  it("names the fix, and the first few culprits", () => {
    const message = staleDependenciesMessage(Array.from({ length: 10 }, (_, i) => `p${i}: locked 1, installed nothing`));
    expect(message).toMatch(/Run `npm ci` in src\/frontend/);
    expect(message).toMatch(/and 2 more/);
  });

  it("holds for this very checkout — the gate this file guards is green only over a fresh install", () => {
    expect(staleDependencies(path.resolve(__dirname, ".."))).toEqual([]);
  });
});
