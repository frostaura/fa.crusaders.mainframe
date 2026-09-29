import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { endpoints, type MyProfile } from "./api";
import { useAuth } from "./auth";

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
  refresh: () => Promise<void>;
  setLocal: (next: MyProfile | null) => void;
};

const ProfileContext = createContext<ProfileState | null>(null);

export function useProfile(): ProfileState {
  const ctx = useContext(ProfileContext);
  if (!ctx) throw new Error("useProfile must be used inside <ProfileProvider>");
  return ctx;
}

export function ProfileProvider({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  const [profile, setProfile] = useState<MyProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

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
   */
  const identity = auth.status === "authenticated" && !gated ? auth.userId : null;
  // A read that answers after the identity has moved on belongs to somebody else.
  const current = useRef(identity);
  useLayoutEffect(() => { current.current = identity; }, [identity]);

  const refresh = useCallback(async () => {
    if (identity === null) return;
    setLoading(true);
    try {
      const read = await endpoints.meProfile();
      if (current.current !== identity) return;
      setProfile(read);
      setFailed(false);
    } catch {
      // Keep what was on screen for THIS member, but say the read failed.
      if (current.current === identity) setFailed(true);
    } finally {
      if (current.current === identity) setLoading(false);
    }
  }, [identity]);

  useEffect(() => {
    // Whatever was shown belonged to the previous identity (or to none).
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncs profile state with the signed-in identity
    setProfile(null);
    setFailed(false);
    if (identity !== null) void refresh();
    else setLoading(false);
  }, [identity, refresh]);

  return (
    <ProfileContext.Provider value={{ profile, loading, failed, refresh, setLocal: setProfile }}>
      {children}
    </ProfileContext.Provider>
  );
}
