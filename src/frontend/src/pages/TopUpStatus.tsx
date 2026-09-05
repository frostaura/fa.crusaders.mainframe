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

export default function TopUpStatusPage() {
  const { topupId } = useParams<{ topupId: string }>();
  const [s, setS] = useState<TopUpStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { refresh: refreshBalance } = useBalance();
  const refreshedOnce = useRef(false);

  useEffect(() => {
    if (!topupId) return;
    let cancelled = false;
    let attempts = 0;
    const tick = async () => {
      try {
        const snap = await endpoints.topupStatus(topupId);
        if (cancelled) return;
        setS(snap);
        if (snap.status === "Completed" && !refreshedOnce.current) {
          refreshedOnce.current = true;
          refreshBalance();
        }
        attempts++;
        if (snap.status === "Pending" && attempts < 30) setTimeout(tick, 2000);
      } catch { if (!cancelled) setError("Couldn't load top-up status."); }
    };
    tick();
    return () => { cancelled = true; };
  }, [topupId, refreshBalance]);

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

        {s.status === "Pending" && <p className="mt-3 text-sm text-text-secondary">Waiting for confirmation from PayFast…</p>}

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
