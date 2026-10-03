import { memberReads } from "@/lib/offline/memberReads";
import { useCachedRead, useDataOwner } from "@/lib/offline/useCachedRead";
import type { MyPlay } from "@/lib/playApi";

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
  /** The club could not be reached at all (R7 X7-3: said as offline when nothing is kept). */
  offline: boolean;
  reload: () => void;
  /** Apply a write's answer at once (the goal, the pause, the switch); a re-read follows. */
  patch: (update: (current: MyPlay) => MyPlay) => void;
};

export function useMyGame(): MyGameRead {
  // R4 wave B — kept by `lib/offline` (`play:me`), keyed by the member (`useDataOwner`): a revisit
  // draws at once, offline draws the phone's copy. Nobody signed in reads nothing.
  const { who } = useDataOwner();
  const cached = useCachedRead(who ? memberReads.myPlay.key : null, memberReads.myPlay.load);
  return { data: cached.data, error: cached.error, loading: cached.loading, offline: cached.offline, reload: cached.reload, patch: cached.patch };
}
