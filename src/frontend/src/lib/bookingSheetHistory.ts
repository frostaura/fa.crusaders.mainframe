import { useEffect, useRef } from "react";
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
 * @param tag names this sheet's entry, so two sheets on one page never take each other's.
 */
export function useSheetHistory(open: boolean, close: () => void, tag: string) {
  const location = useLocation();
  const navigate = useNavigate();
  const marked = (location.state as { sheet?: string } | null)?.sheet === tag;
  const pushed = useRef(false);
  const seen = useRef(false);
  const latestClose = useRef(close);
  useEffect(() => { latestClose.current = close; });

  useEffect(() => {
    if (marked) seen.current = true;
    if (open && !pushed.current) {
      pushed.current = true;
      seen.current = marked;
      if (!marked) {
        navigate(`${location.pathname}${location.search}`, { state: { ...(location.state as object | null), sheet: tag } });
      }
      return;
    }
    if (open && pushed.current && seen.current && !marked) {
      // Back (or anything else) took the sheet's entry away: the sheet goes with it.
      pushed.current = false;
      seen.current = false;
      latestClose.current();
      return;
    }
    if (!open && pushed.current) {
      // Closed from inside: take our entry back off, so Back next leaves the page as it would have.
      pushed.current = false;
      seen.current = false;
      if (marked) navigate(-1);
    }
  }, [open, marked, navigate, location.pathname, location.search, location.state, tag]);
}
