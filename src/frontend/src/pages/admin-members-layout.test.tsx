import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import AdminMembersPage from "./AdminMembers";
import { memberFixture, renderPage, stubFetch, type StubRoute } from "../test/harness";

/**
 * The members table's shape, which was measured wrong at both ends of the range.
 *
 * <p>
 * At 1440px — the widest desktop breakpoint this app will ever get — the table was 1006px inside
 * a 990px scroll container, so the last header ("ACTIONS") was cut off, and each row was
 * <b>164.5px tall</b>: the four row actions were laid out <code>flex-col</code>, so Adjust
 * credit / Enroll fingerprint / Reset password / Suspend stacked one above the other at 32px
 * each and six members filled roughly a thousand pixels of screen. Stacking them also squeezed
 * the column to one icon's width, which is why the header was the widest thing in it.
 * </p>
 *
 * <p>
 * At 375px the same table showed Name and a truncated Email and nothing else — every other
 * column, including all four actions, off-screen behind a horizontal scroll whose scrollbar the
 * app hides. A container that hides content without saying so is worse than one that does not
 * hide it, which is the whole reason <code>ScrollArea</code> exists in this codebase.
 * </p>
 *
 * <p>
 * Round 4 measured all of it in Chromium against a live stack — a seeded club of seven members
 * at 375, 768 and 1440px — because rounds 3 and 4 had by then asserted <code>flex-wrap</code>
 * and <code>flex-row</code> against each other on the same element with no measurement behind
 * either. The numbers: wrapping lets the table squeeze the actions column from 197px to 96px
 * and the row grows to <b>92.5–136.5px</b>; not wrapping holds it at <b>60.5–69px</b>. So
 * wrapping causes the tall row rather than curing it, and this file's original claim — that
 * stacking is what produces a 164px row — was right about the cause and would have been
 * defeated by the "fix".
 * </p>
 *
 * <p>
 * The second measurement is the one neither round took: with the actions merely on one line,
 * <b>0 of 27</b> action controls were inside the scroller's box before the admin scrolled, at
 * both 768 and 1440px — the table is 1141px against a 990px card. Pinning the actions column
 * to the right edge, as the identity column is already pinned to the left, makes that
 * <b>27 of 27</b>.
 * </p>
 *
 * <p>
 * jsdom has no layout, so no pixel here can be re-measured; what these assertions hold is the
 * three decisions that produced the pixels — the actions run along the row, the actions column
 * is pinned, and the scroll region announces itself. <code>e2e/admin-members-layout.spec.ts</code>
 * re-measures the pixels in a real browser.
 * </p>
 */

afterEach(() => vi.unstubAllGlobals());

function renderMembers() {
  stubFetch([
    { path: "/api/v1/admin/members/", body: [memberFixture()] },
    { path: "/api/v1/admin/biometric/enrollments", body: [] },
  ]);
  return renderPage(<AdminMembersPage />);
}

