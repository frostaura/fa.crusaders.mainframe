import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { signOut } from "@/test/harness";
import { BOOKINGS_TAB_COPY, OVERVIEW_COPY } from "@/lib/memberDetailCopy";
import { BASE, MEMBER_ID, baseRoutes, bookingRow, detailFixture, renderMember, serve } from "./memberKit";

/**
 * R7 L7-16 — the Overview's own words: the account's standing is said as a word ("Active"), never
 * the API's raw "active"; and "Booked by the member with Lena" is ONE run of text — two flex items
 * with a gap read and copied as "Booked by the member  with Lena".
 */
beforeEach(() => { signOut(); });
afterEach(() => vi.unstubAllGlobals());

describe("L7-16", () => {
  it("says the account's standing in a word", async () => {
    serve(baseRoutes(detailFixture({ account_status: "active", next_bookings: [] })));
    renderMember();
    const term = (await screen.findAllByText(OVERVIEW_COPY.accountStatus)).find((el) => el.tagName === "DT")!;
    const value = term.nextElementSibling as HTMLElement;
    expect(value.textContent).toBe("Active");
  });

  it("reads 'Booked by the member with Lena' as one sentence, one space", async () => {
    const own = bookingRow({ booking_id: "bk-own" });
    serve(baseRoutes(detailFixture({ next_bookings: [own] }), [
      { path: "/api/v1/bookings/bk-own", body: {
        organiser: { user_id: MEMBER_ID, name: "Thandi Mokoena", photo_url: null },
        players: [{ user_id: MEMBER_ID, name: "Thandi Mokoena" }, { user_id: "lena", name: "Lena Botha" }],
      } },
    ]));
    renderMember();
    const line = await screen.findByText((_, el) => el?.tagName === "SPAN" && el.textContent === `${BOOKINGS_TAB_COPY.bookedBySelf} with Lena`);
    await waitFor(() => expect(line).toBeInTheDocument());
  });
});

/**
 * R7 E7-5 (BE lists them now): a court the member paid for at the box is the ORGANISER's booking —
 * the desk cannot cancel it from this member's record, and its figure is what this member is out.
 */
describe("E7-5 — a court paid for at the box", () => {
  it("has no Cancel, says it was paid for at the box, and shows what the payer is out", async () => {
    const payer = bookingRow({
      booking_id: "bk-paid", role: "payer", charged_minutes: 45, cost_minutes: 45,
      organiser: { user_id: "sam", name: "Sam Okafor", is_self: false },
      booked_by: { user_id: "sam", name: "Sam Okafor", is_self: false },
    });
    serve(baseRoutes(detailFixture(), [
      { path: `${BASE}/bookings`, body: { when: "upcoming", items: [payer], next_cursor: null } },
    ]));
    renderMember(`/admin/members/${MEMBER_ID}/bookings`);
    const line = (await screen.findByText(BOOKINGS_TAB_COPY.payerOf("Sam Okafor"))).closest("li")!;
    expect(within(line).getByText(BOOKINGS_TAB_COPY.payerBadge)).toBeInTheDocument();
    expect(within(line).queryByRole("button", { name: /^Cancel/ })).toBeNull();
    expect(line.textContent).toContain("45 minutes");
  });
});
