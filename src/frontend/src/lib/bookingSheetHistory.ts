import { useEffect, useReducer, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";

/**
 * Back closes an open sheet (review round 1, F1.19).
 *
 * <p>
 * On a phone a bottom sheet looks like a screen, and the system Back gesture is how a person
 * leaves a screen — so Back with the Book sheet open took them off Bookings altogether, and the
 * choices they had made went with it. Opening a sheet now pushes one history entry for the same
 * address, marked with the sheet's tag; Back pops it and the sheet closes. Closing the sheet any
 * other way (×, Cancel, Done) takes that entry back off, so the history is what it would have
 * been without the sheet and a second Back leaves as before.
 * </p>
 *
 * <p>
 * Through the router, never `window.history` directly: the router keeps its own index in each
 * entry, and an entry it did not write is one it cannot navigate back across.
 * </p>
 *
 * <p>
 * <b>A sheet may refuse</b> (R4 I4-1): `close` returning `false` — a money write still on its way —
 * keeps the sheet open, and its entry is put straight back so the next Back is asked again.
 * </p>
 *
 * @param tag names this sheet's entry, so two sheets on one page never take each other's.
 */
export function useSheetHistory(open: boolean, close: () => boolean | void, tag: string) {
  const location = useLocation();
  const navigate = useNavigate();
  const marked = (location.state as { sheet?: string } | null)?.sheet === tag;
  const pushed = useRef(false);
  const seen = useRef(false);
  const latestClose = useRef(close);
  useEffect(() => { latestClose.current = close; });
  // Back can land before React has drawn the sheet's own entry (a slow phone, a quick thumb): the
  // router then renders straight from the entry under the sheet to... the entry under the sheet,
  // nothing this effect watches changes, and the sheet stayed open (CI, F1.19). A popstate while
  // our entry is pushed says it was taken off whether or not a render ever showed it.
  const popped = useRef(false);
  const [popTick, bumpPop] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!open) return undefined;
    const onPop = () => {
      if (!pushed.current) return;
      popped.current = true;
      bumpPop();
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [open]);

  useEffect(() => {
    if (marked) seen.current = true;
    if (open && !pushed.current) {
      pushed.current = true;
      seen.current = marked;
      popped.current = false;
      if (!marked) {
        navigate(`${location.pathname}${location.search}`, { state: { ...(location.state as object | null), sheet: tag } });
      }
      return;
    }
    if (open && pushed.current && (seen.current || popped.current) && !marked) {
      popped.current = false;
      // Back (or anything else) took the sheet's entry away: the sheet goes with it — unless it
      // refuses, and then the entry goes back on.
      if (latestClose.current() === false) {
        navigate(`${location.pathname}${location.search}`, { state: { ...(location.state as object | null), sheet: tag } });
        return;
      }
      pushed.current = false;
      seen.current = false;
      return;
    }
    if (!open && pushed.current) {
      // Closed from inside: take our entry back off, so Back next leaves the page as it would have.
      pushed.current = false;
      seen.current = false;
      popped.current = false;
      if (marked) navigate(-1);
    }
  }, [open, marked, navigate, location.pathname, location.search, location.state, tag, popTick]);
}
