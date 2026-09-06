import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { endpoints, type TopUpStatus } from "../lib/api";
import { Card } from "../components/Card";
import { Badge, Button } from "../components/Button";
import { useBalance } from "../lib/balance";
import { formatZar } from "../lib/utils";

/**
 * What each failure code means, to a member.
 *
 * <p>
 * The page rendered the raw column: a member whose R500 payment failed was shown
 * <code>amount_mismatch:reported=100,00:expected=500,00</code>, an internal string with
 * en-ZA comma decimals, as their explanation — and nothing about what to do next. Codes
 * are the API's stable contract; the sentences live here.
 * </p>
 */
const FAILURE_COPY: Record<string, string> = {
  amount_mismatch:
    "PayFast reported a different amount from the one this top-up was for, so nothing was credited. If money did leave your account, send the club your PayFast reference and they'll sort it out.",
  declined:
    "Your bank declined the payment, so nothing was charged. Try again, or use a different card.",
  gateway_error:
    "PayFast couldn't complete the payment and nothing was charged. Try again in a few minutes.",
  provider_register_failed:
    "The club's payment settings wouldn't accept this top-up. Nothing was charged — please tell an admin.",
};

/**
 * How long to wait before asking again, or null when this page should stop asking.
 *
 * <p>
 * It was a flat <code>attempts &lt; 30</code> at 2s, so the page stopped after 62
 * seconds — and said nothing. PayFast retries an ITN for hours and an EFT clears when it
 * clears, so the common case is that the money arrives AFTER the polling has quietly
 * given up: the member is left reading "Waiting for confirmation from PayFast…" for ever
 * beside credits that are already in their ledger, with no control on the screen and no
 * way out but a manual browser reload.
 * </p>
 *
 * <p>
 * Two things had to change and only one of them is the budget. The budget widens — fast
 * while a card payment would clear, then slower, out to roughly six minutes — but the
 * page also has to say when it has stopped, and offer to ask again itself. A screen that
 * gives up silently is worse than one that never tried, because it still claims to be
 * waiting.
 * </p>
 */
function pollDelayMs(attempt: number): number | null {
  if (attempt < 15) return 2_000;   // ~30s: a card payment is confirmed well inside this
  if (attempt < 39) return 5_000;   // ~2½ minutes
  if (attempt < 54) return 15_000;  // ~6 minutes, then stop and say so
  return null;
}

