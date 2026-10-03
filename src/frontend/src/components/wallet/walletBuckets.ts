import type { WalletReport } from "@/lib/api";
import { REPORT_SHARES_COPY } from "@/lib/playersCopy";

/**
 * R6 L6-6 / J6-3 — every way minutes moved in a period, as signed rows that ADD UP to the net.
 * The wallet's "Last 30 days" showed Bought, Spent and Net only, so a member with an adjustment,
 * a refund, a penalty or a share read three figures that did not add up. The labels are the
 * activity page's own words.
 */
export const BUCKET_LABELS = {
  bought: "Bought",
  /** R11 J11-4 — a package the club gave at no charge: added, never bought. */
  given: "Given by the club",
  spent: "Spent",
  refunds: "Refunds (net)",
  penalties: "Penalties",
  adjustments: "Adjustments",
  shares: REPORT_SHARES_COPY.memberShares,
  reversals: "Payment reversals",
  /** What no bucket explains (a ledger type the report does not bucket) — so the rows still add up. */
  other: "Other movements",
} as const;

export type BucketRow = { key: keyof typeof BUCKET_LABELS; label: string; minutes: number };

/**
 * Bought and Spent always (they are the card's question); every other bucket only when it moved,
 * and a residual "Other" only when the buckets do not reach the net. Signed: in is +, out is −.
 */
/**
 * R11 J11-4 — the part of `top_ups_minutes` that cost the member nothing (a package the club gave,
 * R 0.00), from the report's `given_minutes`. Absent before the server sent it: then everything
 * funded reads as bought, as it always did. Clamped, so a figure can never make Bought negative.
 */
export function givenMinutes(report: { top_ups_minutes: number; given_minutes?: number }): number {
  return Math.max(0, Math.min(report.top_ups_minutes, report.given_minutes ?? 0));
}

export function bucketRows(report: WalletReport): BucketRow[] {
  const given = givenMinutes(report);
  const all: BucketRow[] = [
    { key: "bought", label: BUCKET_LABELS.bought, minutes: report.top_ups_minutes - given },
    { key: "given", label: BUCKET_LABELS.given, minutes: given },
    { key: "spent", label: BUCKET_LABELS.spent, minutes: -report.spent_minutes },
    { key: "refunds", label: BUCKET_LABELS.refunds, minutes: report.refunds_minutes ?? 0 },
    { key: "penalties", label: BUCKET_LABELS.penalties, minutes: -(report.penalties_minutes ?? 0) },
    { key: "adjustments", label: BUCKET_LABELS.adjustments, minutes: report.adjustments_minutes ?? 0 },
    { key: "shares", label: BUCKET_LABELS.shares, minutes: report.share_transfers_minutes ?? 0 },
    { key: "reversals", label: BUCKET_LABELS.reversals, minutes: report.reversals_minutes ?? 0 },
  ];
  const rows = all.filter((r) => r.key === "bought" || r.key === "spent" || r.minutes !== 0);
  const other = report.net_movement_minutes - all.reduce((sum, r) => sum + r.minutes, 0);
  if (other !== 0) rows.push({ key: "other", label: BUCKET_LABELS.other, minutes: other });
  return rows;
}
