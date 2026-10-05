import { afterEach, describe, expect, it, vi } from "vitest";
import { stubFetch } from "@/test/harness";
import type { BulkBookResponse, MemberBulkBookResponse } from "@/lib/api";
import { fromAdminBulk, fromMemberBulk } from "../bookFlow";
import { cancelBookings } from "../cancelFlow";
import type { GridBooking, SelectedSlot } from "../types";

/**
 * R16 J16-12 — the results step lists the slots in the order the sheet showed them (time order,
 * `slotOrder`), whatever order the club's answer came back in.
 */

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const SENT: SelectedSlot[] = [
  { courtId: "c2", courtName: "Court 2", startsAt: "2030-09-09T14:00:00.000Z", sliceCount: 1, priceMinutes: 15 },
  { courtId: "c1", courtName: "Court 1", startsAt: "2030-09-09T15:00:00.000Z", sliceCount: 1, priceMinutes: 15 },
];
const face = (s: SelectedSlot) => s.startsAt;

describe("R16 J16-12 — results keep the sheet's order", () => {
  it("a member's batch answered last-first", () => {
    const res = { results: [{ index: 1, status: "booked" }, { index: 0, status: "refused", reason: "slot_taken" }], balance_after_minutes: 10 } as unknown as MemberBulkBookResponse;
    expect(fromMemberBulk(res, SENT, face).rows.map((r) => r.courtName)).toEqual(["Court 2", "Court 1"]);
  });

  it("the desk's batch answered last-first", () => {
    const res = { results: [{ index: 1, status: "booked" }, { index: 0, status: "booked" }] } as unknown as BulkBookResponse;
    expect(fromAdminBulk(res, SENT, face, false).rows.map((r) => r.courtName)).toEqual(["Court 2", "Court 1"]);
  });

  it("the club's bulk cancel answered last-first", async () => {
    const base: GridBooking = {
      bookingId: "bk-a", courtId: "c2", courtName: "Court 2", startsAt: "2030-09-09T14:00:00.000Z", endsAt: "2030-09-09T14:15:00.000Z",
      whenLabel: "", mine: false, memberFirstName: "Owen", memberPhotoUrl: null, checkedIn: null, amountChargedMinutes: 15, timezone: "Africa/Johannesburg",
    };
    const bookings = [base, { ...base, bookingId: "bk-b", courtId: "c1", courtName: "Court 1", startsAt: "2030-09-09T15:00:00.000Z", memberFirstName: "Thandi" }];
    stubFetch([{
      path: "/api/v1/admin/bookings/bulk-cancel", method: "POST",
      body: { results: [{ booking_id: "bk-b", status: "cancelled", refund_minutes: 15, penalty_minutes: 0 }, { booking_id: "bk-a", status: "cancelled", refund_minutes: 15, penalty_minutes: 0 }] },
    }]);
    const run = await cancelBookings({ bookings, isAdmin: true, waive: false, reason: "Rain", idempotencyKey: "k", reread: async () => null, quotes: null });
    expect(run.rows.map((r) => r.key)).toEqual(["bk-a", "bk-b"]);
  });
});
