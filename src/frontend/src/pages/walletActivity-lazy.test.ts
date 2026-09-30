import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * R4 P4-6 — the member's activity page keeps the chart library out of its own chunk (the
 * service worker precaches member route chunks at install). A value import of `components/Charts`
 * here would pull ~125 KB gz back into every member's install.
 */
describe("/wallet/activity's charts", () => {
  it("are imported lazily, never as a value at the top", () => {
    const source = readFileSync(join(__dirname, "WalletActivity.tsx"), "utf8");
    expect(/^import\s+(?!type\b)[^;]*from\s+["'][^"']*components\/Charts["']/m.test(source)).toBe(false);
    expect(source).toMatch(/lazy\(\(\) => import\("\.\.\/components\/Charts"\)/);
  });
});
