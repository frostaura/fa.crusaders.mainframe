import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { endpoints } from "../lib/api";
import { AuthMark, AuthShell } from "../components/AuthShell";
import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";
import { TextLink } from "../components/ui/text-link";
import { LinkBreak, SealCheck } from "../components/ui/icons";
import {
  REGISTER, VERIFY_BACK_TO_SIGN_IN, VERIFY_FAIL_BODY, VERIFY_FAIL_HEADING, VERIFY_FAIL_PRIMARY,
  VERIFY_OK_BODY, VERIFY_OK_HEADING, VERIFY_WORKING,
} from "../lib/registrationCopy";

/**
 * The screen the link in the confirmation email lands on.
 *
 * <p>
 * <b>Both settled states used to be dead ends.</b> The success arm was one sentence with no
 * control at all — on a phone, with the email app behind the browser. The failure arm could not
 * tell an expired link from a spent one and told both to "try registering again", which for the
 * ordinary case (opening the same email twice) sends somebody already confirmed to a form that
 * answers `email_in_use`. Both now end on the way on that works — and both ways on are
 * navigation, so they are links (R10), the primary one dressed as the screen's call to action.
 * </p>
 */
export default function VerifyEmailPage() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<"verifying" | "ok" | "fail">(token ? "verifying" : "fail");
  // Same single-use token, same rule as /welcome: spend it once. StrictMode invokes this effect
  // twice, and the second call was answered `400 invalid_or_expired` on a link just consumed.
  const spent = useRef<string | null>(null);

  useEffect(() => {
    if (!token) return;
    if (spent.current === token) return;
    spent.current = token;
    endpoints.verifyEmail(token).then((r) => setState(r.verified ? "ok" : "fail")).catch(() => setState("fail"));
  }, [token]);

  if (state === "ok") {
    return (
      <AuthShell className="my-auto" subline={REGISTER.verifySubline} mark={<AuthMark icon={SealCheck} tone="success" />}
        title={VERIFY_OK_HEADING} lead={VERIFY_OK_BODY}>
        <Button asChild block><Link to="/login">{VERIFY_BACK_TO_SIGN_IN}</Link></Button>
      </AuthShell>
    );
  }

  if (state === "fail") {
    return (
      <AuthShell className="my-auto" subline={REGISTER.verifySubline} mark={<AuthMark icon={LinkBreak} tone="danger" />}
        title={VERIFY_FAIL_HEADING} lead={VERIFY_FAIL_BODY}>
        {/* Signing in is the PRIMARY: the commonest way here is opening the same email twice, and
            by then the account exists. Registering again is the quiet second option. */}
        <div className="flex flex-col items-center gap-2">
          <Button asChild block><Link to="/login">{VERIFY_FAIL_PRIMARY}</Link></Button>
          <TextLink to="/register" variant="standalone">{REGISTER.startAgain}</TextLink>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell className="my-auto" subline={REGISTER.verifySubline}>
      {/* `role="status"`: the page arrives already working, and a screen-reader user otherwise
          hears silence for as long as the request takes. Polite — nothing has gone wrong. */}
      <p role="status" className="flex items-center justify-center gap-3 py-6 text-base font-medium text-text-primary">
        <Spinner className="size-5 text-accent-strong" />
        {VERIFY_WORKING}
      </p>
    </AuthShell>
  );
}
