import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Racquet } from "@/components/ui/icons";
import { Skeleton } from "@/components/ui/skeleton";
import { KeptMinutes } from "@/components/members/KeptMinutes";
import { cn } from "@/lib/utils";

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
    // Only the header's FIRST row clears the close × (R8 L8-5), so the stepper already runs the
    // header's full width. R9 L9-2: the old negative right margin, from when every header row kept
    // a 56px gutter for the ×, ran the bar 40px past the dialog's gutter.
    <ol aria-label="Progress" className="mt-2 grid auto-cols-fr grid-flow-col gap-2">
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
  /** How long the slot is, in whole minutes — a figure with its spoken twin (R7 X7-6). */
  minutes: number;
  /** What it costs, in whole minutes; null while it is being read (skeleton) or when not shown at all. */
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
      <KeptMinutes value={line.price} />
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
      {/* R16 L16-4 — a shrinkable track: an implicit `auto` one is as wide as the longest word, and
          `break-words` does not shorten that, so "Court 2 · Wolfeschlegelsteinhausenberger" ran 14px out at 320 / 200 %. */}
      <span className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)] gap-0.5">
        {/* R7 L7-4 — the court's name wraps whole (it was cut "Cou…" at 390/200 %), and the figure
            drops under it, right-aligned, where the two do not fit on one line. */}
        <span className="flex flex-wrap items-baseline justify-between gap-x-3">
          <span className="min-w-0 break-words text-sm font-semibold text-text-primary">{line.courtName}</span>
          <span className="ml-auto whitespace-nowrap"><SlotPrice line={line} /></span>
        </span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text-secondary">
          <span>{`${line.day} · ${line.time}`}</span>
          <Badge tone="neutral"><KeptMinutes value={line.minutes} /></Badge>
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

/**
 * D3 — what is being booked, one compact line a slot, at the top of the steps that are not
 * already the slot list (Players, Split). The sheet's subtitle says "Check the slots and the
 * minutes they take", and on those steps there was neither until Confirm. At most `SUMMARY_ROWS` rows, then
 * "and N more", so a twelve-slot run does not push the step off the screen.
 */
const SUMMARY_ROWS = 3;

export function SlotSummary({ lines, label, more }: { lines: readonly SlotLine[]; label: string; more: (n: number) => string }) {
  const shown = lines.slice(0, SUMMARY_ROWS);
  const rest = lines.length - shown.length;
  return (
    <ul aria-label={label} data-slot-summary="" className="grid grid-cols-[minmax(0,1fr)] gap-1 rounded-xl border border-border bg-bg-surface px-3 py-2 text-sm">
      {shown.map((line) => (
        <li key={line.key} className="flex items-baseline justify-between gap-3">
          <span className="min-w-0 break-words">
            <span className="font-semibold text-text-primary">{line.courtName}</span>
            <span className="text-text-secondary">{` · ${line.day} · ${line.time}`}</span>
          </span>
          <SlotPrice line={line} />
        </li>
      ))}
      {rest > 0 ? <li className="text-text-secondary">{more(rest)}</li> : null}
    </ul>
  );
}

/* ─────────────────────────────── the money ─────────────────────────────── */

export type MoneyRow = {
  term: string;
  /** Whole minutes. Negative reads in the danger ink with a real minus. Null = still reading. */
  value: number | null;
  /** The row the eye should land on: bigger, bolder, a rule above it. */
  total?: boolean;
  /** Show as a debit ("−15 min") even though the figure is positive. */
  debit?: boolean;
  /** Replace the figure with words ("No charge"). */
  text?: string;
};

function MoneyValue({ row }: { row: MoneyRow }) {
  if (row.text) return <>{row.text}</>;
  if (row.value === null) return <Skeleton className="ml-auto h-4 w-20 rounded-sm" />;
  const shown = row.debit ? -Math.abs(row.value) : row.value;
  // A debit is a debit by its row, not a debt: it keeps the row's ink (the dd's), not the red.
  // R8 L7-4 — each number bound to its unit: at 200 % text "Balance after" broke "8 h 45 | min".
  return <KeptMinutes value={shown} className={row.debit ? "text-inherit" : undefined} />;
}

/** The figures, right-aligned and tabular so they line up down the column. */
export function MoneyRows({ rows, label }: { rows: readonly MoneyRow[]; label: string }) {
  return (
    <dl aria-label={label} className="grid grid-cols-[minmax(0,1fr)] gap-2 rounded-xl bg-bg-muted p-4 text-sm">
      {rows.map((row, index) => {
        const negative = row.value !== null && row.value < 0 && !row.debit;
        return (
          <div
            key={row.term}
            // R8 L7-4 — the figure drops under its term, right-aligned, when the two do not fit one line.
            className={cn("flex flex-wrap items-baseline justify-between gap-x-4", row.total && index > 0 && "border-t border-border pt-2")}
          >
            <dt className={cn("min-w-0 break-words", row.total ? "font-semibold text-text-primary" : "text-text-secondary")}>{row.term}</dt>
            <dd
              className={cn(
                "ml-auto min-w-0 text-right tabular-nums",
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

/**
 * R4 I4-1 — the sheet's waiting line while the club answers, in the footer IN PLACE of the way
 * out (Back, Cancel, Keep, Done): no way out is offered while money is on its way, and the line
 * says why. A polite live region, re-keyed on every refused close, so a screen reader hears it
 * again when the ×, Escape or the system Back is tried. Also carries the Book sheet's "check,
 * then tap Book" after an ignored double tap (I4-2). Null text: an empty region, kept mounted so
 * its first words are announced.
 */
export function SendingNote({ text, refused }: { text: string | null; refused: number }) {
  return (
    <p data-sending-note="" aria-live="polite" className={text ? "text-sm text-text-secondary sm:mr-auto sm:self-center" : "sr-only"}>
      {text ? <span key={refused}>{text}</span> : null}
    </p>
  );
}
