import { useEffect, useRef, useState } from "react";
import { useBalance } from "../../lib/balance";

/**
 * GOAL item 8, on the wallet's own screen — and a local stand-in for the UI lane's
 * `lib/liveBalance.useLiveBalance`.
 *
 * <p>
 * <b>MERGE NOTE.</b> The shape below is D4's `useLiveBalance` contract. When that hook lands,
 * this file becomes a re-export and the wallet page does not change. It is here because the
 * two lanes are separate branches and a page cannot be built, tested or walked against a
 * module that is not in this worktree.
 * </p>
 *
 * <p>
 * <b>What this version honestly cannot report.</b> `BalanceProvider` owns the stream — the
 * one-minute ticket, the named keep-alive, the silence detector, the exponential backoff —
 * and exposes `balance`, `loading`, `refresh` and `apply`, and nothing about the stream's
 * health. So `state` here is three answers, never four: there is no way from out here to tell
 * a live figure from a stale one, which is exactly the gap D4's `degraded` exists to close.
 * It is reported as `live`, not invented as `degraded`, and the day the shared hook lands the
 * fourth state arrives with it. <b>Nothing in this module claims a figure is fresh.</b>
 * </p>
 */

export type LiveState = "loading" | "live" | "degraded" | "unavailable";

/**
 * Two movements a hundredth of a credit apart are the same movement, and neither is one.
 *
 * `toFixed(2)` is what the whole product renders money at, so a change that cannot show up
 * in two decimal places has not happened as far as a member is concerned.
 */
const EPSILON = 0.005;

export type WalletLive = {
  /** The server's figure, from the stream. Null until the provider has one. */
  balance: number | null;
  state: LiveState;
  refresh: () => Promise<void>;
};

export function useWalletLive(): WalletLive {
  const { balance, loading, refresh } = useBalance();
  const state: LiveState = balance !== null ? "live" : loading ? "loading" : "unavailable";
  return { balance, state, refresh };
}

/**
 * A movement in the figure on screen, reported once.
 *
 * <p>
 * <b>It watches the figure the PAGE is painting, not the stream's.</b> The stream is the
 * faster of the two and is why the chip and this card agree — but it is silent for a signed-in
 * tab whose provider has not connected, and it is not the only way the number moves: the
 * page's own Refresh, and the re-read after every stream tick, both land a figure here. A
 * detector wired only to the stream announces nothing on a member who pressed Refresh and
 * watched their balance change, which is the same defect in a smaller costume.
 * </p>
 *
 * <p>
 * The FIRST figure is never a movement: `null → 400.00` is not a top-up, it is the first time
 * the member has been told. Seeded `undefined` rather than `null` so the two are different.
 * </p>
 */
export function useBalanceMovement(balance: number | null): BalanceDelta | null {
  const [delta, setDelta] = useState<BalanceDelta | null>(null);
  const reported = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (balance === null) return;
    const previous = reported.current;
    reported.current = balance;
    if (previous === undefined) return;
    const moved = balance - previous;
    if (Math.abs(moved) < EPSILON) return;
    // The movement IS the effect: it is derived from comparing this render's figure with the
    // last one reported on, which is not something a render body may do.
    setDelta({ amount: Math.abs(moved), at: Date.now(), direction: moved > 0 ? "up" : "down" });
  }, [balance]);

  return delta;
}

export type BalanceDelta = {
  amount: number;
  at: number;
  /** Which way it moved. The page words the two differently — see `walletCopy`. */
  direction: "up" | "down";
};

/**
 * The figure, counted up to rather than swapped.
 *
 * <p>
 * <b>MERGE NOTE.</b> D4 puts this in `lib/useCountUp.ts`, which is the UI lane's. Same
 * contract; one import changes.
 * </p>
 *
 * <p>
 * A count that scales without a ceiling makes a big top-up feel slow, so the duration is
 * clamped: five credits takes 350 ms and four hundred takes 900. Eased on the VALUE, because
 * linear counting reads mechanical. A second movement mid-tween restarts from what is on
 * screen, never from the old target, so two quick movements can never make the number jump
 * backwards.
 * </p>
 */
export function useCountUp(target: number | null): number | null {
  const [displayed, setDisplayed] = useState<number | null>(target);
  const from = useRef<number | null>(target);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    if (target === null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- mirroring a null target
      setDisplayed(null);
      from.current = null;
      return;
    }
    const start = from.current;
    // The first non-null figure is not a movement. Neither is a request for a figure the
    // screen is already showing.
    if (start === null || Math.abs(target - start) < EPSILON) {
      // First paint, or a figure the screen already shows: no tween.
      setDisplayed(target);
      from.current = target;
      return;
    }
    if (prefersReducedMotion()) {
      // Snaps. The announcement carries the change instead — see `walletCopy`.
      setDisplayed(target);
      from.current = target;
      return;
    }

    const distance = Math.abs(target - start);
    const duration = Math.min(900, Math.max(350, 18 * distance));
    const began = performance.now();
    const step = (now: number) => {
      // Clamped at 0 too: a frame can be stamped a hair before `began`, and a negative t undershoots.
      const t = Math.min(1, Math.max(0, (now - began) / duration));
      // easeOutCubic on the value.
      const eased = 1 - Math.pow(1 - t, 3);
      const value = start + (target - start) * eased;
      setDisplayed(value);
      from.current = value;
      if (t < 1) frame.current = requestAnimationFrame(step);
      else { from.current = target; setDisplayed(target); }
    };
    frame.current = requestAnimationFrame(step);
    return () => { if (frame.current !== null) cancelAnimationFrame(frame.current); };
  }, [target]);

  return displayed;
}

/**
 * Whether to animate at all — and a browser that cannot tell us is answered NO.
 *
 * <p>
 * `matchMedia` missing or throwing means the page has no way to know whether the reader has
 * asked for less motion. The conservative answer is the accessible one: do not animate
 * something nobody asked for, on a viewer whose preference cannot be read. It also makes the
 * count deterministic under jsdom, where a tween is a frame loop a test has to wait out for a
 * figure that is already correct.
 * </p>
 */
function prefersReducedMotion(): boolean {
  try {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    return query ? query.matches === true : true;
  } catch { return true; }
}
