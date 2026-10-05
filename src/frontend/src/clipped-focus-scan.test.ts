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

/**
 * R16 L16-1 — the RATCHET: clipping boxes the widened scan found in files outside lane FE16s, which
 * may not edit them. Each is asked of its owner (scratchpad `r16-ask-FE16s-to-integrator.md`). The
 * list only ever shrinks: an entry whose file no longer offends fails the last test below, so it is
 * deleted the moment its box is fixed. Measured cuts (e2e/layout-r16-fe16s): the wallet's chart
 * carousel (4px) and the admin rail's links (4px); the rest are unmeasured, not cleared.
 */
const NOT_YET_INSET: Readonly<Record<string, string>> = {
  "components/Carousel.tsx": "the wallet's chart cards: rings cut 4px at the strip's edges (measured on /wallet/activity)",
  "components/admin/AdminRail.tsx": "the rail's links: rings cut 4px at its edges (measured, \"Repeating bookings\")",
  "components/ScrollArea.tsx": "a scrolling region; its callers inset (LedgerTable's card, the court chips) — the primitive does not",
  "components/monitoring/CourtTile.tsx": "a court's event list, max-h-48 overflow-y-auto",
  "components/shell/AppShell.tsx": "<main>, the page scroller: a sticky head at its top edge loses its ring's top",
  "components/ui/dialog.tsx": "the sheet's header and body scrollers",
  "components/ui/dropdown-menu.tsx": "a menu's scroller",
  "components/ui/split-view.tsx": "the sticky list pane from 48rem",
  "components/ui/table.tsx": "the table frame's scroller: a sort button on its top edge",
  "components/ui/with-aside.tsx": "the sticky aside from 56rem: a full-width link at its edge",
};

const SRC = __dirname;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "test" || entry.name === "dev" ? [] : files(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
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

/**
 * R16 L16-1 — a box that SCROLLS or clips without being a scroll container clips just the same: the
 * wallet's ledger card (`overflow-clip`), DataTable's frame (`overflow-auto`), the Bookings rail's
 * strip (`overflow-x-auto`) and the grid's scroller cut the ring of whatever sat at their edge.
 * (`overflow-x-auto` alone makes the other axis `auto` too, so it clips top and bottom as well.)
 */
const CLIPS = /(?<![\w-])overflow-(?:clip|auto|scroll|x-auto|y-auto|x-scroll|y-scroll|x-clip|y-clip)\b/;
/** Room all round for the house ring (2px outline 2px out = 4px): `p-1` or more on every side. */
const ROOM = /(?<![\w:-])p-(?:[1-9]|\[)/;

/**
 * Each JSX opening tag, and each class string kept OUTSIDE a tag (a `const STRIP = "…overflow-x-auto…"`
 * a tag then names) — a box is a box wherever its classes are written. A string inside a tag is
 * already part of that tag.
 */
function boxes(code: string): string[] {
  const inTags = tags(code);
  const loose = [...code.matchAll(/"([^"\n]*)"/g)].map((m) => m[1])
    .filter((text) => CLIPS.test(text) && !inTags.some((tag) => tag.includes(text)));
  return [...inTags, ...loose];
}

function scan(sources: ReadonlyMap<string, string>) {
  const lists: string[] = [];
  const offenders: string[] = [];
  for (const [file, code] of sources) {
    for (const tag of boxes(code)) {
      const clippingList = /\boverflow-hidden\b/.test(tag) && /\bdivide-y\b/.test(tag);
      if (!clippingList && !CLIPS.test(tag)) continue;
      lists.push(file);
      if (tag.includes(INSET_ALL) || ROW_INSET.test(code) || ROOM.test(tag)) continue;
      if (file in NOTHING_FOCUSABLE && !FOCUSABLE.test(code)) continue;
      offenders.push(`${file}: ${tag.slice(0, 80)}`);
    }
  }
  return { lists, offenders };
}

function sourcesNow(): Map<string, string> {
  return new Map(files(SRC).map((full) => [relative(SRC, full).split(sep).join("/"), readFileSync(full, "utf8")]));
}

describe("a box that clips or scrolls insets its focus rings (R15 L15-1, widened R16 L16-1)", () => {
  const sources = sourcesNow();
  const { lists, offenders } = scan(sources);

  it("finds the clipping lists it guards (a scan that matches nothing proves nothing)", () => {
    expect(lists).toEqual(expect.arrayContaining([
      "components/inbox/InboxList.tsx", "components/notifications/RecentAlerts.tsx", "components/members/MemberPicker.tsx",
      "pages/admin/member/MemberDoors.tsx", "pages/admin/member/MemberAccess.tsx",
    ]));
  });

  it("every clipping box insets its rings, has room for them, or its file has nothing to focus", () => {
    expect(offenders.filter((o) => !(o.split(":")[0] in NOT_YET_INSET))).toEqual([]);
  });

  it("finds the boxes R16 widened it to (overflow-clip, -auto, -x-auto), the ones fixed in this lane among them", () => {
    expect(lists).toEqual(expect.arrayContaining([
      "pages/Wallet.tsx", "pages/admin/member/MemberWallet.tsx", "components/DataTable.tsx", "pages/Schedule.tsx", "components/bookings/BookingGrid.tsx",
    ]));
  });

  it("the ratchet only shrinks: every entry still has a box that offends", () => {
    const offending = new Set(offenders.map((o) => o.split(":")[0]));
    for (const file of Object.keys(NOT_YET_INSET)) expect(offending.has(file), `${file} is fixed — delete its entry`).toBe(true);
  });

  it("each allow-listed file still has a clipping list", () => {
    for (const file of Object.keys(NOTHING_FOCUSABLE)) expect(lists, file).toContain(file);
  });

  it.each([
    ["the inbox list without its inset", "components/inbox/InboxList.tsx", ` ${INSET_ALL}`, ""],
    ["the alerts list without its inset", "components/notifications/RecentAlerts.tsx", ` ${INSET_ALL}`, ""],
    ["an allow-listed file that grows a button", "components/bookings/BulkResults.tsx", "<RowIcon ok={row.ok} />", "<RowIcon ok={row.ok} /><button type=\"button\">Retry</button>"],
    ["the wallet's ledger card without its inset (R16)", "pages/Wallet.tsx", ` ${INSET_ALL}`, ""],
    ["DataTable's frame without its inset (R16)", "components/DataTable.tsx", ` ${INSET_ALL}`, ""],
    ["the rail strip without its inset (R16)", "pages/Schedule.tsx", ` ${INSET_ALL}",`, `",`],
  ])("goes red on a mutation: %s", (_name, file, from, to) => {
    const code = sources.get(file)!;
    expect(code, `${file} no longer contains the mutation's anchor`).toContain(from);
    expect(scan(new Map(sources).set(file, code.replace(from, to))).offenders.length).toBeGreaterThan(0);
  });
});
