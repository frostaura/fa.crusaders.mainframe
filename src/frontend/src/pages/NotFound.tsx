import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Compass } from "@/components/ui/icons";
import { PageShell } from "@/components/ui/page-shell";
import { typography } from "@/lib/typography";
import { tokenStore } from "@/lib/api";
import { LANDING_PATH } from "../components/shell/nav";

/**
 * What an unknown URL renders.
 *
 * <p>
 * The catch-all used to be <code>&lt;Navigate to="/" replace /&gt;</code>, which silently turned
 * every mistyped, renamed or not-yet-built path into the home page — how the missing
 * password-reset routes stayed invisible for as long as they did. A dead end that announces
 * itself is worth more than a redirect that hides one. Every moved URL has its own permanent
 * redirect in `App.tsx`, so arriving here really does mean the link is wrong.
 * </p>
 *
 * <p>
 * The way out is the person's own landing: My Code for a member (R15), the club's page for a
 * visitor. Both are navigation CTAs, so they are links wearing the button look. "Member" is read
 * from the stored session rather than from the auth context: a 404 must render anywhere, and a
 * stale token is harmless here — My Code's own guard sends it on to sign in.
 * </p>
 */
export default function NotFoundPage() {
  const signedIn = Boolean(tokenStore.get());
  return (
    <PageShell width="narrow">
      <div className="flex flex-col items-center gap-4 py-10 text-center">
        <Compass size={48} weight="duotone" aria-hidden="true" className="text-text-muted" />
        <h1 data-route-heading="" className={typography({ variant: "h1" })}>Page not found</h1>
        <p className="max-w-prose text-sm text-text-secondary">
          We couldn't find that page. The link may be out of date, or the address may have a typo in it.
        </p>
        <div className="mt-2 flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
          {signedIn ? (
            <>
              <Button asChild><Link to={LANDING_PATH}>Go to My Code</Link></Button>
              <Button asChild variant="outline"><Link to="/bookings">Book a court</Link></Button>
            </>
          ) : (
            <>
              <Button asChild><Link to="/">Go to the home page</Link></Button>
              <Button asChild variant="outline"><Link to="/login">Sign in</Link></Button>
            </>
          )}
        </div>
      </div>
    </PageShell>
  );
}
