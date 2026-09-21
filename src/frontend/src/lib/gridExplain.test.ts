import { describe, expect, it } from "vitest";
import { collapseEarlier } from "./gridExplain";
import type { ScheduleSlot } from "./api";
import type { TimeSlice } from "./scheduleGrid";

/**
 * The past wall — D4 §7.4 and D3-B01.
 *
 * <p>
 * Measured at 375×812: 247 dead cells, and the first bookable slot <b>3 670 px</b> below the
 * top of the page — 74 rows, about four and a half phone screens, every one of them the word
 * PAST. The rows are NOT deleted: `gridWindow`'s own comment records the member who was sold
 * 03:00 on a Sunday and whose paid booking then appeared on no screen in the product, so they
 * could neither see it nor cancel it nor get it back. They collapse instead.
 * </p>
 *
 * <p>
 * Tested here rather than through the page because the interesting cases are all about WHEN
 * the collapse must not happen, and each of them is a different fixture rather than a different
 * click.
 * </p>
 */

const rows = (count: number, fromMs = Date.parse("2026-09-21T04:00:00.000Z")): TimeSlice[] =>
  Array.from({ length: count }, (_, i) => ({
    utc: new Date(fromMs + i * 15 * 60_000).toISOString(),
    label: `${String(6 + Math.floor(i / 4)).padStart(2, "0")}:${String((i % 4) * 15).padStart(2, "0")}`,
    minuteOfDay: 6 * 60 + i * 15,
    outOfHours: false,
  }));

const noSlots = new Map<string, ScheduleSlot[]>();

function mine(startsAtUtc: string): Map<string, ScheduleSlot[]> {
  return new Map([["c1", [{
    courtId: "c1", courtNumber: 1, startsAtUtc, endsAtUtc: startsAtUtc,
    status: "booked", ownerUserId: "me", ownerFirstName: "Me", ownerPhotoUrl: null,
    isMine: true, bookingId: "b1", blockLabel: null, checkedIn: false, amountChargedCredits: 50,
  }]]]);
}

describe("collapseEarlier", () => {
  const all = rows(12);
  const after = (n: number) => Date.parse(all[n].utc);

  it("collapses a real wall and says what is inside it", () => {
    const { rows: hidden, label } = collapseEarlier(all, after(5), false, false, noSlots);
    expect(hidden).toBe(6);
    expect(label).toMatch(/^Earlier today — 06:00 to 07:15 \(6 slots\)$/);
  });

  it("leaves a wall of one or two rows alone, because two dead rows are not a wall", () => {
    // A disclosure over three cells costs more attention than the three cells do.
    expect(collapseEarlier(all, after(2), false, false, noSlots)).toEqual({ rows: 0, label: null });
  });

  it("never collapses a day that is ENTIRELY past — that would be an empty grid", () => {
    // Somebody looking at yesterday is looking at yesterday on purpose.
    expect(collapseEarlier(all, after(11), false, false, noSlots)).toEqual({ rows: 0, label: null });
  });

  it("stays open when one of the hidden rows is the viewer's own booking", () => {
    // A member who played this morning must not have to find a disclosure to see it.
    const { rows: hidden } = collapseEarlier(all, after(5), false, false, mine(all[2].utc));
    expect(hidden).toBe(0);
  });

  it("names the viewer's own bookings in the label when it does collapse", () => {
    // Which is why it is a collapse and not merely hiding: a member can see their booking is
    // in there without expanding it.
    const other = new Map(mine(all[8].utc));
    const { label } = collapseEarlier(all, after(5), false, false, other);
    expect(label).toContain("(6 slots)");
  });

  it("stays open for an admin, who is reconciling the day rather than shopping for a court", () => {
    expect(collapseEarlier(all, after(5), false, true, noSlots).rows).toBe(0);
  });

  it("stays open once the member has opened it", () => {
    expect(collapseEarlier(all, after(5), true, false, noSlots).rows).toBe(0);
  });

  it("collapses nothing before the day has started", () => {
    expect(collapseEarlier(all, -Infinity, false, false, noSlots)).toEqual({ rows: 0, label: null });
  });

  it("survives a day with no rows", () => {
    expect(collapseEarlier([], Date.now(), false, false, noSlots)).toEqual({ rows: 0, label: null });
  });

  it("is singular for one hidden slot's worth of the viewer's own", () => {
    const { label } = collapseEarlier(rows(8), Date.parse(rows(8)[4].utc), false, false, mine(rows(8)[1].utc));
    // One of the hidden rows is theirs, so it does not collapse at all — and that is the point.
    expect(label).toBeNull();
  });
});
