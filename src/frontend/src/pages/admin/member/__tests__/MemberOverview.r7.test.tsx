import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { signOut } from "@/test/harness";
import { BOOKINGS_TAB_COPY, OVERVIEW_COPY } from "@/lib/memberDetailCopy";
import { MEMBER_ID, baseRoutes, bookingRow, detailFixture, renderMember, serve } from "./memberKit";

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
