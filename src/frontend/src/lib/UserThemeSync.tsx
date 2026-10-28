import { useEffect } from "react";
import { applyCss, applyStoredOverrides } from "./themeOverrides";
import { useOptionalAuth } from "./useAuth";

/**
 * Paints the signed-in member's theme overrides, and takes them off the page on sign-out so the
 * next person on a shared device does not open the app in someone else's colours.
 * `loading` and `offline` leave whatever the boot script painted alone: neither says who is here.
 */
export function UserThemeSync() {
  const auth = useOptionalAuth();
  const status = auth?.status;
  const userId = auth?.status === "authenticated" ? auth.userId : null;
  useEffect(() => {
    if (userId) applyStoredOverrides(userId);
    else if (status === "anonymous") applyCss("");
  }, [userId, status]);
  return null;
}
