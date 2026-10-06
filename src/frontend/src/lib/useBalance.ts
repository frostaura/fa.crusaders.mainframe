import { createContext, useContext } from "react";
import type { BalanceDelta, HeldFigures, LiveState } from "./liveBalance";

/** The live wallet figure as screens read it; `BalanceProvider` (`balance.tsx`) fills it. */
export type BalanceState = {
  balance: number | null;
  loading: boolean;
  /** Four states, not two. `loading` != `degraded` != `unavailable`. */
  state: LiveState;
  lastConfirmedAt: number | null;
  /** The most recent movement, for the chip's count-up and flyout. */
  delta: BalanceDelta | null;
  clearDelta: () => void;
  /**
   * D11 §3a — what of the balance is held for partners, the SPENDABLE figure every spend
   * decision and every "balance after" reads, and when the hold lifts. Null until a figure has
   * arrived; `held` 0 against an API that predates it.
   */
  held: HeldFigures | null;
  /** P11 — the inbox's unread count as the stream last pushed it (null until one arrives). */
  unreadCount: number | null;
  noteUnread: (count: number) => void;
  /**
   * Re-read the wallet. `{ expectSelf: true }` on the paths where the PAGE has already told
   * the member what happened, so the chip does not announce the same movement a second time —
   * see `useLiveBalance.refresh`. Bare, for the reads nobody asked for (focus, visibility).
   */
  refresh: (options?: { expectSelf?: boolean }) => Promise<void>;
  /**
   * Take a balance the server has just stated, without asking it again.
   *
   * <p>
   * The booking response carries <code>balance_after_minutes</code>, so the wallet GET that
   * used to follow every booking asked a question already answered and put a second round trip
   * between a member's tap and the screen changing. This is not an optimistic guess — it is
   * the server's own figure from the response that committed the charge; the wallet stream and
   * the next wallet read still reconcile it.
   * </p>
   *
   * <p>
   * It also marks the next movement as this tab's own, so the chip does not raise a toast
   * about a booking the member has already been told about.
   * </p>
   *
   * <p>
   * R17 J17-2 (FE17x) — dropped when a stream frame has arrived since the request was SENT
   * (`sentAt`, else the mark at this tab's latest money-moving request): the frame is the newer
   * truth, and the answer put over it was a stale figure and a false movement.
   * </p>
   */
  apply: (balanceMinutes: number, options?: { sentAt?: number }) => void;
  /**
   * R17 J17-2 (FE17x) — how many stream frames have arrived. A read or write that will hand its
   * answer to `apply` takes this when it SENDS and passes it as `sentAt`; an answer overtaken by a
   * frame is then dropped rather than put over the newer figure.
   */
  frameMark: () => number;
};

export const BalanceContext = createContext<BalanceState | null>(null);

export function useBalance(): BalanceState {
  const ctx = useContext(BalanceContext);
  if (!ctx) throw new Error("useBalance must be used inside <BalanceProvider>");
  return ctx;
}
