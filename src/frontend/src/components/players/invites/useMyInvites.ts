import { useCallback, useEffect, useRef, useState } from "react";
import { playersEndpoints, type Invite } from "@/lib/playersApi";

/**
 * The member's open invites — `GET /me/invites` — for the Invites page and its badge.
 *
 * <p>
 * <b>Three states, not two.</b> `items` is null until a read has answered: a list initialised to
 * `[]` would draw "No invites waiting" over a read that failed. A failed RE-read keeps the last
 * good list (and says so in `error`), because what the club last said is still the best cue.
 * </p>
 *
 * <p>
 * <b>Re-read on focus.</b> An invite arrives by mail or WhatsApp while the app sits in another
 * tab, so a return to the window (focus, or the page becoming visible) reads again. Self-contained
 * — no provider — so the Bookings badge, this page and later the bell can each call it.
 * </p>
 */
export type MyInvites = {
  items: Invite[] | null;
  count: number;
  loading: boolean;
  error: unknown;
  /** When the last good read answered (ms), or null. */
  readAt: number | null;
  /** Read again. Resolves with the fresh list, or null when the read failed. Never rejects. */
  refresh: () => Promise<Invite[] | null>;
};

export function useMyInvites(options: { enabled?: boolean } = {}): MyInvites {
  const { enabled = true } = options;
  const [items, setItems] = useState<Invite[] | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<unknown>(null);
  const [readAt, setReadAt] = useState<number | null>(null);
  const mounted = useRef(false);
  const seq = useRef(0);

  /** One answer onto the state: a list replaces the last, a failure keeps it and says so. */
  const settle = useCallback((list: Invite[] | null, failure: unknown) => {
    if (list) {
      setItems(list);
      setReadAt(Date.now());
    }
    setError(list ? null : failure);
    setLoading(false);
  }, []);

  /** The read itself. Sets no state before its first await, so an effect may start it. */
  const read = useCallback(async (): Promise<Invite[] | null> => {
    const mine = ++seq.current;
    let list: Invite[] | null = null;
    let failure: unknown = null;
    try {
      const answer = await playersEndpoints.myInvites();
      list = Array.isArray(answer?.items) ? answer.items : [];
    } catch (thrown) {
      failure = thrown;
    }
    if (mounted.current && mine === seq.current) settle(list, failure);
    return list;
  }, [settle]);

  const refresh = useCallback(() => {
    setLoading(true);
    return read();
  }, [read]);

  useEffect(() => {
    // Set on mount as well as cleared on unmount — StrictMode runs mount → cleanup → mount.
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    void read();
    const onFocus = () => { void refresh(); };
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, read, refresh]);

  return { items, count: items?.length ?? 0, loading, error, readAt, refresh };
}
