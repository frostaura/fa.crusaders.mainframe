import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * R15 X15-1 — no e2e wait is handed an ASYNC predicate, as a source scan.
 *
 * <p>
 * `page.waitForFunction` polls its predicate for a TRUTHY value, and an async function returns a
 * Promise — an object, truthy the moment it exists. So `waitForFunction(async () => …)` resolves on
 * its first poll whatever the body would have said (measured: `async () => false` resolved in 9 ms).
 * The two offline specs' "worker in control" waits were exactly that, which is why they flaked in
 * R14: the test went offline while the worker was still activating. Await the async part with
 * `page.evaluate` first, then wait on a SYNC predicate.
 * </p>
 */
const E2E = join(__dirname, "..", "e2e");
/** `waitForFunction(` followed by `async` — an arrow or a function expression, on the same line or the next. */
const ASYNC_WAIT = /\bwaitForFunction\s*\(\s*async\b/g;

function sources(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(?:ts|mts|js|mjs)$/.test(entry.name)) out.set(relative(E2E, full).split(sep).join("/"), readFileSync(full, "utf8"));
    }
  };
  walk(E2E);
  return out;
}

function offenders(files: ReadonlyMap<string, string>): string[] {
  return [...files].flatMap(([file, code]) => [...code.matchAll(ASYNC_WAIT)]
    .map((m) => `${file}:${code.slice(0, m.index).split("\n").length}`));
}

describe("e2e waits poll a sync predicate (R15 X15-1)", () => {
  const files = sources();

  it("reads the e2e specs it guards (a scan that reads nothing proves nothing)", () => {
    expect(files.has("my-code-offline.spec.ts")).toBe(true);
    expect(files.has("offline-routes.spec.ts")).toBe(true);
    expect([...files.values()].some((code) => /\bwaitForFunction\s*\(/.test(code))).toBe(true);
  });

  it("no waitForFunction is handed an async predicate, which is truthy on its first poll", () => {
    expect(offenders(files)).toEqual([]);
  });

  it.each([
    ["an async arrow on one line", "await page.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration()));"],
    ["an async arrow on the next line", "await page.waitForFunction(\n  async () => false,\n);"],
    ["an async function expression", "await page.waitForFunction(async function () { return false; });"],
  ])("goes red on %s", (_name, code) => {
    expect(offenders(new Map([["mutant.spec.ts", code]]))).toEqual(["mutant.spec.ts:1"]);
  });

  it("stays quiet on a sync predicate", () => {
    expect(offenders(new Map([["ok.spec.ts", "await page.waitForFunction(() => navigator.serviceWorker.controller?.state === \"activated\");"]]))).toEqual([]);
  });
});
