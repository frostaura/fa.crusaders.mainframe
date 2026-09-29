import { clubDayAndClock } from "@/lib/clubClock";
import { ArrowRight } from "../ui/icons";

/** The club's day and clock, under the comment on a phone where the Time column folds away. */
export function PhoneTime({ at }: { at: string }) {
  return <time dateTime={at} className="mt-0.5 block text-xs tabular-nums text-text-muted sm:hidden">{clubDayAndClock(at)}</time>;
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
