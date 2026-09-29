import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError, endpoints } from "../lib/api";
import { AuthMark, AuthShell } from "../components/AuthShell";
import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";
import { TextLink } from "../components/ui/text-link";
import { Clock, LinkBreak, SealCheck } from "../components/ui/icons";
import { PendingInviteNote } from "../components/players/invites/PendingInviteNote";
import {
  REGISTER, VERIFY_BACK_TO_SIGN_IN, VERIFY_FAIL_BODY, VERIFY_FAIL_HEADING, VERIFY_FAIL_PRIMARY,
  VERIFY_LIMITED_BODY, VERIFY_LIMITED_HEADING, VERIFY_LIMITED_RETRY, VERIFY_OK_BODY, VERIFY_OK_HEADING,
  VERIFY_WORKING,
} from "../lib/registrationCopy";

type VerifyState = "verifying" | "ok" | "fail" | "limited";

/** A 429 is the limiter, not the link: the token was never looked at, so it is not "didn't work". */
function outcomeOf(error: unknown): VerifyState {
  return error instanceof ApiError && error.status === 429 ? "limited" : "fail";
}

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
  const [state, setState] = useState<VerifyState>(token ? "verifying" : "fail");
  // Same single-use token, same rule as /welcome: spend it once. StrictMode invokes this effect
  // twice, and the second call was answered `400 invalid_or_expired` on a link just consumed.
  const spent = useRef<string | null>(null);

  useEffect(() => {
    if (!token || state !== "verifying") return;
    if (spent.current === token) return;
    spent.current = token;
    endpoints.verifyEmail(token).then((r) => setState(r.verified ? "ok" : "fail")).catch((e) => setState(outcomeOf(e)));
  }, [token, state]);

  // A rate-limited try spent nothing, so trying again is the same request once more.
  const retry = () => {
    spent.current = null;
    setState("verifying");
  };

  if (state === "ok") {
    return (
      <AuthShell className="my-auto" subline={REGISTER.verifySubline} mark={<AuthMark icon={SealCheck} tone="success" />}
        title={VERIFY_OK_HEADING} lead={VERIFY_OK_BODY}>
        {/* R1 F2.3 — arrived by an invite link: it waits for the first sign-in after approval. */}
        <div className="mb-4"><PendingInviteNote stage="verified" /></div>
        <Button asChild block><Link to="/login">{VERIFY_BACK_TO_SIGN_IN}</Link></Button>
      </AuthShell>
    );
  }

  if (state === "limited") {
    return (
      <AuthShell className="my-auto" subline={REGISTER.verifySubline} mark={<AuthMark icon={Clock} tone="info" />}
        title={VERIFY_LIMITED_HEADING} lead={VERIFY_LIMITED_BODY}>
        <div className="flex flex-col items-center gap-2">
          <Button block onClick={retry}>{VERIFY_LIMITED_RETRY}</Button>
          <TextLink to="/login" variant="standalone">{VERIFY_BACK_TO_SIGN_IN}</TextLink>
        </div>
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
