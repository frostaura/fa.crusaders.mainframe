import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useAuth } from "@/lib/auth";
import { useBalance } from "@/lib/balance";
import { playersEndpoints } from "@/lib/playersApi";

/**
 * The member inbox's unread count (P11, D11) — ONE module-level store the bell in the top bar
 * and the `/inbox` page share, so the two can never show different numbers.
 *
 * <p>
 * <b>Sources, in order of truth.</b>
 * </p>
 * <ol>
 *   <li>The wallet stream's named <code>notification</code> frame, already parsed into
 *   `useBalance().unreadCount`. Taken whenever it changes, and a frame that lands while a read
 *   is in flight wins over that read's (older) answer.</li>
 *   <li>A <code>GET /me/notifications/unread-count</code> when a session starts, and again when
 *   the tab comes back into view.</li>
 *   <li>A poll every {@link POLL_MS} — <b>only while the stream is not live</b> (loading,
 *   degraded, unavailable) and never while the tab is hidden. A live stream pushes every change,
 *   so polling beside it would be a request a minute that can only ever agree.</li>
 * </ol>
 *
 * <p>
 * <b>A failed read is silent.</b> The bell is a cue, not a screen: a failed read keeps the last
 * figure (or none), shows no error and asks again later. It is also the one read every older
 * shell test never stubbed.
 * </p>
 *
 * <p>
 * Every local change is echoed into `useBalance().noteUnread`, so the stream's last figure
 * tracks this one — otherwise a later frame carrying the SAME number the stream last sent would
 * not be a change, and the bell would miss it.
 * </p>
 */

export const POLL_MS = 60_000;

type Snapshot = { count: number | null };

const EMPTY: Snapshot = { count: null };

let snapshot: Snapshot = EMPTY;
const listeners = new Set<() => void>();
let inFlight: Promise<void> | null = null;
/** Bumped by every authoritative write and every reset, so an older read cannot publish over it. */
let version = 0;

function publish(count: number | null) {
  const next = count === null ? null : Math.max(0, Math.floor(count));
  if (snapshot.count === next) return;
  snapshot = { count: next };
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    // A signed-out tab keeps nothing of the last member's inbox (a shared desk machine).
    if (listeners.size === 0) resetUnread();
  };
}

function getSnapshot(): Snapshot {
  return snapshot;
}

/** Back to "unknown". Exported for tests; the store resets itself when its last reader leaves. */
export function resetUnread() {
  version += 1;
  inFlight = null;
  if (snapshot === EMPTY) return;
  snapshot = EMPTY;
  for (const listener of [...listeners]) listener();
}

/** A figure somebody authoritative just stated — the stream, a page read, an optimistic mark. */
export function setUnread(count: number) {
  version += 1;
  publish(count);
}

/**
 * Ask the server. Deduplicated: a second caller while a read is out shares it. Never rejects —
 * a failure leaves the figure where it was.
 */
export function readUnread(): Promise<void> {
  if (inFlight) return inFlight;
  const asked = version;
  const read = playersEndpoints.unreadCount()
    .then((answer) => {
      if (asked === version && typeof answer?.unread_count === "number") publish(answer.unread_count);
    })
    .catch(() => { /* silent by design — see the module note */ })
    .finally(() => { if (inFlight === read) inFlight = null; });
  inFlight = read;
  return read;
}

export type UnreadCount = {
  /** Null until something has answered. */
  count: number | null;
  /** State a new figure: updates the store AND the stream's last figure. */
  set: (count: number) => void;
  /** Re-ask the server (deduplicated, silent on failure). */
  refresh: () => Promise<void>;
};

/** Read the shared figure. Any number of components may call this. */
export function useUnreadCount(): UnreadCount {
  const { count } = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const { noteUnread } = useBalance();
  const set = useCallback((next: number) => {
    setUnread(next);
    noteUnread(Math.max(0, next));
  }, [noteUnread]);
  return { count, set, refresh: readUnread };
}

/**
 * Keep the shared figure current: the stream frame, the first read, the fallback poll and the
 * return-to-tab read. Mounted ONCE, by the bell in the shell — a second driver would poll twice.
 */
export function useUnreadCountDriver(): void {
  const auth = useAuth();
  const { unreadCount: pushed, state } = useBalance();
  const enabled = auth.status === "authenticated" && !auth.mustChangePassword;
  // D2 — whose inbox. A sign-in moves this without moving `enabled`, and the bell went on
  // showing the previous member's count until something happened to re-read it.
  const identity = auth.status === "authenticated" ? auth.userId : null;
  const live = state === "live";

  // The first read of a session — and of every change of member, forgetting the last one's.
  useEffect(() => {
    if (!enabled) return;
    resetUnread();
    void readUnread();
  }, [enabled, identity]);

  // The stream's figure, whenever it changes. It outranks any read that is still out.
  // Declared AFTER the reset above, so a figure pushed in the same pass is not wiped by it.
  useEffect(() => {
    if (enabled && pushed !== null) setUnread(pushed);
  }, [enabled, pushed]);

  // Back in view: one read, live or not — the stream only pushes CHANGES, not the figure.
  useEffect(() => {
    if (!enabled) return;
    const onVisible = () => { if (document.visibilityState === "visible") void readUnread(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [enabled]);

  // The fallback poll — only while the stream is not live, and never in a hidden tab.
  useEffect(() => {
    if (!enabled || live) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void readUnread();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [enabled, live]);
}
