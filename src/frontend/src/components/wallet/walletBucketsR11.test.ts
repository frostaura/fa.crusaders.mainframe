import { describe, expect, it } from "vitest";
import type { WalletReport } from "@/lib/api";
import { BUCKET_LABELS, bucketRows } from "./walletBuckets";

/**
 * R11 J11-4 — a package the club GAVE at no charge was counted as "Bought". The report's
 * `given_minutes` (the part of `top_ups_minutes` that cost the member nothing — a desk give, R
 * 0.00) is its own row, and Bought is what was paid for. The rows still add up to the net.
 */
const REPORT: WalletReport = {
  from: "2026-09-03", to: "2026-10-03",
  top_ups_minutes: 360, spent_minutes: 60, refunds_minutes: 0, penalties_minutes: 0, adjustments_minutes: 0,
  reversals_minutes: 0, net_movement_minutes: 300, penalty_count: 0, attended_bookings: 0, minutes_on_court: 0, count: 3,
};

const sum = (rows: { minutes: number }[]) => rows.reduce((n, r) => n + r.minutes, 0);

describe("R11 J11-4 — a package given at no charge is not 'Bought'", () => {
  it("splits the given minutes into their own row, and the rows still add up", () => {
    const rows = bucketRows({ ...REPORT, given_minutes: 120 } as WalletReport);
    expect(rows.find((r) => r.key === "bought")?.minutes).toBe(240);
    expect(rows.find((r) => r.key === "given")).toEqual({ key: "given", label: BUCKET_LABELS.given, minutes: 120 });
    expect(sum(rows)).toBe(300);
  });

  it("an all-given period reads Bought 0, never the gift as a purchase", () => {
    const rows = bucketRows({ ...REPORT, top_ups_minutes: 120, net_movement_minutes: 60, given_minutes: 120 } as WalletReport);
    expect(rows.find((r) => r.key === "bought")?.minutes).toBe(0);
    expect(rows.find((r) => r.key === "given")?.minutes).toBe(120);
  });

  it("no given row when nothing was given, or against an older API", () => {
    expect(bucketRows(REPORT).find((r) => r.key === "given")).toBeUndefined();
    expect(bucketRows({ ...REPORT, given_minutes: 0 } as WalletReport).find((r) => r.key === "given")).toBeUndefined();
  });
});
