import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { signOut } from "@/test/harness";
import { BOOKINGS_TAB_COPY } from "@/lib/memberDetailCopy";
import type { BookingDetail } from "@/lib/playersApi";
import { othersOn } from "../useOthersOnCourt";
import { BASE, MEMBER_ID, baseRoutes, bookingRow, detailFixture, renderMember, serve } from "./memberKit";

/**
 * Review round 2 — F3-8 (C6): a member who plays every week as somebody's partner read as someone
 * who never played; the server now lists those games with `role: "partner"` and the organiser.
 * F3-13: "Booked by the member with Sam" named nobody when two Sams were on the court.
 */
const PARTNER_ROW = bookingRow({
  booking_id: "bk-partner", role: "partner",
  organiser: { user_id: "org-1", name: "Alice Organiser", is_self: false },
  booked_by: { user_id: "org-1", name: "Alice Organiser", is_self: false },
  charged_credits: 48, starts_at: "2099-10-01T16:00:00Z", ends_at: "2099-10-01T17:00:00Z",
});

describe("member detail — the games a member plays as a partner", () => {
  beforeEach(() => { signOut(); });
  afterEach(() => vi.unstubAllGlobals());

  it("lists a partner game with the organiser's name, no charge figure and no Cancel", async () => {
    serve(baseRoutes(detailFixture(), [
      { path: `${BASE}/bookings`, body: { when: "upcoming", items: [PARTNER_ROW], next_cursor: null } },
    ]));
    renderMember(`/admin/members/${MEMBER_ID}/bookings`);

    const line = (await screen.findByText(BOOKINGS_TAB_COPY.partnerOf("Alice Organiser"))).closest("li")!;
    expect(within(line).getByText(BOOKINGS_TAB_COPY.partnerBadge)).toBeInTheDocument();
    expect(within(line).queryByText("48.00 cr")).toBeNull();
    expect(within(line).queryByRole("button", { name: /^Cancel/ })).toBeNull();
  });
});

describe("who else is on the court (F3-13)", () => {
  const detail = (names: string[]): BookingDetail => ({
    organiser: { user_id: "o", name: names[0], photo_url: null },
    players: names.slice(1).map((name, i) => ({ user_id: `p${i}`, name })),
  }) as unknown as BookingDetail;

  it("says first names while they are enough", () => {
    expect(othersOn(detail(["Sam Okafor", "Thandi Mokoena"]), MEMBER_ID, "Ada Lovelace")).toEqual(["Sam", "Thandi"]);
  });

  it("says full names when two people on the court share a first name", () => {
    expect(othersOn(detail(["Sam Okafor", "Sam Rivers"]), MEMBER_ID, "Ada Lovelace")).toEqual(["Sam Okafor", "Sam Rivers"]);
  });

  it("says the full name when the other player shares the member's own first name", () => {
    expect(othersOn(detail(["Sam Rivers"]), MEMBER_ID, "Sam Okafor")).toEqual(["Sam Rivers"]);
  });
});
