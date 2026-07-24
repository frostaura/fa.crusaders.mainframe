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

  const refresh = useCallback(async () => {
    if (auth.status !== "authenticated") return;
    setLoading(true);
    try { setProfile(await endpoints.meProfile()); }
    catch { /* leave previous value */ }
    finally { setLoading(false); }
  }, [auth.status]);

  useEffect(() => {
    if (auth.status === "authenticated") refresh();
    else setProfile(null);
  }, [auth.status, refresh]);

  return (
    <ProfileContext.Provider value={{ profile, loading, refresh, setLocal: setProfile }}>
      {children}
    </ProfileContext.Provider>
  );
}
