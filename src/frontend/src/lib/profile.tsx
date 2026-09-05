import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { endpoints, type MyProfile } from "./api";
import { useAuth } from "./auth";

type ProfileState = {
  profile: MyProfile | null;
  loading: boolean;
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

  const refresh = useCallback(async () => {
    if (auth.status !== "authenticated" || gated) return;
    setLoading(true);
    try { setProfile(await endpoints.meProfile()); }
    catch { /* leave previous value */ }
    finally { setLoading(false); }
  }, [auth.status, gated]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncs profile state with the auth lifecycle; loader sets its flag synchronously
    if (auth.status === "authenticated") { if (!gated) refresh(); }
    else setProfile(null);
  }, [auth.status, gated, refresh]);

  return (
    <ProfileContext.Provider value={{ profile, loading, refresh, setLocal: setProfile }}>
      {children}
    </ProfileContext.Provider>
  );
}