describe("the admin members table", () => {
  it("says it scrolls sideways instead of hiding the columns silently", async () => {
    renderMembers();
    // ScrollArea's region is focusable and named, so the columns off the right-hand edge are
    // reachable by keyboard and announced rather than simply missing.
    const region = await screen.findByRole("region", { name: "Members table" });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(region.querySelector("table")).not.toBeNull();
  });

  it("lays the row actions along the row, not down it", async () => {
    renderMembers();
    // D3-B06: this control was a 32×32 icon-only button, four to a row, twelve rows —
    // WCAG 2.5.5 asks 44, and the rest of this chrome already uses a coarse-pointer minimum.
    // It is now a labelled 44px button, in the same place in the same row.
    const adjust = await screen.findByRole("button", { name: "Top up" });
    const actions = adjust.parentElement!;
    // Four 32px buttons stacked vertically is a 164px row. This is the assertion that stops it
    // coming back as a "tidier" column — or as a wrapping one, which measures at 136.5px and
    // is the same defect wearing a different class name.
    expect(actions.className).toContain("flex-row");
    expect(actions.className).not.toContain("flex-col");
    expect(actions.className).not.toContain("flex-wrap");
  });

  it("pins the actions column so the buttons do not start off-screen", async () => {
    renderMembers();
    // D3-B06: this control was a 32×32 icon-only button, four to a row, twelve rows —
    // WCAG 2.5.5 asks 44, and the rest of this chrome already uses a coarse-pointer minimum.
    // It is now a labelled 44px button, in the same place in the same row.
    const adjust = await screen.findByRole("button", { name: "Top up" });
    const cell = adjust.closest("td")!;
    const header = screen.getByRole("columnheader", { name: "Actions" });
    // 0 of 27 controls on screen before this, 27 of 27 after — see the file comment. The
    // header is pinned with the cells or it slides away from the column it names, and both
    // need an opaque background because the other columns pass underneath.
    expect(cell.className).toMatch(/sm:sticky/);
    expect(cell.className).toMatch(/sm:right-0/);
    expect(cell.className).toMatch(/bg-bg-surface/);
    expect(header.className).toMatch(/sticky/);
    expect(header.className).toMatch(/right-0/);
    expect(header.className).toMatch(/bg-bg-muted/);
  });

  /**
   * The column that was drawn and invisible.
   *
   * <p>
   * A right-pinned column is pulled left of its in-flow position by exactly the un-scrolled
   * overflow, so whatever sits in that band is underneath it. Measured in Chromium against
   * a live stack: the table is 1079px, the scroll container was <b>990px at 1440 AND at
   * 1920</b>, and the 89px band immediately left of the pins is where the 99px `Joined`
   * column sat — header rendering as a bare glyph, each cell as a single `S`, at every
   * desktop width, with ~800px of page beside it unused. At 768 the overflow is 345px and
   * `Status` and `Class` go under as well.
   * </p>
   *
   * <p>
   * Column ORDER cannot fix that — the band is wherever the pins land, so every arrangement
   * has a victim — which is why three rounds arguing about order got nowhere. The overflow
   * itself is what goes: `/admin/*` gets the `wide` frame (AdminLayout), and below the width at
   * which a column fits it is <b>not drawn</b> rather than drawn underneath something. The
   * card layout below `sm` keeps every field, because nothing is a column there.
   * </p>
   *
   * <p>
   * jsdom has no layout, so what is asserted here is the decision, not the pixels:
   * `e2e/admin-members-layout.spec.ts` re-measures those in a browser.
   * </p>
   */
  it("draws a column only at the widths where it fits, and keeps every field in card mode", async () => {
    renderMembers();
    await screen.findByRole("button", { name: "Top up" });

    // R16 (P2) retired the viewport breakpoints (`md`/`lg`/`xl:table-cell`): the admin rail
    // takes 16rem of the viewport, so the thresholds are now container queries on the card,
    // stated in rem. The invariant is unchanged — each optional column has ONE threshold, and
    // the order they arrive in is Class, then Member # and Joined together, then Email.
    const expected: Record<string, string> = {
      // Email is the widest optional column and lands last, at the width where the whole
      // table finally fits its container.
      Email: "[@container(min-width:72.125rem)]:!table-cell",
      "Member #": "[@container(min-width:58.625rem)]:!table-cell",
      Joined: "[@container(min-width:58.625rem)]:!table-cell",
      Class: "[@container(min-width:45.875rem)]:!table-cell",
    };

    for (const [label, bp] of Object.entries(expected)) {
      const header = screen.getByRole("columnheader", { name: new RegExp(`^${label}`) });
      expect(header.className, `${label} header`).toContain("hidden");
      expect(header.className, `${label} header`).toContain(bp);

      const cell = document.querySelector<HTMLElement>(`tbody td[data-label="${label}"]`)!;
      // `block` first: below `sm` the row is a card and every field is on screen.
      expect(cell.className, `${label} cell`).toMatch(/(^|\s)block(\s|$)/);
      expect(cell.className, `${label} cell`).toContain("sm:hidden");
      expect(cell.className, `${label} cell`).toContain(bp);
    }

    // Name, Status, Balance and Actions are the four that never drop: identity, state,
    // money, and the things an admin came here to press.
    for (const label of ["Status", "Balance", "Actions"]) {
      const cell = document.querySelector<HTMLElement>(`tbody td[data-label="${label}"]`)!;
      expect(cell.className, `${label} cell`).not.toContain("sm:hidden");
    }
  });

  it("pins the balance header with its cells, at the same offset", async () => {
    renderMembers();
    await screen.findByRole("button", { name: "Top up" });
    const balance = screen.getByRole("columnheader", { name: "Balance" });
    const actions = screen.getByRole("columnheader", { name: "Actions" });
    // Balance is pinned beside Actions rather than left to scroll under it — measured in
    // Chromium, the unpinned column showed `123456.78 cr` as `12345` at rest at 1440px and
    // `1500.00 cr` as `150` at scrollLeft 96. See the note on the Actions cell in
    // AdminMembers.tsx for why column order could not fix that at 768px.
    //
    // The header carries the same two numbers as the body cells and they have to agree with
    // them, or the header names one column while sitting over another. A single mismatched
    // bracket here is the whole defect coming back, so the offset is compared to the width
    // rather than either being asserted alone.
    expect(balance.className).toMatch(/sticky/);
    expect(balance.className).toMatch(/bg-bg-muted/);
    const headerOffset = /right-\[(\d+)px\]/.exec(balance.className)?.[1];
    const headerWidth = /min-w-\[(\d+)px\]/.exec(actions.className)?.[1];
    expect(headerOffset, "balance header needs an explicit right-[Npx]").toBeDefined();
    expect(headerWidth, "actions header needs an explicit min-w-[Npx]").toBeDefined();
    expect(headerOffset).toBe(headerWidth);

    // ...and agree with the body cells, which are what the balance is actually drawn in.
    const cell = document.querySelector<HTMLElement>('tbody td[data-label="Balance"]')!;
    expect(/sm:right-\[(\d+)px\]/.exec(cell.className)?.[1]).toBe(headerOffset);
  });
});

