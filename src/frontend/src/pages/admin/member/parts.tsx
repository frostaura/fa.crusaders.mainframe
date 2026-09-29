import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { CheckCircle } from "@/components/ui/icons";
import { Skeleton } from "@/components/ui/skeleton";
import { clubClock } from "@/lib/clubClock";
import type { MemberBookingRow } from "@/lib/memberDetailApi";
import { BOOKING_STATUS, BOOKINGS_TAB_COPY as COPY } from "@/lib/memberDetailCopy";
import { cn, formatCredits } from "@/lib/utils";
import { bookingWhen, dayParts } from "./memberTime";

/**
 * The pieces the member-detail tabs share: one booking line (Overview's "Next bookings" and every
 * page of the Bookings tab print the same row, as the server's shared `MemberBookingRow` intends)
 * and a list skeleton in the same rhythm.
 */

function bookedByLine(row: MemberBookingRow): string {
  if (row.booked_by.is_self) return COPY.bookedBySelf;
  return row.booked_by.name ? COPY.bookedBy(row.booked_by.name) : COPY.bookedByUnknown;
}

/**
 * One booking. A date tile, the court and the hours, who booked it, then its status, what it
 * cost and — where the caller offers one — the action. Stacks on a phone; one line on a desk.
 */
export function BookingLine({ row, zone, action, people }: {
  row: MemberBookingRow; zone: string; action?: ReactNode;
  /** D9 — who else is on the court ("with Sam"), when it has been read. */
  people?: ReactNode;
}) {
  const d = dayParts(row.starts_at, zone);
  const status = BOOKING_STATUS[row.status] ?? { word: row.status, tone: "neutral" as const };
  const court = row.court_name ?? COPY.unknownCourt;
  const cancelled = row.status === "cancelled";
  return (
    <li
      data-booking-id={row.booking_id}
      className="flex flex-col gap-3 rounded-xl border border-border bg-bg-surface p-3 sm:flex-row sm:items-center sm:gap-4 sm:p-4"
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div
          aria-hidden="true"
          className="flex w-14 shrink-0 flex-col items-center rounded-lg bg-bg-muted py-1.5 leading-tight"
        >
          <span className="text-xs font-semibold uppercase tracking-overline text-text-secondary">{d.weekday}</span>
          <span className="font-display text-xl font-bold tabular-nums text-text-primary">{d.day}</span>
          <span className="text-xs text-text-muted">{d.month}</span>
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className={cn("break-words font-semibold text-text-primary", cancelled && "text-text-secondary line-through")}>
            <span className="sr-only">{`${bookingWhen(row, zone)}, `}</span>
            <span aria-hidden="true">{`${clubClock(row.starts_at, zone)}–${clubClock(row.ends_at, zone)}`}</span>
            {` · ${court}`}
          </p>
          <p className="flex flex-wrap items-center gap-x-2 text-sm text-text-secondary">
            <span>{bookedByLine(row)}</span>
            {people ? <span data-booking-people="">{people}</span> : null}
            {row.checked_in_at ? (
              <span className="inline-flex items-center gap-1 text-success-strong">
                <CheckCircle size={14} weight="bold" aria-hidden="true" />
                {`${COPY.checkedIn} ${clubClock(row.checked_in_at, zone)}`}
              </span>
            ) : null}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-3 sm:justify-end">
        <Badge tone={status.tone}>{status.word}</Badge>
        <span className="text-sm tabular-nums text-text-secondary">{formatCredits(row.charged_credits)}</span>
        {action ? <div className="ml-auto sm:ml-0">{action}</div> : null}
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
