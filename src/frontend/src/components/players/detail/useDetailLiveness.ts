import { useEffect, useRef, useSyncExternalStore } from "react";
import { useBoundaryRefresh } from "@/components/member-door/useBoundaryRefresh";
import { useBalance } from "@/lib/useBalance";
import type { BookingDetail } from "@/lib/playersApi";

/**
 * R3 M-2 / I-8 — an open booking page keeps up with the court. The reviewer left a booking open
 * across its start: at 17:04 it still said "Nobody has checked in yet" and offered no Record,
 * because the page read once and never again. It now re-reads:
 *
 * - **at the instants it already knows** — the court time's start (a result becomes recordable,
 *   §B15) and its end — through the same boundary timer the member's door uses, which survives a
 *   phone asleep through the boundary;
 * - **when the tab comes back into view** (and the last read is older than {@link STALE_MS});
 * - **when the wallet stream says something moved** — a balance or an inbox change is how a
 *   check-in's settlement or a partner's answer reaches this member;
 * - **every {@link LIVE_POLL_MS} while the game is live and nobody has checked in** — from
 *   {@link LIVE_LEAD_MS} before the start (the box's check-in cue opens before the court time;
 *   its window is a club setting this page does not read) to the end. A check-in moves no money
 *   for this viewer and sends no notice, so nothing else would bring it.
 */
export const LIVE_POLL_MS = 30_000;
export const LIVE_LEAD_MS = 30 * 60_000;
export const STALE_MS = 10_000;

function subscribeVisibility(listener: () => void): () => void {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}

const isVisible = () => typeof document === "undefined" || document.visibilityState !== "hidden";

export function useDetailLiveness(detail: BookingDetail | null, readAt: number | null, reload: () => void) {
  const visible = useSyncExternalStore(subscribeVisibility, isVisible, isVisible);
  const reloadRef = useRef(reload);
  useEffect(() => { reloadRef.current = reload; }, [reload]);
  const readAtRef = useRef(readAt);
  useEffect(() => { readAtRef.current = readAt; }, [readAt]);

  const booked = detail?.status === "booked";
  // Only instants still ahead of the last read: one already behind it is in what is on screen.
  const ahead = booked && readAt !== null ? [detail.starts_at, detail.ends_at].filter((t) => Date.parse(t) > readAt) : [];
  useBoundaryRefresh(ahead, reload);

  // Back into view: read again if what is on screen is not fresh.
  useEffect(() => {
    if (!visible || !detail) return;
    const at = readAtRef.current;
    if (at === null || Date.now() - at > STALE_MS) reloadRef.current();
    // Only the flip to visible matters here, not every new read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // The wallet stream moved (a balance, or the inbox): something about this member changed.
  const { balance, unreadCount } = useBalance();
  const seen = useRef<string | null>(null);
  useEffect(() => {
    // The first figures to arrive are the wallet loading, not a movement: nothing to re-read for.
    if (balance === null) return;
    const key = `${balance}|${unreadCount ?? ""}`;
    const moved = seen.current !== null && seen.current !== key;
    seen.current = key;
    if (moved && detail) reloadRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [balance, unreadCount]);

  // Live and nobody in yet: ask again on a slow poll while somebody is looking.
  const starts = detail ? Date.parse(detail.starts_at) : NaN;
  const ends = detail ? Date.parse(detail.ends_at) : NaN;
  const waiting = booked && !detail?.attendance.checked_in_at;
  useEffect(() => {
    if (!waiting || !visible || Number.isNaN(starts) || Number.isNaN(ends)) return undefined;
    const timer = window.setInterval(() => {
      const now = Date.now();
      if (now >= starts - LIVE_LEAD_MS && now <= ends) reloadRef.current();
    }, LIVE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [waiting, visible, starts, ends]);
}
