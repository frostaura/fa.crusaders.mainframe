import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Racquet } from "@/components/ui/icons";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, formatCredits } from "@/lib/utils";
import { signedCredits } from "@/lib/bookingsCopy";

/**
 * The reading parts BookSheet and CancelSheet share: the stepper, the slot list and the money
 * rows. Nothing here decides anything — every figure arrives as a prop, already the server's.
 */

/* ─────────────────────────────── stepper ─────────────────────────────── */

/**
 * "Step 1 of 2: Slots" — a segmented bar with the step names under it. Hidden entirely for a
 * one-step sheet, where a progress bar at 100% would be decoration pretending to be a state.
 */
export function Stepper({ names, current }: { names: readonly string[]; current: number }) {
  if (names.length < 2) return null;
  return (
    // The header keeps a 56px right gutter for the close ×; the stepper sits under the title, clear
    // of it, so it reaches back out to the body's own right edge rather than stopping short.
    <ol aria-label="Progress" className="-mr-10 mt-2 grid auto-cols-fr grid-flow-col gap-2 sm:-mr-8">
      {names.map((name, i) => (
        <li key={name} aria-current={i === current ? "step" : undefined} className="grid gap-1.5">
          <span
            aria-hidden="true"
            className={cn(
              "h-1 rounded-full transition-colors duration-base ease-standard motion-reduce:transition-none",
              i <= current ? "bg-accent-strong" : "bg-border",
            )}
          />
          <span className={cn("text-xs", i === current ? "font-semibold text-text-primary" : "text-text-muted")}>
            <span className="sr-only">{`Step ${i + 1} of ${names.length}: `}</span>
            {name}
          </span>
        </li>
      ))}
    </ol>
  );
}

/* ─────────────────────────────── the slots ─────────────────────────────── */

export type SlotLine = {
  key: string;
  courtName: string;
  day: string;
  time: string;
  duration: string;
  /** The payer's price; null while it is being read (skeleton) or when not shown at all. */
  price: number | null;
  priceLoading?: boolean;
  /** Set when this slot cannot be booked: the reason, in a sentence. */
  refusal?: string | null;
  /** A short trailing note in place of a price — "No charge". */
  note?: ReactNode;
  /** A line under the time — what cancelling this one moves. */
  detail?: string;
  detailLoading?: boolean;
};

function SlotPrice({ line }: { line: SlotLine }) {
  if (line.priceLoading) return <Skeleton className="h-4 w-16 rounded-sm" />;
  if (line.note) return <span className="text-sm text-text-secondary">{line.note}</span>;
  if (line.price === null) return null;
  return (
    <span className={cn("text-sm font-semibold tabular-nums", line.refusal ? "text-text-muted line-through" : "text-text-primary")}>
      {formatCredits(line.price)}
    </span>
  );
}

function SlotItem({ line, refusedWord }: { line: SlotLine; refusedWord: string }) {
  return (
    <li className="flex items-start gap-3 p-3">
      <span
        aria-hidden="true"
        className={cn(
          "flex size-10 shrink-0 items-center justify-center rounded-lg",
          line.refusal ? "bg-bg-muted text-text-muted" : "bg-accent-soft text-accent-strong",
        )}
      >
        <Racquet size={20} />
      </span>
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="flex items-baseline justify-between gap-3">
          <span className="truncate text-sm font-semibold text-text-primary">{line.courtName}</span>
          <SlotPrice line={line} />
        </span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text-secondary">
          <span>{`${line.day} · ${line.time}`}</span>
          <Badge tone="neutral">{line.duration}</Badge>
        </span>
        {line.detailLoading ? <Skeleton className="mt-1 h-4 w-40 rounded-sm" /> : null}
        {!line.detailLoading && line.detail ? <span className="text-sm text-text-secondary">{line.detail}</span> : null}
        {line.refusal ? (
          <span className="flex flex-wrap items-center gap-2 pt-1 text-sm text-warning-strong">
            <Badge tone="warning">{refusedWord}</Badge>
            <span>{line.refusal}</span>
          </span>
        ) : null}
      </span>
    </li>
  );
}

/** The selected slots, one card, a row each. A list, so a screen reader hears the count. */
export function SlotList({ lines, label, refusedWord }: { lines: readonly SlotLine[]; label: string; refusedWord: string }) {
  return (
    <ul
      aria-label={label}
      className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-bg-surface"
    >
      {lines.map((line) => <SlotItem key={line.key} line={line} refusedWord={refusedWord} />)}
    </ul>
  );
}

/* ─────────────────────────────── the money ─────────────────────────────── */

export type MoneyRow = {
  term: string;
  /** Credits. Negative reads in the danger ink with a real minus. Null = still reading. */
  value: number | null;
  /** The row the eye should land on: bigger, bolder, a rule above it. */
  total?: boolean;
  /** Show as a debit ("−15.00 cr") even though the figure is positive. */
  debit?: boolean;
  /** Replace the figure with words ("No charge"). */
  text?: string;
};

function MoneyValue({ row }: { row: MoneyRow }) {
  if (row.text) return <>{row.text}</>;
  if (row.value === null) return <Skeleton className="ml-auto h-4 w-20 rounded-sm" />;
  const shown = row.debit ? -Math.abs(row.value) : row.value;
  return <>{signedCredits(shown)}</>;
}

/** The figures, right-aligned and tabular so they line up down the column. */
export function MoneyRows({ rows, label }: { rows: readonly MoneyRow[]; label: string }) {
  return (
    <dl aria-label={label} className="grid gap-2 rounded-xl bg-bg-muted p-4 text-sm">
      {rows.map((row, index) => {
        const negative = row.value !== null && row.value < 0 && !row.debit;
        return (
          <div
            key={row.term}
            className={cn("flex items-baseline justify-between gap-4", row.total && index > 0 && "border-t border-border pt-2")}
          >
            <dt className={row.total ? "font-semibold text-text-primary" : "text-text-secondary"}>{row.term}</dt>
            <dd
              className={cn(
                "text-right tabular-nums",
                row.total ? "text-base font-semibold" : "font-medium",
                negative ? "text-danger-strong" : "text-text-primary",
              )}
            >
              <MoneyValue row={row} />
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
