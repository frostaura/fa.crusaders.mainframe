import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../lib/useAuth";

/**
 * `/reports`, after the reports split (R16).
 *
 * <p>
 * One page used to serve both readers, forking on `isAdmin` inside every section — and giving
 * an admin their own permanently-empty wallet in the middle of the club's figures. It is now two
 * pages with one subject each: the member's own report is `pages/WalletActivity`
 * (`/wallet/activity`, the wallet's second view) and the club's is `pages/admin/AdminReports`
 * (`/admin/reports`). Nothing is built here any more — and nothing here may import either page:
 * `App.tsx` imports this module statically, and both pages carry the chart library that is
 * lazy-loaded on purpose.
 * </p>
 */
function isAdminSession(auth: ReturnType<typeof useAuth>): boolean {
  return auth.status === "authenticated" && auth.isAdmin;
}

/**
 * The old address, redirected to the page that replaced it for whoever is asking — keeping the
 * query, so a bookmarked `/reports?from=…&to=…` opens on the same period. `App.tsx` mounts it
 * at `/reports`.
 */
export function ReportsRedirect() {
  const auth = useAuth();
  const { search, hash } = useLocation();
  // Not before the session is known: an admin's first render is "loading", and redirecting on
  // it would send every admin to their own (empty) wallet report.
  if (auth.status === "loading") return null;
  const pathname = isAdminSession(auth) ? "/admin/reports" : "/wallet/activity";
  return <Navigate replace to={{ pathname, search, hash }} />;
}
