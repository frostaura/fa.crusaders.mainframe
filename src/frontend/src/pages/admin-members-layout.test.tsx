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
 * jsdom has no layout, so no pixel here can be re-measured; what these assertions hold is the
 * two decisions that produced the pixels — the actions run along the row, and the scroll region
 * announces itself.
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
    // coming back as a "tidier" column.
    expect(actions.className).toContain("flex-row");
    expect(actions.className).not.toContain("flex-col");
  });
});
