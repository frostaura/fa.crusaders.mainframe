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
/** The same, sparing a control that draws its own outline (`.outline`): ScrollArea's (R16 FE16s2). */
const INSET_ALL_BUT_OWN = "[&_:focus-visible:not(.outline)]:-outline-offset-2";
const ROW_INSET = /(?<![\w&_:\]])focus-visible:-outline-offset-2/;
const FOCUSABLE = /<button\b|<Button\b|<Link\b|<a\s|tabIndex=|onClick=/;

const NOTHING_FOCUSABLE: Readonly<Record<string, string>> = {
  "components/bookings/BulkResults.tsx": "a run's outcome, one plain line a slot: no link, button or tab stop in the file",
  "components/bookings/SheetParts.tsx": "the slot list and summary are words and figures: no link, button or tab stop in the file",
};

/**
 * R16 L16-1 — boxes that clip without cutting a ring, each MEASURED in Chromium rather than assumed
 * (`e2e/layout-r16-fe16s.spec.ts`, "L16-1 measured"). Insetting every ring inside them would be
 * wrong: a primary button's fill is the ring's own colour (navy 700 in light), so a ring drawn
 * over its edge disappears. They keep the outward ring and leave it room instead. An entry whose
 * file no longer offends fails "every entry still offends" below, so the list cannot go stale.
 * (The R16 ratchet of other lanes' unfixed boxes, `NOT_YET_INSET`, is empty and gone — FE16s2.)
 */
const MEASURED_UNCUT: Readonly<Record<string, string>> = {
  "components/shell/AppShell.tsx": "<main>, the page scroller: what sticks at its top edge (the range bar, the strip, a top context bar) carries py-2 / pt-1 of its own; measured 0 cut, stuck, at 390 and 1280",
  "components/ui/dialog.tsx": "header and body scrollers: a 16px gutter each side, py-2 / pb-2 and scroll-py-2 so a control Tab scrolls in stops clear of the edge; measured 0 cut in the cancel sheet at 320 / 200 %",
};

/**
 * R17 L17-3 — the scan now counts EVERY `overflow-hidden` box (it required `divide-y` too, so the
 * member combobox's `Command` root cut its input's ring by 4px and nothing noticed). These boxes clip
 * but cannot cut a ring: each holds no control, or is itself the only control (an element's own
 * outline is drawn outside its box and its own overflow never clips it), or holds controls only
 * inside a padded child or a container that insets them. Keyed by file AND a fragment of the tag, so
 * a new box in the same file is still scanned; an entry that stops matching fails below.
 */
const CLIPS_NO_RING: ReadonlyArray<readonly [file: string, fragment: string, why: string]> = [
  ["components/AuthShell.tsx", "@container/band", "the sign-in band: crest and words, no control"],
  ["components/AuthShell.tsx", "overflow-hidden rounded-2xl border border-border bg-bg-surface", "the sign-in card: its form sits in a child padded py-6 / 20-32px a side"],
  ["components/PhotoPicker.tsx", "size-16 shrink-0", "the photo preview: an image, no control"],
  ["components/bookings/BookingGrid.tsx", "relative z-base overflow-hidden", "its one child is the grid's ScrollArea, which insets every ring inside it"],
  ["components/member-code/CodePreview.tsx", "aria-hidden=\"true\"", "a decorative preview, aria-hidden"],
  ["components/members/MembersTable.tsx", "<TableHead", "the sort button sits inside ui/table's container, which insets every ring ([&_:focus-visible]:-outline-offset-2)"],
  ["components/ui/avatar.tsx", "AvatarPrimitive.Root", "a photo or initials, no control"],
  ["components/ui/dot-separated.tsx", "data-dot-separated", "joins words and times (RecentAlerts' meta line), no control"],
  ["components/ui/interactable.tsx", "<Host", "the host is the control (asChild onto a Link or button) — its own outline is outside its box"],
  ["components/ui/pass-card.tsx", "rounded-t-2xl", "the pass band: crest, words and avatar, no control"],
  ["components/ui/pass-card.tsx", "rounded-b-2xl", "the pass body: the QR button sits in a 20px-padded body and a 12px-padded plate"],
  ["components/ui/progress.tsx", "ProgressPrimitive.Root", "a progress bar, no control"],
  ["pages/Profile.tsx", "relative block size-24 overflow-hidden", "the photo inside the photo button; the button's own ring is outside it"],
];

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
      const clipsHidden = /(?<![\w-])overflow-hidden\b/.test(tag);
      if (!clipsHidden && !CLIPS.test(tag)) continue;
      lists.push(file);
      if (tag.includes(INSET_ALL) || tag.includes(INSET_ALL_BUT_OWN) || ROW_INSET.test(code) || ROOM.test(tag)) continue;
      if (file in NOTHING_FOCUSABLE && !FOCUSABLE.test(code)) continue;
      offenders.push(`${file}: ${tag.slice(0, 120)}`);
    }
  }
  return { lists, offenders };
}