/**
 * The three findings D3 raised about this table's own controls, each verified against the
 * code before it was fixed — designers can be wrong, and one of the four was.
 *
 * <p>
 * <b>D3-B12 does not reproduce and is deliberately not "fixed".</b> The finding was that
 * `Name`, `Email`, `Member #`, `Status` and `Joined` render sentence-case while `CLASS`,
 * `BALANCE` and `ACTIONS` render upper-case, because the first five come from `SortHeader`
 * and the last three from `Cell`'s `data-label`. On this tree the whole `<thead>` carries
 * `uppercase`, so every desktop header renders the same way and the phone card labels are a
 * separate, deliberately different treatment. The design read an older tip. Recorded here
 * rather than silently dropped, so nobody re-opens it.
 * </p>
 */
describe("the members table's own controls, at the size a club actually uses", () => {
  const routes = (): StubRoute[] => [
    { path: "/api/v1/admin/members/", body: [
      memberFixture({ status: "PendingApproval" }),
      memberFixture({ membership_id: "m2", user_id: "u2", full_name: "Grace Hopper", status: "Suspended" }),
      memberFixture({ membership_id: "m3", user_id: "u3", full_name: "Alan Turing", member_class: "LeagueOrSenior" }),
    ] },
    { path: "/api/v1/admin/biometric/enrollments", body: [] },
    { path: "/api/v1/admin/ledger/", body: [] },
  ];

  /** D3-B07: measured at 72×36 and 61×36. Approving somebody is what lets them through a door. */
  it("gives Approve and Reject a 44px target", async () => {
    stubFetch(routes());
    renderPage(<AdminMembersPage />);

    for (const name of ["Approve", "Reject"]) {
      const control = await screen.findByRole("button", { name });
      expect(control.className, `${name} is still 36px`).toContain("min-h-11");
      expect(control.className).not.toContain("h-9");
    }
  });

  /**
   * D3-B13: a native select does not shrink its own text, so a fixed-width column clipped
   * "League or senior" to "League or senio" — one of only two values the column can hold.
   */
  it("gives the class select a 44px target and a way to read its full value", async () => {
    stubFetch(routes());
    renderPage(<AdminMembersPage />);

    const select = await screen.findByLabelText("Member class for Alan Turing");
    expect(select.className).toContain("min-h-11");
    expect(select).toHaveAttribute("title", "League or senior");
  });

  /**
   * D3-B18: two controls vanished from a suspended row with nothing saying why, which reads
   * as a rendering fault rather than as a rule.
   */
  it("says why a suspended member's row is shorter than everybody else's", async () => {
    stubFetch(routes());
    renderPage(<AdminMembersPage />);

    await screen.findByText("Grace Hopper");
    // In the row, not in a tooltip: a title is invisible on a phone, to a screen reader and
    // to touch, which is the whole of this audience.
    const said = await screen.findByText(/no top-ups or fingerprints until they are reactivated/);
    expect(said.closest("tr")).toContainElement(screen.getByTitle("Reactivate member"));
  });

  it("offers no top-up on a suspended row at all, rather than one that refuses", async () => {
    stubFetch(routes());
    renderPage(<AdminMembersPage />);

    await screen.findByText("Grace Hopper");
    const row = screen.getByText(/no top-ups or fingerprints/).closest("tr")!;
    expect(within(row).queryByRole("button", { name: "Top up" })).not.toBeInTheDocument();
  });
});
