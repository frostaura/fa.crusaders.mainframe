import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScheduleDay } from "@/lib/api";
import { CANCEL_SHEET } from "@/lib/bookingsCopy";
import { CONFLICT_RETRY_ROW } from "@/lib/bookingErrors";
import { cancelBookings } from "../cancelFlow";
import type { GridBooking } from "../types";

/**
 * R17 X17-1 — several cancels where the club answered `503 conflict_retry`: the rows are read back
 * off the day as before, but a row still on the schedule says someone else was changing it — not
 * "the club didn't answer". Varied: the desk's bulk route and a member's own in-turn route, and a
 * silent 503 beside it keeps its own words.
 */
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const booking = (id: string, mine: boolean): GridBooking => ({
  bookingId: id, courtId: "c1", courtName: "Court 1", startsAt: "2030-09-09T16:00:00Z", endsAt: "2030-09-09T16:30:00Z",
  whenLabel: "Mon 9 Sep, 18:00", mine, memberFirstName: mine ? null : "Naledi", memberPhotoUrl: null,
  checkedIn: false, amountChargedMinutes: 30, timezone: "Africa/Johannesburg",
});

const dayWith = (ids: string[]): ScheduleDay => ({
  date: "2030-09-09", timezone: "Africa/Johannesburg", sliceMinutes: 15, dayStartMinute: 360, dayEndMinute: 1320,
  advanceBookingDays: 14, penaltyPct: 30, penaltyWindowMinutes: 15, courts: [],
  slots: ids.map((bookingId) => ({ bookingId, courtId: "c1", startsAtUtc: "2030-09-09T16:00:00Z", endsAtUtc: "2030-09-09T16:30:00Z", status: "booked" })),
} as unknown as ScheduleDay);

function answer(byUrl: (url: string) => { status: number; body: object }) {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const { status, body } = byUrl(String(input));
    return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  }));
}

describe("R17 X17-1 — bulk cancel rows after a conflict_retry", () => {
  it("the desk's bulk route: every row still there says someone else was changing it", async () => {
    answer(() => ({ status: 503, body: { error: "conflict_retry" } }));
    const run = await cancelBookings({
      bookings: [booking("b1", false), booking("b2", false)], isAdmin: true, waive: false, reason: "Rain",
      idempotencyKey: "k", reread: async () => dayWith(["b1", "b2"]),
    });
    expect(run.rows.map((r) => r.detail)).toEqual([CONFLICT_RETRY_ROW.stillThere, CONFLICT_RETRY_ROW.stillThere]);
  });

  it("a member's own, in turn: only the item that clashed says so; a silent 503 keeps its words", async () => {
    answer((url) => (url.includes("b1") ? { status: 503, body: { error: "conflict_retry" } } : { status: 503, body: {} }));
    const run = await cancelBookings({
      bookings: [booking("b1", true), booking("b2", true)], isAdmin: false, waive: false, reason: "",
      idempotencyKey: "k", reread: async () => null,
    });
    const detail = new Map(run.rows.map((r) => [r.key, r.detail]));
    expect(detail.get("b1")).toBe(CONFLICT_RETRY_ROW.unread);
    expect(detail.get("b2")).toBe(CANCEL_SHEET.unsureRow);
  });
});
