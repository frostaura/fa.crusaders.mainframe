import { useEffect, useRef } from "react";

/**
 * Focus for an editor that opens IN the page, not in a dialog (R8 X8-3).
 *
 * <p>
 * Boards' "Edit name and courts" / "Edit buttons", the Packages rail and the Repeating bookings
 * editor opened their form without taking focus (Tab skipped it, or reached it six controls later)
 * and, on Cancel or Save, unmounted the control holding focus — so focus fell to <code>&lt;body&gt;</code>.
 * A dialog does both for free; an inline editor has to be told.
 * </p>
 *
 * <p>
 * <code>open</code> is what is being edited (any value), or null when nothing is. Opening puts focus
 * on the first field inside <code>region</code>; closing puts it on the control that opened it,
 * found by <code>opener(previous)</code> AFTER the re-render — the opener is often a different
 * element by then (it was unmounted while the editor was up).
 * </p>
 */
export function useInlineEditorFocus<T>(
  open: T | null,
  opener: (previous: T) => HTMLElement | null | undefined,
) {
  const region = useRef<HTMLDivElement>(null);
  const previous = useRef<T | null>(open);
  const openerRef = useRef(opener);
  // Declared first, so it has run by the time the effect below reads it.
  useEffect(() => { openerRef.current = opener; });
  useEffect(() => {
    const was = previous.current;
    previous.current = open;
    if (open === was) return;
    if (open !== null) {
      // An editor that already put focus inside itself (its own heading) is left to it.
      if (!region.current?.contains(document.activeElement)) firstField(region.current)?.focus();
      return;
    }
    if (was === null) return;
    // Only when focus has nowhere better to be: a save that moved it on purpose is left alone.
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    openerRef.current(was)?.focus();
  }, [open]);
  return region;
}

const FIELD = "input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [role=combobox], button:not([disabled])";

function firstField(root: HTMLElement | null): HTMLElement | null {
  return root?.querySelector<HTMLElement>(FIELD) ?? null;
}
