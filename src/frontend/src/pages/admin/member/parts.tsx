import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { CheckCircle } from "@/components/ui/icons";
import { Skeleton } from "@/components/ui/skeleton";
import { clubClock } from "@/lib/clubClock";
import type { MemberBookingRow } from "@/lib/memberDetailApi";
import { BOOKING_STATUS, BOOKINGS_TAB_COPY as COPY } from "@/lib/memberDetailCopy";
import { cn } from "@/lib/utils";
import { bookingWhen, dayParts } from "./memberTime";

/**
 * The pieces the member-detail tabs share: one booking line (Overview's "Next bookings" and every
 * page of the Bookings tab print the same row, as the server's shared `MemberBookingRow` intends)
 * and a list skeleton in the same rhythm.
 */

function bookedByLine(row: MemberBookingRow): string {
  if (row.role === "partner") return COPY.partnerOf(row.organiser?.name ?? null);
  if (row.role === "payer") return COPY.payerOf(row.organiser?.name ?? null);
  if (row.booked_by.is_self) return COPY.bookedBySelf;
  return row.booked_by.name ? COPY.bookedBy(row.booked_by.name) : COPY.bookedByUnknown;
}

/**
 * One booking. A date tile, the court and the hours, who booked it, then its status, what it
 * cost and — where the caller offers one — the action. Stacks when its text is large for the box; one line on a desk.
 */
/**
 * R6 E6-10 (BE): `sold_ends_at` is the end a booking was SOLD to — `ends_at` is the sweep's cut
 * end on a no-show — and `cost_minutes` what THIS member is out on it (a partner's share on a
 * partner row). An older API sends neither and the row reads as it did.
 */
/** The hours' end and the figure a line shows (E6-10) — split out for lizard's CCN gate. */
function soldAndCost(row: MemberBookingRow, partner: boolean): { ends: string; cost: number | null } {
  const cost = typeof row.cost_minutes === "number" ? row.cost_minutes : partner ? null : row.charged_minutes;
  return { ends: row.sold_ends_at ?? row.ends_at, cost };
}

export function BookingLine({ row, zone, action, people }: {
  row: MemberBookingRow; zone: string; action?: ReactNode;
  /** D9 — who else is on the court ("with Sam"), when it has been read. */
  people?: ReactNode;
}) {
  const d = dayParts(row.starts_at, zone);
  const status = BOOKING_STATUS[row.status] ?? { word: row.status, tone: "neutral" as const };
  const court = row.court_name ?? COPY.unknownCourt;
  const cancelled = row.status === "cancelled";
  const partner = row.role === "partner";
  // R7 E7-5: a court paid for at the box is the organiser's booking too — its figure is `cost_minutes`.
  const { ends, cost } = soldAndCost(row, partner || row.role === "payer");
  return (
    // R8 L8-1: wraps by its own TEXT, never by the viewport. `sm:flex-row` beside a `flex-1` (zero
    // basis) squeezed the hours to a few letters a line at 200 % text on every width; real bases
    // let the parts drop under each other when the text, not the screen, is large.
    <li
      data-booking-id={row.booking_id}
      className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl border border-border bg-bg-surface p-3 sm:p-4"
    >
      <div className="flex min-w-0 flex-[1_1_18rem] flex-wrap items-center gap-3">
        <div
          aria-hidden="true"
          className="flex w-14 shrink-0 flex-col items-center rounded-lg bg-bg-muted py-1.5 leading-tight"
        >
          <span className="text-xs font-semibold uppercase tracking-overline text-text-secondary">{d.weekday}</span>
          <span className="font-display text-xl font-bold tabular-nums text-text-primary">{d.day}</span>
          <span className="text-xs text-text-muted">{d.month}</span>
        </div>
        <div className="flex min-w-0 flex-[1_1_9rem] flex-col gap-0.5">
          <p className={cn("break-words font-semibold text-text-primary", cancelled && "text-text-secondary line-through")}>
            <span className="sr-only">{`${bookingWhen({ starts_at: row.starts_at, ends_at: ends }, zone)}, `}</span>
            <span aria-hidden="true">{`${clubClock(row.starts_at, zone)}–${clubClock(ends, zone)}`}</span>
            {` · ${court}`}
          </p>
          {/* A div, not a <p> (F3.23): the people line can hold a loading Skeleton, a <div>. */}
          <div className="flex flex-wrap items-center gap-x-2 text-sm text-text-secondary">
            {/* A real, shrinkable item (R5 F5-4): a bare span floored at its longest word ran
                "Playing as <long name>'s partner" off a 390 phone at 200% text. */}
            {/* One text run with the people line (R7 L7-16): two flex items with a gap read and
                copied as "Booked by the member  with Lena". */}
            <span className="min-w-0 break-words">
              {bookedByLine(row)}
              {people ? <>{" "}<span data-booking-people="">{people}</span></> : null}
            </span>
            {row.checked_in_at ? (
              <span className="inline-flex items-center gap-1 text-success-strong">
                <CheckCircle size={14} weight="bold" aria-hidden="true" />
                {`${COPY.checkedIn} ${clubClock(row.checked_in_at, zone)}`}
              </span>
            ) : null}
          </div>
        </div>
      </div>
      {/* Wraps (R3 V-4 / X-5): at 320 the Cancel ran 16px past the card and "100.00 cr" broke
          over two lines; now the actions drop to their own line and a figure never splits. */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        {partner ? <Badge tone="info">{COPY.partnerBadge}</Badge> : null}
        {row.role === "payer" ? <Badge tone="info">{COPY.payerBadge}</Badge> : null}
        <Badge tone={status.tone}>{status.word}</Badge>
        {/* What this member is out on it (`cost_minutes`). Without it, a partner's row has no
            figure: `charged_minutes` there is the ORGANISER's charge, not what this member paid. */}
        {cost === null ? null : <span className="whitespace-nowrap text-sm tabular-nums text-text-secondary">{COPY.charged(cost)}</span>}
        {action ? <div className="ml-auto">{action}</div> : null}
      </div>
    </li>
  );
}

/** A list of booking lines, loading — the same height and rhythm, so nothing jumps. */
export function BookingListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-xl border border-border bg-bg-surface p-3 sm:p-4">
          <Skeleton className="h-16 w-14 rounded-lg" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-4 w-1/3" />
          </div>
          <Skeleton className="hidden h-6 w-20 rounded-full sm:block" />
        </div>
      ))}
    </div>
  );
}

/** A figure with its label and a one-line gloss — the 30-day counts. */
export function StatTile({ label, value, hint, tone }: { label: string; value: number; hint: string; tone?: "danger" }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-xl border border-border bg-bg-surface p-4">
      <dt className="text-sm font-medium text-text-secondary">{label}</dt>
      <dd className={cn("font-display text-3xl font-bold tabular-nums text-text-primary", tone === "danger" && value > 0 && "text-danger-strong")}>
        {value}
      </dd>
      <dd className="text-xs text-text-muted">{hint}</dd>
    </div>
  );
}
