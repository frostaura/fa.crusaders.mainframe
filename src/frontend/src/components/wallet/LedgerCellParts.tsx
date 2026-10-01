import { clubDayAndClock } from "@/lib/clubClock";
import { ArrowRight } from "../ui/icons";
import { cn, formatSignedCredits } from "@/lib/utils";
import { COMPACT_ONLY, STACKED_ONLY } from "./ledgerColumns";

/** The club's day and clock, under the comment in the compact form, where the Time column folds away. */
export function PhoneTime({ at }: { at: string }) {
  return <time dateTime={at} className={`mt-0.5 block text-xs tabular-nums text-text-muted ${COMPACT_ONLY}`}>{clubDayAndClock(at)}</time>;
}

/** The "→ name" of the To column. */
export function ToName({ name }: { name: string }) {
  return (
    <span className="inline-flex max-w-44 items-center gap-1.5" title={name}>
      <ArrowRight size={14} weight="bold" aria-hidden="true" className="shrink-0 text-text-muted" />
      <span className="truncate">{name}</span>
    </span>
  );
}

/**
 * The amount inside the movement's cell, in the one-column form only (a phone at 200 % text):
 * the figure in its column's ink, never broken, and what it moved to or from under it.
 */
export function StackedAmount({ signed, ink, under }: { signed: number; ink: string; under: string }) {
  return (
    <span data-stacked-amount="" className={cn("mt-1 block", STACKED_ONLY)}>
      <span className={cn("block whitespace-nowrap font-semibold tabular-nums", ink)}>{formatSignedCredits(signed)}</span>
      <span className="block break-words text-xs text-text-muted">{under}</span>
    </span>
  );
}
