import { describe, expect, it } from "vitest";
import type { LedgerRow } from "@/lib/api";
import { groupShareRows, shareBookingIds, shareSide } from "./shareGroups";

/**
 * D11 — a booking's ShareTransfer rows gather under one line. Pure: order in, order out, every
 * other row untouched, and nothing reaches past the page it was given.
 */

function row(id: string, over: Partial<LedgerRow> = {}): LedgerRow {
  return {
    id, at: "2026-09-30T10:00:00Z", from: "Club treasury", to: "Nomsa Khumalo",
    amountMinutes: 25, signedAmountMinutes: 25, type: "ShareTransfer", comment: "Share of a split booking",
    subjectUserId: "me", subjectName: "Nomsa Khumalo", actorUserId: "sam", actorName: "Sam Petersen",
    relatedBookingId: "b1", ...over,
  };
}

const charge = (id: string) => row(id, { type: "BookingCharge", signedAmountMinutes: -100, amountMinutes: 100, comment: "Booking charge" });

describe("groupShareRows", () => {
  it("keeps every non-share row, in order, untouched", () => {
    const rows = [charge("c1"), row("t1", { type: "TopUp", relatedBookingId: null }), charge("c2")];
    const items = groupShareRows(rows);
    expect(items).toEqual(rows.map((r) => ({ kind: "row", row: r })));
    expect((items[0] as { row: LedgerRow }).row).toBe(rows[0]);
  });

  it("gathers one booking's shares under one group, placed where its first row was", () => {
    const rows = [charge("c1"), row("s1"), row("s2"), charge("c2")];
    const items = groupShareRows(rows);
    expect(items.map((i) => (i.kind === "row" ? i.row.id : `group:${i.bookingId}`))).toEqual(["c1", "group:b1", "c2"]);
    const group = items[1];
    expect(group.kind === "shares" && group.rows.map((r) => r.id)).toEqual(["s1", "s2"]);
    expect(group.kind === "shares" && group.net).toBe(50);
  });

  it("gathers a booking's shares that are not next to each other", () => {
    const items = groupShareRows([row("s1"), charge("c1"), row("s2"), row("x1", { relatedBookingId: "b2" })]);
    expect(items.map((i) => (i.kind === "row" ? i.row.id : `group:${i.bookingId}:${i.rows.length}`)))
      .toEqual(["group:b1:2", "c1", "group:b2:1"]);
  });

  it("keys groups by booking: two bookings never share a line", () => {
    const items = groupShareRows([row("s1"), row("x1", { relatedBookingId: "b2" }), row("s2")]);
    const groups = items.filter((i) => i.kind === "shares");
    expect(groups.map((g) => g.kind === "shares" && g.bookingId)).toEqual(["b1", "b2"]);
  });

  it("nets a paid-then-returned share, and rounds away float dust", () => {
    const items = groupShareRows([
      row("s1", { signedAmountMinutes: 33.33 }), row("s2", { signedAmountMinutes: 33.34 }),
      row("s3", { signedAmountMinutes: 0.1 }), row("s4", { signedAmountMinutes: 0.2 }),
    ]);
    expect(items[0].kind === "shares" && items[0].net).toBe(66.97);
  });

  it("leaves a share row that names no booking as a plain row", () => {
    const orphan = row("s1", { relatedBookingId: null });
    expect(groupShareRows([orphan])).toEqual([{ kind: "row", row: orphan }]);
  });

  it("groups within a page only: the same booking on the next page groups on its own", () => {
    const page1 = groupShareRows([row("s1"), row("s2")]);
    const page2 = groupShareRows([row("s3")]);
    expect(page1[0].kind === "shares" && page1[0].rows).toHaveLength(2);
    expect(page2[0].kind === "shares" && page2[0].rows).toHaveLength(1);
  });

  it("lists the bookings a page names, once each, in first-seen order", () => {
    expect(shareBookingIds([row("s1", { relatedBookingId: "b2" }), charge("c"), row("s2"), row("s3", { relatedBookingId: "b2" })]))
      .toEqual(["b2", "b1"]);
  });
});

describe("shareSide", () => {
  it("reads the organiser off money in and the partner off money out", () => {
    expect(shareSide({ rows: [row("a")], net: 25 })).toBe("organiser");
    expect(shareSide({ rows: [row("a", { signedAmountMinutes: -25 })], net: -25 })).toBe("partner");
  });

  it("reads a netted-to-zero group by the direction the money first went (the oldest row)", () => {
    const newestFirst = [row("back", { signedAmountMinutes: 25 }), row("paid", { signedAmountMinutes: -25 })];
    expect(shareSide({ rows: newestFirst, net: 0 })).toBe("partner");
  });
});
