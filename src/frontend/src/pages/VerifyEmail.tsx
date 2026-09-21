import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { endpoints } from "../lib/api";
import { AuthShell } from "../components/AuthShell";
import { Button } from "../components/Button";
import {
  VERIFY_BACK_TO_SIGN_IN, VERIFY_FAIL_BODY, VERIFY_FAIL_HEADING, VERIFY_FAIL_PRIMARY,
  VERIFY_OK_BODY, VERIFY_OK_HEADING, VERIFY_WORKING,
} from "../lib/registrationCopy";

/**
 * The screen the link in the confirmation email lands on.
 *
 * <p>
 * <b>Both settled states used to be dead ends, and the second was worse than a dead end.</b>
 * The success arm was one sentence with no control on it at all, so an applicant who had just
 * done the one thing asked of them was left on a page with nowhere to go — on a phone, with the
 * email app they came from now behind the browser. The failure arm could not tell an expired
 * link from a spent one and told both to "try registering again", which for the ordinary case —
 * opening the same email twice — sends somebody whose address is already confirmed to a form
 * that will answer `email_in_use`. Both now end on a control, and the control is the one that
 * works. See `registrationCopy`.
 * </p>
 */
export default function VerifyEmailPage() {
  const { token } = useParams<{ token: string }>();
  const nav = useNavigate();
  const [state, setState] = useState<"verifying" | "ok" | "fail">(token ? "verifying" : "fail");
  // Same single-use token, same rule as /welcome: spend it once. StrictMode invokes this effect
  // twice, so the second call was answered `400 invalid_or_expired` on a link that had just
  // been consumed successfully — and whichever settled last is what the member read.
  const spent = useRef<string | null>(null);

  useEffect(() => {
    if (!token) return;
    if (spent.current === token) return;
    spent.current = token;
    endpoints.verifyEmail(token).then((r) => setState(r.verified ? "ok" : "fail")).catch(() => setState("fail"));
  }, [token]);

  return (
    <AuthShell className="my-auto" subline="Confirming your email address.">
      <>
        {/*
          `role="status"`, not a bare paragraph: the page arrives already working, and a
          screen-reader user who lands here otherwise hears the heading and then silence for as
          long as the request takes. Polite, because nothing has gone wrong.
        */}
        {state === "verifying" && <p role="status">{VERIFY_WORKING}</p>}
        {state === "ok" && (
          <>
            <h1 className="text-lg font-semibold mb-2">{VERIFY_OK_HEADING}</h1>
            <p className="text-sm text-text-secondary mb-5">{VERIFY_OK_BODY}</p>
            <Button variant="outline" className="w-full" onClick={() => nav("/login")}>{VERIFY_BACK_TO_SIGN_IN}</Button>
          </>
        )}
        {state === "fail" && (
          <>
            <h1 className="text-lg font-semibold mb-2">{VERIFY_FAIL_HEADING}</h1>
            <p className="text-sm text-text-secondary mb-5">{VERIFY_FAIL_BODY}</p>
            {/*
              Signing in is the PRIMARY, because the commonest way to reach this screen is
              opening the same email twice — at which point the address is confirmed, the
              account exists, and signing in is the thing that works. Registering again is
              offered as the quiet second option, for somebody who genuinely never finished.
            */}
            <Button variant="primary" className="w-full" onClick={() => nav("/login")}>{VERIFY_FAIL_PRIMARY}</Button>
            <Button variant="ghost" className="w-full mt-2" onClick={() => nav("/register")}>Start a new application</Button>
          </>
        )}
      </>
    </AuthShell>
  );
}
