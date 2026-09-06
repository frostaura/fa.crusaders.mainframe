import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import AdminMembersPage from "./AdminMembers";
import { memberFixture, renderPage, stubFetch } from "../test/harness";

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
    const adjust = await screen.findByRole("button", { name: "Adjust credit" });
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
    const adjust = await screen.findByRole("button", { name: "Adjust credit" });
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
});
