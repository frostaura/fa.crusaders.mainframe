import { createContext, useContext } from "react";
import type { MyProfile } from "./api";

/** The signed-in member's profile as screens read it; `ProfileProvider` (`profile.tsx`) fills it. */
export type ProfileState = {
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

export const ProfileContext = createContext<ProfileState | null>(null);

export function useProfile(): ProfileState {
  const ctx = useContext(ProfileContext);
  if (!ctx) throw new Error("useProfile must be used inside <ProfileProvider>");
  return ctx;
}
