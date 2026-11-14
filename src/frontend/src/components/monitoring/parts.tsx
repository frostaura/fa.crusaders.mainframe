import { useState, type ReactNode } from "react";
import { cn } from "../../lib/utils";
import { describeFailure } from "../../lib/errors";
import { fetchCsv, saveFile } from "../../lib/memberDetailApi";
import { useToast } from "../toastContext";
import { FILTER_BAR_INSET, FILTER_TRIGGER_INSET } from "../ui/layout";
import { keepFiguresWhole } from "../ui/figure-text";
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
 * "Download CSV" — fetched WITH the session's bearer token, then handed to the browser's save
 * (FA-1).
 *
 * <p>
 * <b>Never a bare link.</b> This was an `<a href>` styled as a button, and a link navigation
 * carries no Authorization header: the API cannot resolve a tenant and answers
 * `400 tenant_unresolved` as JSON, so the download cancels itself and the page looks the same
 * before and after. That defect shipped on the wallet CSV, the door log and the night before it
 * shipped here on Faults and the change record; `csv-links.test.ts` now fails on any `href` to an
 * `/api/` path in the source. A failure is said twice: in a toast, and beside the button.
 * </p>
 */
export function DownloadCsvButton({ path, fallbackName, label = "Download CSV", className }: {
  /** The CSV's API path with its query: the same filters as the list on screen. */
  path: string;
  fallbackName: string;
  label?: string;
  className?: string;
}) {
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  async function download() {
    if (pending) return;
    setPending(true);
    setFailed(null);
    try {
      saveFile(await fetchCsv(path, fallbackName));
    } catch (e) {
      const said = `${describeFailure(e, { action: "download the CSV" })} Nothing was downloaded.`;
      setFailed(said);
      toast.push({ tone: "danger", text: said, durationMs: 8000 });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className={cn("flex max-w-full flex-col gap-1", className)}>
      {/* R5 X5-11: at 320px with 200 % text a nowrap label is wider than the bar; it may wrap. */}
      <Button variant="outline" className="max-w-full whitespace-normal" pending={pending} onClick={() => void download()}>
        <DownloadSimple size={16} aria-hidden="true" />
        {label}
      </Button>
      {failed && <p role="alert" className="text-sm text-danger-strong">{failed}</p>}
    </div>
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
        "flex flex-wrap items-end gap-3 rounded-xl border border-border bg-bg-surface shadow-xs",
        FILTER_BAR_INSET,
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

/** A filter's floor, capped at its bar: an inline style, because the vocabulary keeps arbitrary spacing in `ui/`. */
const FILTER_FLOOR = { minWidth: "min(10rem, 100%)" } as const;

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
    // R5 X5-11: `min-w-40` is 10rem — 320px at 200 % text, the whole of a 320 phone, and the page
    // scrolled 65px sideways. The floor is capped at the bar's own width.
    <Field controlId={id} className={cn("flex-[1_1_10rem] sm:flex-none", className)} style={FILTER_FLOOR}>
      <FieldLabel>{label}</FieldLabel>
      <Select value={value === "" ? ANY : value} onValueChange={(next) => onChange(next === ANY ? "" : next)}>
        {/* R7 L7-10: the value WRAPS at its spaces rather than clamp to one line — at 320 / 200 %
            a filter's box held 108px and showed "Every b…", "Still op…". A word stays whole. */}
        <SelectTrigger className={cn("w-full whitespace-normal sm:w-auto sm:min-w-44 [&_[data-slot=select-value]]:line-clamp-none", FILTER_TRIGGER_INSET)}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            // R11: the figure is glued to its unit in the PAINTED text (Radix copies the item text
            // into the trigger), so a wrapping value reads "Last / 7 days", never "Last 7 / days".
            // Radix names an option by its text (aria-labelledby beats aria-label), so the plain
            // label rides beside the paint as the name; typeahead reads `textValue`.
            <SelectItem key={option.value || ANY} value={option.value === "" ? ANY : option.value} textValue={option.label}>
              <span aria-hidden="true">{keepFiguresWhole(option.label)}</span>
              <span className="sr-only">{option.label}</span>
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
    // `minmax(0,1fr)`, not the implicit `auto` track: that one is floored at a tile's widest
    // skeleton, and ran a 320 / 200 % phone 2px sideways while the board loaded (R16 L16-3).
    <div className={cn("grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2 xl:grid-cols-3", className)}>
      {Array.from({ length: tiles }, (_, i) => (
        <div key={i} className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-bg-surface p-4">
          <Skeleton className="h-5 w-28 max-w-full" />
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
