import { useCallback, useState } from "react";
import type { MyProfile } from "./api";
import { useAuth } from "./useAuth";
import { ProfileContext, type ProfileState } from "./useProfile";
import { memberReads } from "./offline/memberReads";
import { fetchQuery, peekQuery, primeQuery } from "./offline/queryCache";
import { isConnectionFailure, useCachedRead, useDataOwner, type CachedRead } from "./offline/useCachedRead";

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
  const value = profileState(key ? read : null, manualError, refresh, setLocal);
  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>;
}

/** What the provider says, from its read and a manual refresh's failure (null read: nobody's). */
function profileState(
  read: CachedRead<MyProfile> | null, manualError: unknown, refresh: () => Promise<void>, setLocal: (next: MyProfile | null) => void,
): ProfileState {
  const error = read?.error ?? manualError ?? null;
  const profile = read?.data ?? null;
  return {
    profile, loading: read?.loading ?? false, failed: Boolean(error), error, refresh, setLocal,
    readAt: profile ? read?.readAt ?? null : null,
    stale: profile !== null && (Boolean(read?.stale) || Boolean(manualError)),
    offline: Boolean(read?.offline) || isConnectionFailure(manualError),
  };
}
