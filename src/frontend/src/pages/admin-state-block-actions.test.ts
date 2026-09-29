import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Review round 1, F3.19: `StateBlock`'s `action` is the verb phrase after "Couldn't" — and
 * eleven admin call sites passed a bare noun, so a failed read said "Couldn't those movements"
 * and "Couldn't the club's courts". Checked in the SOURCE across every admin surface, because a
 * rendered test only ever covers the failures somebody thought to stub. (Making the prop itself
 * impossible to misuse is the component's own change.)
 */
const ROOT = resolve(__dirname, "..");
const SURFACES = [
  "pages", "pages/admin", "pages/admin/member", "pages/monitoring",
  "components/admin", "components/groups", "components/members", "components/schedules", "components/settings",
];
const VERB = /^(read|load|refresh|set up|search|find|download|check|open|save|reach)\b/;

function files(): string[] {
  return SURFACES.flatMap((rel) => readdirSync(resolve(ROOT, rel))
    .filter((n) => /\.tsx$/.test(n) && !n.includes(".test."))
    .map((n) => resolve(ROOT, rel, n))
    .filter((f) => statSync(f).isFile())
    .filter((f) => rel !== "pages" || /\/Admin[^/]*\.tsx$/.test(f)));
}

describe("every admin StateBlock names what it could not do with a verb", () => {
  it.each(files().map((f) => [f.slice(f.lastIndexOf("/src/") + 5), f] as const))("%s", (_name, file) => {
    const source = readFileSync(file, "utf8");
    const blocks = source.split("<StateBlock").slice(1).map((b) => b.slice(0, b.indexOf("/>") >= 0 ? b.indexOf("/>") : undefined));
    const literals = blocks.flatMap((b) => [...b.matchAll(/\baction="([^"]*)"/g)].map((m) => m[1]));
    for (const phrase of literals) expect(phrase, `Couldn't ${phrase}`).toMatch(VERB);
  });
});
