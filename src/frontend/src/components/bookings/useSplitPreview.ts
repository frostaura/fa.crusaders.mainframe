import { useEffect, useMemo, useState } from "react";
import { playersEndpoints, type SplitPreview } from "@/lib/playersApi";
import { localSplit, previewBody, type PlayersDraft } from "./playersDraft";

/**
 * The Split step's live totals bar, and the Confirm sentence's figures: the server's own split
 * (`POST /players/split-preview`) for every DISTINCT price among the slots being booked — usually
 * one; a bulk booking applies the split per booking, so a 45 min slot and a 1 h slot are two
 * previews, never one of 1 h 45 min.
 *
 * <p>
 * <b>Checked on the phone first.</b> A split the mirror (`splitMath`) refuses is never sent: the
 * sentence is shown at once, and there is no figure worth a round trip. <b>Debounced</b>, so a
 * weight typed as "25" is one request rather than two. <b>Keyed</b> on the exact bodies it would
 * send, and the state is DERIVED from whether the answer on hand is the answer to that key — so a
 * slow answer to "2" that lands after the answer to "25" is ignored, and no "loading" is ever set
 * by hand.
 * </p>
 *
 * <p>
 * <b>Never a blank bar while the server answers.</b> The split is whole-minute arithmetic the
 * phone mirrors exactly (`splitMath`), so "loading" carries the phone's own figures (`local`):
 * the totals bar always shows shares that add up to the price, and the server's answer replaces
 * them a debounce later — identical, unless the club's rules moved under it.
 * </p>
 */

export const PREVIEW_DEBOUNCE_MS = 250;

export type PreviewState =
  | { status: "idle" }
  | { status: "invalid"; error: string }
  /** `local`: the phone's own split (the server's rules, mirrored) to show until the answer lands. */
  | { status: "loading"; local: SplitPreview[] }
  | { status: "ready"; previews: SplitPreview[] }
  | { status: "error"; error: unknown };

type Answer = { key: string; ok: true; previews: SplitPreview[] } | { key: string; ok: false; error: unknown };

export function distinctPrices(prices: readonly number[]): number[] {
  return [...new Set(prices)].sort((a, b) => a - b);
}

/** The phone's split of every price — as the server would answer it, seat for seat. */
function localPreviews(prices: readonly number[], draft: PlayersDraft): SplitPreview[] {
  return prices.flatMap((price) => {
    const result = localSplit(price, draft);
    if (!result.ok) return [];
    const shares = result.shares.map((s) => ({ seat: s.seat, team: s.seat <= 2 ? "A" as const : "B" as const, share_minutes: s.share, weight: s.weight }));
    return [{ price_minutes: price, shares }];
  });
}

function localProblem(prices: readonly number[], draft: PlayersDraft): string | null {
  for (const price of prices) {
    const result = localSplit(price, draft);
    if (!result.ok) return result.error;
  }
  return null;
}

export function useSplitPreview(prices: readonly number[], draft: PlayersDraft, enabled: boolean) {
  const [attempt, setAttempt] = useState(0);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const priceKey = prices.join(",");
  const problem = useMemo(
    () => (enabled ? localProblem(priceKey.split(",").map(Number), draft) : null),
    [enabled, priceKey, draft],
  );
  const bodies = useMemo(
    () => (enabled && !problem ? JSON.stringify(priceKey.split(",").map((p) => previewBody(Number(p), draft))) : null),
    [enabled, problem, priceKey, draft],
  );
  const requestKey = bodies ? `${bodies}#${attempt}` : null;

  useEffect(() => {
    if (!bodies || !requestKey) return undefined;
    let live = true;
    const timer = setTimeout(() => {
      const sent = JSON.parse(bodies) as Parameters<typeof playersEndpoints.splitPreview>[0][];
      Promise.all(sent.map((body) => playersEndpoints.splitPreview(body))).then(
        (previews) => { if (live) setAnswer({ key: requestKey, ok: true, previews }); },
        (error: unknown) => { if (live) setAnswer({ key: requestKey, ok: false, error }); },
      );
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [bodies, requestKey]);

  let state: PreviewState;
  if (!enabled) state = { status: "idle" };
  else if (problem) state = { status: "invalid", error: problem };
  else if (!answer || answer.key !== requestKey) state = { status: "loading", local: localPreviews(priceKey.split(",").map(Number), draft) };
  else state = answer.ok ? { status: "ready", previews: answer.previews } : { status: "error", error: answer.error };

  return { state, retry: () => setAttempt((n) => n + 1) };
}
