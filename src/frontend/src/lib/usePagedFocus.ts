import { useCallback, useLayoutEffect, useRef, useState } from "react";

/**
 * One rule for every paged list's "Show more" / "Load more" (R12 X12-2; R8 X8-4 and R9 X9-2 were
 * the same fault fixed list by list): the reader carries on from the FIRST ROW THE PAGE BROUGHT.
 *
 * <p>
 * <b>Why.</b> The last page takes its button away with it, and focus fell to `<body>` — the next
 * Tab hit the skip link and a screen reader announced nothing. Focus moves only once the new rows
 * are drawn: the hook records how many rows there were when the button was pressed, waits for the
 * page's own state update to commit (its settle tick is queued after it, so the same or a later
 * render carries both), then focuses row `before`.
 * </p>
 *
 * <p>
 * <b>The row it focuses.</b> A row that is already focusable (a link, a button or a `tabindex`) is
 * focused itself; a row whose whole face is one link (the inbox) or one script-focusable box (a
 * Recent alert that opens nowhere, R13 X13-1) gives that child; any other row is
 * made programmatically focusable (`tabindex=-1`) and focused, so a list drawn by a component this
 * page does not own still never drops focus. A page that brought nothing (or failed) leaves focus
 * where it is — unless the button went away regardless, when the last row takes it.
 * </p>
 *
 * @param rows a selector that matches exactly this list's rows, in drawn order.
 * @param run  the page fetch (usually an `AsyncAction.run`); it must append the rows itself.
 * @returns the click handler for the "Show more" button.
 */
export function usePagedFocus(rows: string, run: () => Promise<unknown>): () => void {
  const before = useRef<number | null>(null);
  const [settled, setSettled] = useState(0);

  useLayoutEffect(() => {
    const count = before.current;
    if (count === null) return;
    before.current = null;
    const drawn = document.querySelectorAll<HTMLElement>(rows);
    if (drawn.length > count) {
      focusRow(drawn[count]);
      return;
    }
    const lost = document.activeElement === null || document.activeElement === document.body;
    if (lost && drawn.length > 0) focusRow(drawn[drawn.length - 1]);
  }, [settled, rows]);

  return useCallback(() => {
    before.current = document.querySelectorAll(rows).length;
    void run().finally(() => setSettled((n) => n + 1));
  }, [rows, run]);
}

/** The row itself when it can take focus, else the one link or focusable box that IS the row, else the row made focusable. */
function focusRow(row: HTMLElement) {
  if (row.matches("a[href], button, [tabindex]")) {
    row.focus();
    return;
  }
  const face = row.querySelector<HTMLElement>(":scope > a[href], :scope > [tabindex]");
  if (face) {
    face.focus();
    return;
  }
  row.tabIndex = -1;
  row.focus();
}
