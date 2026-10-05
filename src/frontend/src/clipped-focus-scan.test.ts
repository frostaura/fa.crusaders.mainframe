import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * R15 L15-1 — a list that clips its rows draws their focus ring INSIDE them, as a source scan.
 *
 * <p>
 * The house ring (`index.css` `:focus-visible`) is a 2px outline 2px OUTSIDE the element. A card list
 * — `divide-y` rows inside a rounded `overflow-hidden` border — clips everything past its edge, so a
 * full-bleed row (the inbox's, the admin alerts', a member's door line focused by "Load older") showed
 * a ring with its sides cut off, or none at all at the list's top and bottom. MemberPicker's rows had
 * the fix (`focus-visible:-outline-offset-2`, R14); its siblings did not.
 * </p>
 *
 * <p>
 * <b>The rule:</b> every clipping list — one tag whose classes carry both `overflow-hidden` and
 * `divide-y` — insets every ring inside it (`[&_:focus-visible]:-outline-offset-2` on the list), or
 * its file insets its rows' own (`focus-visible:-outline-offset-2`), or it is allow-listed because its
 * file renders nothing focusable at all — which this test checks, so the entry cannot go stale.
 * </p>
 */
const INSET_ALL = "[&_:focus-visible]:-outline-offset-2";
const ROW_INSET = /(?<![\w&_:\]])focus-visible:-outline-offset-2/;
const FOCUSABLE = /<button\b|<Button\b|<Link\b|<a\s|tabIndex=|onClick=/;

const NOTHING_FOCUSABLE: Readonly<Record<string, string>> = {
  "components/bookings/BulkResults.tsx": "a run's outcome, one plain line a slot: no link, button or tab stop in the file",
  "components/bookings/SheetParts.tsx": "the slot list and summary are words and figures: no link, button or tab stop in the file",
};

const SRC = __dirname;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "test" || entry.name === "dev" ? [] : files(full);
    return /\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name) ? [full] : [];
  });
}

/** Each JSX opening tag's text, up to its first `>` outside braces. */
function tags(code: string): string[] {
  const out: string[] = [];
  for (const open of code.matchAll(/<[A-Za-z][\w.]*\b/g)) {
    let depth = 0;
    let end = open.index!;
    for (; end < code.length; end++) {
      if (code[end] === "{") depth++;
      else if (code[end] === "}") depth--;
      else if (code[end] === ">" && depth === 0) break;
    }
    out.push(code.slice(open.index!, end));
  }
  return out;
}

function scan(sources: ReadonlyMap<string, string>) {
  const lists: string[] = [];
  const offenders: string[] = [];
  for (const [file, code] of sources) {
    for (const tag of tags(code)) {
      if (!/\boverflow-hidden\b/.test(tag) || !/\bdivide-y\b/.test(tag)) continue;
      lists.push(file);
      if (tag.includes(INSET_ALL) || ROW_INSET.test(code)) continue;
      if (file in NOTHING_FOCUSABLE && !FOCUSABLE.test(code)) continue;
      offenders.push(`${file}: ${tag.slice(0, 80)}`);
    }
  }
  return { lists, offenders };
}

function sourcesNow(): Map<string, string> {
  return new Map(files(SRC).map((full) => [relative(SRC, full).split(sep).join("/"), readFileSync(full, "utf8")]));
}

describe("a list that clips its rows insets their focus rings (R15 L15-1)", () => {
  const sources = sourcesNow();
  const { lists, offenders } = scan(sources);

  it("finds the clipping lists it guards (a scan that matches nothing proves nothing)", () => {
    expect(lists).toEqual(expect.arrayContaining([
      "components/inbox/InboxList.tsx", "components/notifications/RecentAlerts.tsx", "components/members/MemberPicker.tsx",
      "pages/admin/member/MemberDoors.tsx", "pages/admin/member/MemberAccess.tsx",
    ]));
  });

  it("every clipping list insets its rings, or its file has nothing to focus", () => {
    expect(offenders).toEqual([]);
  });

  it("each allow-listed file still has a clipping list", () => {
    for (const file of Object.keys(NOTHING_FOCUSABLE)) expect(lists, file).toContain(file);
  });

  it.each([
    ["the inbox list without its inset", "components/inbox/InboxList.tsx", ` ${INSET_ALL}`, ""],
    ["the alerts list without its inset", "components/notifications/RecentAlerts.tsx", ` ${INSET_ALL}`, ""],
    ["an allow-listed file that grows a button", "components/bookings/BulkResults.tsx", "<RowIcon ok={row.ok} />", "<RowIcon ok={row.ok} /><button type=\"button\">Retry</button>"],
  ])("goes red on a mutation: %s", (_name, file, from, to) => {
    const code = sources.get(file)!;
    expect(code, `${file} no longer contains the mutation's anchor`).toContain(from);
    expect(scan(new Map(sources).set(file, code.replace(from, to))).offenders.length).toBeGreaterThan(0);
  });
});