function clipsNoRing(offender: string): boolean {
  return CLIPS_NO_RING.some(([file, fragment]) => offender.startsWith(`${file}:`) && offender.includes(fragment));
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
    expect(offenders.filter((o) => !(o.split(":")[0] in MEASURED_UNCUT) && !clipsNoRing(o))).toEqual([]);
  });

  it("every no-ring clipping box is still there and still clips (else delete its entry) — R17 L17-3", () => {
    for (const [file, fragment] of CLIPS_NO_RING) {
      expect(offenders.some((o) => o.startsWith(`${file}:`) && o.includes(fragment)), `${file} ${fragment}`).toBe(true);
    }
  });

  it("finds the boxes R16 widened it to (overflow-clip, -auto, -x-auto), the ones fixed in this lane among them", () => {
    expect(lists).toEqual(expect.arrayContaining([
      "pages/Wallet.tsx", "pages/admin/member/MemberWallet.tsx", "components/DataTable.tsx", "pages/Schedule.tsx", "components/bookings/BookingGrid.tsx",
    ]));
  });

  it("every measured-uncut entry still has a box the scan flags (else delete it)", () => {
    const offending = new Set(offenders.map((o) => o.split(":")[0]));
    for (const file of Object.keys(MEASURED_UNCUT)) expect(offending.has(file), `${file} no longer offends — delete its entry`).toBe(true);
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
    ["the wallet's chart carousel without its inset (R16 FE16s2)", "components/Carousel.tsx", ` ${INSET_ALL}`, ""],
    ["the admin rail without its inset (R16 FE16s2)", "components/admin/AdminRail.tsx", ` ${INSET_ALL}`, ""],
    ["a court's event list without its inset (R16 FE16s2)", "components/monitoring/CourtTile.tsx", ` ${INSET_ALL}`, ""],
    ["the member combobox's Command root without its inset (R17 L17-3)", "components/ui/command.tsx", ` ${INSET_ALL}`, ""],
    ["the accordion panel without its room (R17 L17-3)", "components/ui/accordion.tsx", "-m-1 overflow-hidden p-1", "overflow-hidden"],
    ["a menu panel without its room (R16 FE16s2)", "components/ui/dropdown-menu.tsx", " p-1 scroll-py-1", ""],
    ["the sticky split list without its room (R16 FE16s2)", "components/ui/split-view.tsx", " p-1 -m-1 scroll-p-1", ""],
    ["the sticky aside without its room (R16 FE16s2)", "components/ui/with-aside.tsx", " p-1 -m-1 scroll-p-1", ""],
  ])("goes red on a mutation: %s", (_name, file, from, to) => {
    const code = sources.get(file)!;
    expect(code, `${file} no longer contains the mutation's anchor`).toContain(from);
    expect(scan(new Map(sources).set(file, code.replace(from, to))).offenders.length).toBeGreaterThan(0);
  });
});
