import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useAuth } from "@/lib/auth";
import { useBalance } from "@/lib/balance";
import { playEndpoints, type Celebration } from "@/lib/playApi";

/**
 * The celebrations waiting for this member (§9.3) — read on sign-in, on coming back to the
 * foreground, and on every inbox frame the wallet stream pushes (a badge's notice rides it).
 *
 * <p>
 * <b>A failed read is silent</b>, as the bell's is: a celebration is a moment, not a screen, and
 * the next read brings it. <b>Acknowledged on dismissal only</b> — never on display — so a member
 * whose tab was in the background still gets it. What was dismissed is remembered for the
 * session, so a read racing the acknowledgement cannot put the same moment back up.
 * </p>
 */
export type Celebrations = {
  /** Unseen, oldest first, minus anything already dismissed here. */
  items: Celebration[];
  /** Dismiss these: gone from the queue at once, acknowledged to the server. Never rejects. */
  acknowledge: (ids: string[]) => void;
};

export function useCelebrations(): Celebrations {
  const auth = useAuth();
  const { unreadCount } = useBalance();
  const who = auth.status === "authenticated" ? auth.userId : "";
  const [held, setHeld] = useState<{ who: string; items: Celebration[] }>({ who: "", items: [] });
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const visible = useSyncExternalStore(subscribeVisibility, isVisible, isVisible);

  useEffect(() => {
    if (!who || !visible) return undefined;
    let live = true;
    playEndpoints.celebrations().then(
      (answer) => { if (live) setHeld({ who, items: Array.isArray(answer?.items) ? answer.items : [] }); },
      () => { /* silent by design — see the module note */ },
    );
    return () => { live = false; };
  }, [who, visible, unreadCount]);

  const acknowledge = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    setDismissed((prev) => new Set([...prev, ...ids]));
    setHeld((prev) => ({ ...prev, items: prev.items.filter((c) => !ids.includes(c.id)) }));
    void playEndpoints.celebrationsSeen(ids).catch(() => { /* the next read offers it again */ });
  }, []);

  const items = held.who === who ? held.items.filter((c) => !dismissed.has(c.id)) : [];
  return { items, acknowledge };
}

function subscribeVisibility(listener: () => void): () => void {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}

function isVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}
