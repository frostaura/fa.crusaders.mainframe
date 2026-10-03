import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useBalance } from "@/lib/useBalance";

/**
 * R4 M4-3 — the Bookings page keeps up with what other people do to this member's games.
 *
 * <p>
 * A partner's upcoming list and grid stayed as they were after the organiser cancelled: the page
 * re-read only after its OWN book and cancel. It now re-reads — the day in the background (no
 * skeleton, the day stays on screen) and the games lists — when:
 * </p>
 * <ul>
 *   <li><b>the wallet stream moves</b> (the balance, or the inbox's unread count): a cancellation,
 *   a partner's answer or an invite reaches this member that way. The wallet's first figures are
 *   its load, not a movement, and a move within {@link OWN_WRITE_MS} of this page's own write is
 *   that write's echo — it has re-read already.</li>
 *   <li><b>the page comes back into view</b> and what is on screen is older than {@link STALE_MS}.</li>
 * </ul>
 * The booking page does the same for one booking (`useDetailLiveness`).
 */
export const STALE_MS = 10_000;
export const OWN_WRITE_MS = 3_000;

function subscribeVisibility(listener: () => void): () => void {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}

const isVisible = () => typeof document === "undefined" || document.visibilityState !== "hidden";

/**
 * @param readAt when the shown day was last read (ms), null before the first.
 * @param reread re-reads what the page shows; called at most once per trigger.
 * @returns `wrote()`, to call when this page's own write lands — its echo is not re-read again.
 */
export function useScheduleLiveness(readAt: number | null, reread: () => void) {
  const visible = useSyncExternalStore(subscribeVisibility, isVisible, isVisible);
  const rereadRef = useRef(reread);
  useEffect(() => { rereadRef.current = reread; });
  const readAtRef = useRef(readAt);
  useEffect(() => { readAtRef.current = readAt; }, [readAt]);
  const ownWriteAt = useRef(0);

  // Back into view: read again when what is on screen is not fresh. Only the flip counts — the
  // page's own first read is its mount, not a return.
  const wasVisible = useRef(visible);
  useEffect(() => {
    const returned = visible && !wasVisible.current;
    wasVisible.current = visible;
    if (!returned) return;
    const at = readAtRef.current;
    if (at !== null && Date.now() - at > STALE_MS) rereadRef.current();
  }, [visible]);

  // The wallet stream moved: something about this member changed somewhere else.
  const { balance, unreadCount } = useBalance();
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (balance === null) return;
    const key = `${balance}|${unreadCount ?? ""}`;
    const moved = seen.current !== null && seen.current !== key;
    seen.current = key;
    if (moved && Date.now() - ownWriteAt.current > OWN_WRITE_MS) rereadRef.current();
  }, [balance, unreadCount]);

  const wrote = useCallback(() => { ownWriteAt.current = Date.now(); }, []);
  return { wrote };
}
