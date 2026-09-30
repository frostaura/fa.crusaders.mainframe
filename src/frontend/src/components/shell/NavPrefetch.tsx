import { useEffect } from "react";
import { useAuth } from "@/lib/auth";
import { prefetchNavChunks } from "@/routeChunks";

/**
 * Once somebody is signed in, fetch the tab bar's pages while the phone is idle (`routeChunks`),
 * so the first tap on Bookings or Wallet opens without waiting on its code. Draws nothing.
 */
export function NavPrefetch() {
  const auth = useAuth();
  const signedIn = auth.status === "authenticated";
  useEffect(() => (signedIn ? prefetchNavChunks() : undefined), [signedIn]);
  return null;
}
