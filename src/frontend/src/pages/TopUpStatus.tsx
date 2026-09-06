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
  const [error, setError] = useState<string | null>(null);
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
        setError(null);
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
        setError("Couldn't load top-up status.");
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

  if (error) return <Card><p className="text-sm text-danger-strong">{error}</p></Card>;
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