export default function TopUpStatusPage() {
  const { topupId } = useParams<{ topupId: string }>();
  const [s, setS] = useState<TopUpStatus | null>(null);
  /* Whether the LAST attempt to read the status failed. Not the sentence — the two places
     that report it say different things, because "we could not reach the club" means something
     different before a status is known than it does beside one that is already on screen. */
  const [loadFailed, setLoadFailed] = useState(false);
  const [gaveUp, setGaveUp] = useState(false);
  const [checking, setChecking] = useState(false);
  /** Bumped by "Check again", which restarts the schedule from the top. */
  const [round, setRound] = useState(0);
  const { refresh: refreshBalance } = useBalance();
  const refreshedOnce = useRef(false);
  // Held in a ref rather than named as a dependency. `refresh` is rebuilt when the auth
  // status flips from loading to authenticated, and with it in the dependency list the
  // whole poll was torn down and restarted a few milliseconds after mount — two requests
  // for the same answer on every visit to this page, and a schedule that could not be
  // reasoned about from the code.
  const refreshBalanceRef = useRef(refreshBalance);
  useEffect(() => { refreshBalanceRef.current = refreshBalance; }, [refreshBalance]);

  useEffect(() => {
    if (!topupId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let first = true;

    const settled = () => { if (first) { first = false; setChecking(false); } };

    const tick = async () => {
      try {
        const snap = await endpoints.topupStatus(topupId);
        if (cancelled) return;
        settled();
        setS(snap);
        setLoadFailed(false);
        if (snap.status === "Completed" && !refreshedOnce.current) {
          refreshedOnce.current = true;
          refreshBalanceRef.current();
        }
        // Anything but Pending is final; there is nothing left to ask about.
        if (snap.status !== "Pending") return;
        const delay = pollDelayMs(attempts++);
        if (delay === null) { setGaveUp(true); return; }
        timer = setTimeout(() => { void tick(); }, delay);
      } catch {
        if (cancelled) return;
        settled();
        setLoadFailed(true);
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [topupId, round]);

  const checkAgain = () => {
    setChecking(true);
    setGaveUp(false);
    setRound((r) => r + 1);
  };

  /*
    A failed status request is not a dead end, and it used to be one: this branch was a bare
    sentence in a bare card — no controls at all, no wallet link, not even the page's own
    layout — so the only way out was the manual browser reload the whole finding is about.
    The "Check again" button added in the previous round made that reachable in one press: a
    refuter aborted the status request on a live Pending top-up, pressed it, and the page
    became "Couldn't load top-up status." with nothing on it.

    Two things follow. A failure BEFORE anything is known keeps the two controls the Pending
    branch has, so the member can ask again or go look at their wallet. A failure AFTER a
    status has been read does not throw that status away — the amount, the badge and the
    controls stay, and the failure is a line beside them saying the screen may be stale. It
    is also worth saying plainly that nothing here touches the payment: a member watching a
    R500 top-up needs to know that a page that cannot reach the club has not cancelled it.
  */
  if (loadFailed && !s) {
    return (
      <div className="max-w-md mx-auto">
        <Card>
          <h1 className="text-xl font-semibold mb-2">Top-up</h1>
          {/*
            "we'll email you EITHER WAY" is what this said, and the product does not do it.
            `EmailDispatch.InBackground` appears once in TopUpEndpoints.cs, inside
            CompleteAsync; the amount_mismatch, Failed/Cancelled and provider_register_failed
            branches send nothing, EmailTemplates has a TopUpConfirmation and no failure
            template, and feature-spec.md §11's required-email list names the confirmation and
            no failure mail. So the sentence promised, on the one screen standing between a
            member and money they have already paid, the exact thing this programme keeps
            finding: copy a code path does not keep. It now claims only the confirmation,
            which is real and unconditional on completion — and
            `topup-status-email-promise.test.ts` reads both backend files and fails if the two
            ever disagree again, in either direction.
          */}
          <p role="alert" className="text-sm text-danger-strong">
            We couldn't reach the club to check on this payment. Nothing here cancels or
            changes it — if it has already cleared, your credits are in your wallet and
            we'll email you the confirmation.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="outline" onClick={checkAgain} disabled={checking} aria-busy={checking}>
              {checking ? "Checking…" : "Check again"}
            </Button>
            <Link to="/wallet"><Button variant="ghost">View wallet</Button></Link>
          </div>
        </Card>
      </div>
    );
  }
  if (!s) return <Card>Loading…</Card>;

  // Cancelled is the member's own decision and gets its own neutral treatment. It used to
  // be stored and shown as "Failed", so somebody who deliberately backed out at PayFast
  // was told their payment had failed.
  const tone = s.status === "Completed" ? "success" : s.status === "Failed" ? "danger" : "info";

  return (
    <div className="max-w-md mx-auto">
      <Card>
        <h1 className="text-xl font-semibold mb-2">Top-up</h1>
        <p className="text-sm text-text-secondary mb-3">{formatZar(s.amount_zar)}</p>
        <Badge tone={tone}>{s.status}</Badge>

        {/* The status above was read before the club stopped answering, so it is kept and
            labelled rather than replaced by the failure. */}
        {loadFailed && (
          <p role="alert" className="mt-3 text-sm text-danger-strong">
            We couldn't reach the club just now, so this may be out of date. Nothing here
            cancels or changes your payment — press Check again in a moment.
          </p>
        )}

        {/*
          The Pending branch carries a control now, and stops lying when it has stopped
          asking. It used to be this one line: no Refresh, no Try again — only Cancelled
          and Failed got those — so a member whose R500 had already landed sat in front of
          "Waiting for confirmation from PayFast…" indefinitely while their credits were in
          the ledger, and the only way out was to reload the browser by hand.
        */}
        {s.status === "Pending" && (
          <>
            <p className="mt-3 text-sm text-text-secondary">
              {gaveUp
                ? "We've stopped checking on this page. PayFast can take a while — an instant EFT usually lands within minutes and a normal EFT can take until the next working day. Your credits appear the moment it clears, and we'll email you."
                : "Waiting for confirmation from PayFast…"}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="outline" onClick={checkAgain} disabled={checking} aria-busy={checking}>
                {checking ? "Checking…" : "Check again"}
              </Button>
              <Link to="/wallet"><Button variant="ghost">View wallet</Button></Link>
            </div>
          </>
        )}

        {s.status === "Cancelled" && (
          <>
            <p className="mt-3 text-sm text-text-secondary">You cancelled this payment, so nothing was charged and no credits were added.</p>
            <Link to="/wallet/topup" className="inline-block mt-3"><Button variant="outline">Try again</Button></Link>
          </>
        )}

        {s.status === "Failed" && (
          <>
            <p className="mt-3 text-sm text-danger-strong">
              {(s.failure_code && FAILURE_COPY[s.failure_code]) ?? "This payment didn't go through. Nothing was charged — try again, or tell an admin if it keeps happening."}
            </p>
            <Link to="/wallet/topup" className="inline-block mt-3"><Button variant="outline">Try again</Button></Link>
          </>
        )}

        {s.status === "Completed" && (
          <p className="mt-3 text-sm">Your wallet has been credited. <Link to="/wallet" className="text-accent-strong hover:underline">View wallet →</Link></p>
        )}
      </Card>
    </div>
  );
}
