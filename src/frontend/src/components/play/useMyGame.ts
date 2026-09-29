import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { playEndpoints, type MyPlay } from "@/lib/playApi";

/**
 * The member's "My game" (§6.2), in one read — and kept on screen through a re-read.
 *
 * <p>
 * <b>Keyed by who is signed in</b> (the 2026-09-29 walk: identity, not "signed in or not", keys
 * every per-person read), so an account switch on a shared phone never shows the last member's
 * streak for a moment. <b>Three states, not two</b>: a failed read is `error` with nothing held —
 * never zeros, which would tell a regular they have never played.
 * </p>
 */
export type MyGameRead = {
  data: MyPlay | null;
  error: unknown;
  loading: boolean;
  reload: () => void;
  /** Apply a write's answer at once (the goal, the pause, the switch); a re-read follows. */
  patch: (update: (current: MyPlay) => MyPlay) => void;
};

type Held = { key: string; who: string; data: MyPlay | null; error: unknown };

const EMPTY: Held = { key: "", who: "", data: null, error: null };

export function useMyGame(): MyGameRead {
  const auth = useAuth();
  const who = auth.status === "authenticated" ? auth.userId : "";
  const [nonce, setNonce] = useState(0);
  const [held, setHeld] = useState<Held>(EMPTY);
  const asked = `${who}:${nonce}`;

  useEffect(() => {
    if (!who) return undefined;
    let live = true;
    playEndpoints.myPlay().then(
      (data) => { if (live) setHeld({ key: asked, who, data, error: null }); },
      (error: unknown) => {
        if (!live) return;
        setHeld((prev) => ({ key: asked, who, data: prev.who === who ? prev.data : null, error }));
      },
    );
    return () => { live = false; };
  }, [asked, who]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const patch = useCallback((update: (current: MyPlay) => MyPlay) => {
    setHeld((prev) => (prev.data ? { ...prev, data: update(prev.data) } : prev));
  }, []);
  const same = held.who === who && who !== "";
  return {
    data: same ? held.data : null,
    error: held.key === asked ? held.error : null,
    loading: held.key !== asked,
    reload,
    patch,
  };
}
