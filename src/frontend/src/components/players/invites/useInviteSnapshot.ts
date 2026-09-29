import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Invite } from "@/lib/playersApi";

/**
 * One invite, read for a page (`/j/:token`, `/invites/:participantId`).
 *
 * <p>
 * <b>Only the FIRST read decides whether the page can open.</b> Afterwards a re-read that fails,
 * or no longer finds the seat, keeps the last invite on screen: an accept that has just gone
 * through takes the seat off the waiting list, and a page that then swapped its confirmation for
 * "no longer waiting" would tell a member their yes had vanished. A re-read that answers replaces
 * the invite — which is how a risen share reaches the figures and the Accept label.
 * </p>
 */
export type InviteSnapshot = {
  invite: Invite | null;
  /** The first read failed (a refusal or a failure). */
  error: unknown;
  /** The first read answered with nothing (the seat is not waiting). */
  gone: boolean;
  loading: boolean;
  reread: () => Promise<void>;
  retry: () => void;
};

export function useInviteSnapshot(read: () => Promise<Invite | null>): InviteSnapshot {
  const [invite, setInvite] = useState<Invite | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [gone, setGone] = useState(false);
  const [loading, setLoading] = useState(true);
  const have = useRef(false);
  const mounted = useRef(false);
  const readRef = useRef(read);
  useLayoutEffect(() => { readRef.current = read; });

  /** The read. Sets no state before its first await, so the mount effect may start it. */
  const load = useCallback(async (first: boolean) => {
    try {
      const found = await readRef.current();
      if (!mounted.current) return;
      if (found) { have.current = true; setInvite(found); } else if (!have.current) setGone(true);
    } catch (failure) {
      if (mounted.current && !have.current) setError(failure);
    } finally {
      if (mounted.current && first) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load(true);
    return () => { mounted.current = false; };
  }, [load]);

  const reread = useCallback(() => load(false), [load]);
  const retry = useCallback(() => {
    setLoading(true);
    setError(null);
    setGone(false);
    void load(true);
  }, [load]);
  return { invite, error, gone, loading, reread, retry };
}
