import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { endpoints } from "../lib/api";
import { Card } from "../components/Card";
import { Badge } from "../components/Button";
import { useBalance } from "../lib/balance";

type Snapshot = { id: string; status: string; amount_zar: number; failure_reason: string | null };

export default function TopUpStatusPage() {
  const { topupId } = useParams<{ topupId: string }>();
  const [s, setS] = useState<Snapshot | null>(null);
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

  return (
    <div className="max-w-md mx-auto">
      <Card>
        <h1 className="text-xl font-semibold mb-2">Top-up</h1>
        <p className="text-sm text-text-secondary mb-3">R{s.amount_zar.toFixed(2)}</p>
        <Badge tone={s.status === "Completed" ? "success" : s.status === "Failed" ? "danger" : "info"}>{s.status}</Badge>
        {s.status === "Pending" && <p className="mt-3 text-sm text-text-secondary">Waiting for confirmation from PayFast…</p>}
        {s.status === "Failed" && s.failure_reason && <p className="mt-3 text-sm text-danger-strong">{s.failure_reason}</p>}
        {s.status === "Completed" && (
          <p className="mt-3 text-sm">Your wallet has been credited. <Link to="/wallet" className="text-accent-strong hover:underline">View wallet →</Link></p>
        )}
      </Card>
    </div>
  );
}
