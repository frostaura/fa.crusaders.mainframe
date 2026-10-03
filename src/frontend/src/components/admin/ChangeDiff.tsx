import { presentChanges } from "@/lib/changeRecordCopy";
import { cn } from "@/lib/utils";
import type { AdminChangeRow } from "@/lib/adminApi";

/**
 * One change-record row's "what changed", in words (review round 2, F3-7) — shared by the club's
 * change record and a repeating booking's own history, which printed the stored keys.
 *
 * <p>
 * Two parts, because they are two different things: what moved from one value to another
 * (before → after), and the facts the action carried (the amount collected, the seat, the court).
 * A fact used to sit in the Before column with an em dash after it, reading as something removed.
 * </p>
 *
 * <p>
 * <b>R10 L10-2: the columns are decided by the diff's own BOX, in rem.</b> At 320 / 390 with 200 %
 * text a fixed `auto 1fr 1fr` gave the label column its longest word and left the values 0–4px —
 * one letter a line, "Cou/rt/num/bers", the After header past the box. Under a 24rem box (the
 * three columns' reading width at any text size) each line stacks: the label, then "Before …" and
 * "After …" under it, each value saying which side it is. The words "Before"/"After" are on every
 * value for a screen reader at every width (sr-only when the header row says it to the eye), and
 * the header row is the eye's only — so neither reading hears them twice.
 * </p>
 */
export function ChangeDiff({ row }: { row: Pick<AdminChangeRow, "area" | "action" | "changes"> }) {
  const { changed, facts } = presentChanges(row);
  return (
    <div data-change-diff="" className="@container/diff mt-2 flex flex-col gap-3 rounded-lg bg-bg-muted p-3 text-sm">
      {changed.length > 0 ? (
        <dl className="grid grid-cols-1 gap-y-1 @[24rem]/diff:grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)] @[24rem]/diff:gap-x-3">
          <dt aria-hidden="true" className="hidden text-text-muted @[24rem]/diff:block">Field</dt>
          <dd aria-hidden="true" className="hidden text-text-muted @[24rem]/diff:block">Before</dd>
          <dd aria-hidden="true" className="hidden text-text-muted @[24rem]/diff:block">After</dd>
          {changed.map((line, index) => (
            <div key={line.field} className="contents">
              <dt className={cn("break-words font-medium text-text-secondary @[24rem]/diff:font-normal", index > 0 && "mt-2 @[24rem]/diff:mt-0")}>{line.label}</dt>
              {/* An em dash, not an empty cell: a blank reads as "the page did not load it"
                  and a dash reads as "there was nothing there", which is the true one. */}
              <dd className="min-w-0 break-words tabular-nums text-text-primary">
                <SideLabel>Before</SideLabel>{line.before ?? "—"}
              </dd>
              <dd className="min-w-0 break-words tabular-nums text-text-primary">
                <SideLabel>After</SideLabel>{line.after ?? "—"}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {facts.length > 0 ? (
        <dl className="grid grid-cols-1 @[24rem]/diff:grid-cols-[auto_minmax(0,1fr)] @[24rem]/diff:gap-x-3 @[24rem]/diff:gap-y-1">
          {/* pre-line: a batch's bookings are one per line (R5 A5-2). Stacked, the label sits
              over its value with a small gap after each pair. */}
          {facts.map((fact, index) => (
            <div key={fact.field} className="contents">
              <dt className={cn("break-words text-text-secondary", index > 0 && "mt-2 @[24rem]/diff:mt-0")}>{fact.label}</dt>
              <dd className="min-w-0 whitespace-pre-line break-words tabular-nums text-text-primary">{fact.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

/** "Before " / "After " — seen when the line is stacked, read by a screen reader always. */
function SideLabel({ children }: { children: string }) {
  return <span className="text-text-muted @[24rem]/diff:sr-only">{`${children} `}</span>;
}
