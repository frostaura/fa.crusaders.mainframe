import { createContext, useCallback, useContext, useState } from "react";
import type { MyProfile } from "./api";
import { useAuth } from "./auth";
import { memberReads } from "./offline/memberReads";
import { fetchQuery, peekQuery, primeQuery } from "./offline/queryCache";
import { isConnectionFailure, useCachedRead, useDataOwner } from "./offline/useCachedRead";

type ProfileState = {
  /** The signed-in member's profile — never an earlier member's. Null until read. */
  profile: MyProfile | null;
  loading: boolean;
  /**
   * The last read FAILED. Three states, not two: a failed read is not "this member has no
   * profile", and a screen that drew the "Your account" fallback over one was telling the member
   * something untrue about who they were signed in as (D2).
   */
  failed: boolean;
  /**
   * What the failed read threw, so a screen can say WHY in the same words as every other screen
   * (F4-17: under a 503 Profile said "something went wrong" where the rest said "down or
   * restarting", because it only knew THAT the read failed). Null unless `failed`.
   */
  error: unknown;
  refresh: () => Promise<void>;
  setLocal: (next: MyProfile | null) => void;
  /** R4 wave B — when `profile` was true at the club, and whether the club has since failed to confirm it. */
  readAt?: number | null;
  stale?: boolean;
  offline?: boolean;
};

const ProfileContext = createContext<ProfileState | null>(null);

export function useProfile(): ProfileState {
  const ctx = useContext(ProfileContext);
  if (!ctx) throw new Error("useProfile must be used inside <ProfileProvider>");
  return ctx;
}

export function ProfileProvider({ children }: { children: React.ReactNode }) {
  const auth = useAuth();

  /**
   * The session is authenticated but holds an admin-issued temporary password, so the API
   * refuses `/me/profile` with `403 password_change_required` until it is replaced.
   *
   * <p>
   * It is a DEPENDENCY, not just a guard. `auth.status` is `"authenticated"` throughout the
   * forced change — only this flag moves — so an effect keyed on the status alone never re-ran
   * after the member chose their own password, and they landed on /schedule with a grey "?"
   * where their photo belongs. It stayed that way indefinitely; only a manual reload fixed it.
   * </p>
   */
  const gated = auth.status === "authenticated" && auth.mustChangePassword;

  /**
   * WHO is signed in is a dependency too (D2), and its absence was a measured defect.
   *
   * <p>
   * A browser holding a leftover token for a member who no longer existed read `/me/profile`
   * once (404), and a password sign-in a moment later moved `auth.userId` but not
   * `auth.status` — "authenticated" to "authenticated" — so the read never ran again. The
   * avatar said "YA" ("Your account"), there was no photo, and the first-run wizard, which
   * reads the profile, never fired. Every identity change — sign-in, passkey, magic link, an
   * account switch — is a new read.
   * </p>
   *
   * <p>
   * R4 wave B — the read is kept by `lib/offline` under the member (`useDataOwner`), so another
   * member's profile is never in hand; while the session check is out, or the club cannot be
   * reached, the phone's copy is drawn and the club is asked only once the check has answered
   * (`whileChecking: false` — not beside `whoami` on a cold My Code).
   * </p>
   */
  const { who } = useDataOwner();
  const key = who && !gated ? memberReads.profile.key : null;
  const read = useCachedRead<MyProfile>(key, memberReads.profile.load, { whileChecking: false });
  const [manual, setManual] = useState<{ base: string | null; at: number | null; error: unknown } | null>(null);
  const base = key ? who : null;

  // `refresh` is awaited (a photo just uploaded): it resolves once the club has answered.
  const refresh = useCallback(async () => {
    if (!key) return;
    try {
      await fetchQuery(who, key, memberReads.profile.load);
      setManual({ base: who, at: Date.now(), error: null });
    } catch (err) {
      // Keep what was on screen for THIS member, but say the read failed.
      setManual({ base: who, at: peekQuery(who, key)?.at ?? null, error: err });
    }
  }, [key, who]);
  const setLocal = useCallback((next: MyProfile | null) => {
    if (key && next) primeQuery(who, key, next);
  }, [key, who]);

  // A manual refresh's failure stands until the profile on hand moves on from it.
  const manualError = manual && manual.base === base && manual.at === read.readAt ? manual.error : null;
  const error = read.error ?? manualError;
  const profile = key ? read.data : null;
  return (
    <ProfileContext.Provider value={{
      profile, loading: read.loading, failed: Boolean(error), error: error ?? null, refresh, setLocal,
      readAt: profile ? read.readAt : null, stale: profile !== null && (read.stale || Boolean(manualError)),
      offline: read.offline || isConnectionFailure(manualError),
    }}
    >
      {children}
    </ProfileContext.Provider>
  );
}
