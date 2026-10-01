import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { DatePicker } from "../ui/date-picker";
import { IconButton } from "../ui/icon-button";
import { Field, FieldLabel } from "../ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Skeleton } from "../ui/skeleton";
import { DownloadSimple, X } from "../ui/icons";

/**
 * The pieces every Courts & hardware page (and the admin read screens beside them) is built
 * from, so that the control board, faults, the change record, the door log and the ledger stop
 * each answering "what does a filter row / an export / a loading list look like" differently.
 * That drift was the defect R11 names: eight screens, eight header shapes, four CSV buttons.
 */

/**
 * "Download CSV" — a file is fetched by a URL, so this is an ANCHOR, never a button with an
 * `onClick` that assigns `location`. It looks like an outline button because it is the one
 * standalone call to action in a filter row; that is the `<Button asChild><a/></Button>` idiom
 * the design system reserves for navigation CTAs, and a download is a GET like any other link.
 */
export function DownloadCsvLink({ href, label = "Download CSV", className }: {
  href: string;
  label?: string;
  className?: string;
}) {
  return (
    // R5 X5-11: nowrap ran "Download CSV" 65px past a 320px phone at 200 % text; it may wrap.
    <Button asChild variant="outline" className={cn("max-w-full whitespace-normal", className)}>
      <a href={href}>
        <DownloadSimple size={16} aria-hidden="true" />
        {label}
      </a>
    </Button>
  );
}

/**
 * A row of filters over a list. A labelled `group` so a screen reader hears "Filters" before
 * the first control, wrapping at 360px, bottom-aligned so the export lines up with the controls
 * rather than with their labels.
 */
export function FilterBar({ label = "Filters", children, className, id }: {
  label?: string;
  children: ReactNode;
  className?: string;
  /** For a toggle that `aria-controls` it (the Transactions filters on a phone). */
  id?: string;
}) {
  return (
    <div
      id={id}
      role="group"
      aria-label={label}
      className={cn(
        "flex flex-wrap items-end gap-3 rounded-xl border border-border bg-bg-surface p-4 shadow-xs",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * Radix Select reserves the empty string (it means "no value, show the placeholder"), and every
 * filter here uses "" for "anything". So "" is carried across the boundary as this sentinel and
 * turned back on the way out — the call site keeps its "" and never learns the difference.
 */
const ANY = "__any__";

export type FilterOption = { value: string; label: string };

/** One labelled filter: the design-system Select, never a native `<select>`. */
export function FilterSelect({ id, label, value, options, onChange, className }: {
  id: string;
  label: string;
  value: string;
  options: ReadonlyArray<FilterOption>;
  onChange: (next: string) => void;
  className?: string;
}) {
  return (
    <Field controlId={id} className={cn("min-w-40 flex-[1_1_10rem] sm:flex-none", className)}>
      <FieldLabel>{label}</FieldLabel>
      <Select value={value === "" ? ANY : value} onValueChange={(next) => onChange(next === ANY ? "" : next)}>
        <SelectTrigger className="w-full sm:w-auto sm:min-w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value || ANY} value={option.value === "" ? ANY : option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

/**
 * One labelled date filter: the club-day DatePicker (P3, R7 — never a native date input), with a
 * clear × beside it, because an empty bound is a real state — "unbounded" — and a calendar alone
 * cannot express it.
 */
export function FilterDate({ label, value, onChange, className }: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={cn("flex flex-col gap-1.5", className)}>
      <span aria-hidden="true" className="text-sm font-medium text-text-primary">{label}</span>
      <span className="flex items-center gap-1">
        <DatePicker label={label} value={value || null} onChange={onChange} placeholder="Any date" />
        {value ? (
          <IconButton label={`Clear ${label}`} size="icon-sm" onClick={() => onChange("")}>
            <X aria-hidden="true" />
          </IconButton>
        ) : null}
      </span>
    </div>
  );
}

/**
 * A list of cards, loading: the same rhythm as the rows it stands in for, so nothing jumps when
 * they land. Never the word "Loading…" on its own (design-system.md, Async actions).
 */
export function CardListSkeleton({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex flex-col gap-3 rounded-xl border border-border bg-bg-surface p-4">
          <div className="flex items-center gap-3">
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-5 flex-1" />
          </div>
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ))}
    </div>
  );
}

/** A grid of tiles, loading — the control board's and the doors overview's shape. */
export function TileGridSkeleton({ tiles = 3, className }: { tiles?: number; className?: string }) {
  return (
    <div className={cn("grid gap-4 sm:grid-cols-2 xl:grid-cols-3", className)}>
      {Array.from({ length: tiles }, (_, i) => (
        <div key={i} className="flex flex-col gap-3 rounded-xl border border-border bg-bg-surface p-4">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ))}
    </div>
  );
}

/** A table, loading: a header bar and rows of the height the real rows will be. */
export function TableSkeleton({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-2 rounded-xl border border-border bg-bg-surface p-4", className)}>
      <Skeleton className="h-6 w-full" />
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-12 w-full" />)}
    </div>
  );
}
