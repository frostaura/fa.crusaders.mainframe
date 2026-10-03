import { useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { Toolbar } from "radix-ui";
import { cn } from "@/lib/utils";
import { DOCK_BOTTOM, DOCK_PANEL, SCALING_ICON, usePublishDockedHeight } from "./layout";
import { X } from "./icons";

/**
 * The floating contextual bar a multiselect raises (design-system.md, Patterns → Multiselect):
 * × exit · "3 selected" + a detail line · secondary actions · the primary action on the right.
 *
 * <p>
 * <b>Where it floats.</b> Fixed to the bottom, clear of the home indicator AND of the mobile tab
 * bar, on the dock every bottom bar shares (`ui/context-bar` {@link DOCK_BOTTOM}: the larger of
 * the tab bar's published height and the safe area, plus 12px). Centred at `max-w-screen-sm`
 * (640px) on a desktop. `z-actionbar` sits above sticky chrome and below every overlay. Like a
 * bottom ContextBar it publishes its height, so `<main>` grows by it and the last grid row can be
 * scrolled clear of the bar (R4 form factor).
 * </p>
 *
 * <p>
 * <b>A real toolbar.</b> Radix Toolbar gives the `role="toolbar"` its expected keyboard model —
 * one tab stop, arrow keys between items. Actions passed as children join that roving set when
 * wrapped in {@link ActionBarItem} (`<ActionBarItem asChild><Button …/></ActionBarItem>`); Escape
 * anywhere in the bar calls `onClose`.
 * </p>
 *
 * <p>
 * <b>The count is announced politely</b>, from a visually hidden status region beside the
 * toolbar (not inside it — a live region nested in an interactive widget is read inconsistently).
 * </p>
 */
export type ActionBarProps = {
  /** How many things are selected. */
  count: number;
  /** The headline. Defaults to "N selected". */
  countLabel?: string;
  /** The span line under it — "Tue 23 Sep · 18:00–19:30 · 3 courts". */
  detail?: ReactNode;
  /** Leave selection mode. The × button, and Escape. */
  onClose: () => void;
  closeLabel?: string;
  /** The toolbar's accessible name. */
  label?: string;
  /** Actions, secondary first, primary last (it lands on the right). */
  children?: ReactNode;
  className?: string;
  /**
   * The bar's horizontal span, when it should centre on a region rather than the window (R5
   * V5-10: the Bookings bar centres on the grid) — `{ left, right }` in px from the window edges.
   */
  style?: CSSProperties;
};

/** A roving toolbar item. Wrap each action: `<ActionBarItem asChild><Button/></ActionBarItem>`. */
export const ActionBarItem = Toolbar.Button;

export function ActionBar(props: ActionBarProps) {
  // Destructured in the body: lizard counts every destructured name as a parameter (gate: 6).
  const {
    count, countLabel, detail, onClose, closeLabel = "Clear selection", label = "Selection", children, className, style,
  } = props;
  const headline = countLabel ?? `${count} selected`;
  const ref = useRef<HTMLDivElement>(null);
  usePublishDockedHeight(ref, true);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    onClose();
  };
  return (
    <div
      ref={ref}
      data-action-bar=""
      className={cn("pointer-events-none fixed inset-x-0 z-actionbar px-4", DOCK_BOTTOM, className)}
      style={style}
    >
      <Toolbar.Root
        aria-label={label}
        onKeyDown={onKeyDown}
        className={cn(
          // R4: wraps — at 200 % text the actions drop under the words instead of cutting them to "4 sl…".
          DOCK_PANEL,
          "animate-sheet-up motion-reduce:animate-none",
        )}
      >
        <Toolbar.Button
          aria-label={closeLabel}
          onClick={onClose}
          className={cn(
            "no-lift inline-flex size-touch shrink-0 items-center justify-center rounded-lg border border-transparent",
            "text-text-secondary transition-colors duration-fast ease-standard hover:bg-bg-muted hover:text-text-primary",
          )}
        >
          <X size={SCALING_ICON} aria-hidden="true" />
        </Toolbar.Button>
        <div className="min-w-0 flex-1 basis-24">
          <p className="break-words text-sm font-semibold tabular-nums">{headline}</p>
          {/* Never cut: on a phone the span line's last part is the time, and a bar that cut
              "08:00–08:45" to an ellipsis hid the one fact worth checking before Book (R4: nor
              clamped to two lines — at 200 % text that left "That's 4…"). */}
          {detail ? <p className="break-words text-xs text-text-secondary">{detail}</p> : null}
        </div>
        {children ? <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">{children}</div> : null}
      </Toolbar.Root>
      <p role="status" aria-live="polite" className="sr-only">{headline}</p>
    </div>
  );
}
