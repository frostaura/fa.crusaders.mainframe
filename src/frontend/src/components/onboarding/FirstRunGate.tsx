import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { LANDING_PATH } from "@/components/shell/nav";
import { useAuth } from "@/lib/auth";
import { arrivedFromSignIn, markOffered, shouldOfferWizard, wasOffered } from "@/lib/onboarding";
import { GET_STARTED_PATH } from "@/lib/onboardingCopy";
import { useOnboarding, useProfileOrNull } from "./useOnboarding";

/**
 * The first-run gate (P8, D3): a newly approved member lands on the welcome wizard once.
 *
 * <p>
 * Renders nothing. It watches for the one moment it may act — a signed-in, active member
 * arriving at the landing with the wizard known to be owed — and sends them to `/get-started`
 * with `replace`, so Back from the wizard does not bounce straight back into it. It records the
 * offer for the tab first, so a member who skips out and taps My Code is not sent round again;
 * the wizard page records it too, for a member who found it by themselves.
 * </p>
 *
 * <p>
 * <b>What it never does</b> (`shouldOfferWizard`): act on any route but the landing a sign-in just
 * delivered the member to (F4.8 — never on a My Code opened at the door), so no task
 * a member or admin chose is interrupted; act while offline or on a password-change session;
 * or act on "cannot tell" — an API without preferences, or a profile read that failed.
 * </p>
 */
export function FirstRunGate() {
  const auth = useAuth();
  const profile = useProfileOrNull();
  const { memberDue, userId } = useOnboarding();
  const { pathname, state } = useLocation();
  const navigate = useNavigate();

  const offer = shouldOfferWizard({
    signedIn: auth.status === "authenticated",
    mustChangePassword: auth.status === "authenticated" && auth.mustChangePassword,
    pathname,
    landing: LANDING_PATH,
    arrivedFromSignIn: arrivedFromSignIn(state),
    status: profile?.status,
    due: memberDue,
    alreadyOffered: wasOffered(userId),
  });

  useEffect(() => {
    if (!offer) return;
    markOffered(userId);
    navigate(GET_STARTED_PATH, { replace: true });
  }, [offer, userId, navigate]);

  return null;
}
