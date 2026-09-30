import { createContext, useContext, type ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * Table parts (shadcn, restyled). The table sits in its own horizontal scroller so a wide admin
 * table never widens the page at 360px.
 *
 * <p>
 * <b>Sticky header.</b> `stickyHeader` pins every `TableHead` to the top of the SCROLLER — a
 * scroller is the nearest scrolling ancestor, so the header sticks to it, never to the page.
 * Give the scroller a height through `containerClassName` (e.g. `max-h-96`) for it to matter.
 * </p>
 */
const TableContext = createContext({ stickyHeader: false });

type TableProps = ComponentProps<"table"> & {
  stickyHeader?: boolean;
  /** Classes for the scrolling wrapper (a max height for a sticky header, a border, a radius). */
  containerClassName?: string;
  /**
   * The table's name. Given one, the scroller becomes a named, focusable region (review round 1,
   * F3.21 — axe `scrollable-region-focusable`): a table wider than a phone is scrolled sideways,
   * and a scroller the keyboard cannot reach leaves its right-hand columns unreachable. The table
   * carries the same name, so it is no longer an unnamed data table either.
   */
  label?: string;
};

export function Table({ className, stickyHeader = false, containerClassName, label, ...props }: TableProps) {
  return (
    <TableContext.Provider value={{ stickyHeader }}>
      <div
        data-slot="table-container"
        {...(label ? { role: "region", "aria-label": label, tabIndex: 0 } : {})}
        className={cn(
          "relative w-full overflow-x-auto", stickyHeader && "overflow-y-auto",
          label && "rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-strong",
          containerClassName,
        )}
      >
        <table
          data-slot="table"
          aria-label={label}
          className={cn("w-full caption-bottom border-collapse text-sm", className)}
          {...props}
        />
      </div>
    </TableContext.Provider>
  );
}

export function TableHeader({ className, ...props }: ComponentProps<"thead">) {
  return <thead data-slot="table-header" className={cn("[&_tr]:border-b [&_tr]:border-border", className)} {...props} />;
}

export function TableBody({ className, ...props }: ComponentProps<"tbody">) {
  return <tbody data-slot="table-body" className={cn("[&_tr:last-child]:border-0", className)} {...props} />;
}

export function TableRow({ className, ...props }: ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b border-border transition-colors duration-fast ease-standard motion-reduce:transition-none",
        "hover:bg-bg-muted/50 data-[state=selected]:bg-accent-soft",
        className,
      )}
      {...props}
    />
  );
}

export function TableHead({ className, ...props }: ComponentProps<"th">) {
  const { stickyHeader } = useContext(TableContext);
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-11 whitespace-nowrap bg-bg-muted px-3 text-left align-middle text-xs font-semibold uppercase tracking-overline text-text-secondary",
        "[&:has([role=checkbox])]:pr-0",
        stickyHeader && "sticky top-0 z-sticky",
        className,
      )}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }: ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn("px-3 py-2.5 align-middle text-text-primary [&:has([role=checkbox])]:pr-0", className)}
      {...props}
    />
  );
}

export function TableCaption({ className, ...props }: ComponentProps<"caption">) {
  return <caption data-slot="table-caption" className={cn("mt-3 text-sm text-text-secondary", className)} {...props} />;
}
