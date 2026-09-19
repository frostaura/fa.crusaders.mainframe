import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import { endpoints, type LedgerRow } from "../lib/api";
import { Card } from "../components/Card";
import { Button } from "../components/Button";
import { LedgerTable } from "../components/LedgerTable";
import { useBalance } from "../lib/balance";

/** One page of movements. Big enough that most members never press "Show older". */
const PAGE_SIZE = 100;

export default function WalletPage() {
  const [rows, setRows] = useState<LedgerRow[] | null>(null);
  const [cardBalance, setCardBalance] = useState<number | null>(null);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The header chip follows the live wallet stream; this page used to fetch once on mount
  // and never again. So an admin crediting a member while they watched showed 517.01 in the
  // chip and 510.01 in the card underneath it, with no +7.00 row and no refresh control
  // anywhere — on the screen a member opens when they are arguing about their balance.
  // Following the same signal is what keeps the two from disagreeing.
  const { balance: liveBalance } = useBalance();

  const load = useCallback(async (limit: number) => {
    setBusy(true);
    try {
      const data = await endpoints.wallet(limit, 0);
      setRows(data.entries);
      setCardBalance(data.balance_credits);
      setTotal(data.total_entries);
      setError(null);
    } catch {
      setError("Couldn't load wallet.");
    } finally {
      setBusy(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount + refetch when the live balance moves; the loader sets its flag synchronously
  useEffect(() => { load(PAGE_SIZE); }, [load, liveBalance]);

  if (error && rows === null) return <Card><p className="text-sm text-danger-strong">{error}</p></Card>;
  if (rows === null || cardBalance === null) return <Card>Loading…</Card>;

  const shown = rows.length;

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-6">
      <Card>
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm text-text-secondary">Current balance</p>
            <p className="text-3xl font-semibold">{cardBalance.toFixed(2)} <span className="text-base font-normal text-text-secondary">credits</span></p>
            <p className="text-xs text-text-muted mt-1">Credits are the unit of account for bookings. Top up in rand → receive credits at your member-class rate.</p>
          </div>
          <Link to="/wallet/topup"><Button>Top up</Button></Link>
        </div>
      </Card>

      <Card className="!p-0 flex flex-col flex-1 min-h-0">
        <div className="px-4 sm:px-6 pt-4 pb-2 flex items-center justify-between gap-3 shrink-0">
          <h2 className="text-lg font-medium">Ledger</h2>
          <div className="flex items-center gap-3">
            <span className="text-xs text-text-muted">
              {shown < total ? `${shown} of ${total} movements` : `${total} movement${total === 1 ? "" : "s"}`}
            </span>
            <Button
              variant="ghost"
              type="button"
              aria-label="Refresh"
              disabled={busy}
              onClick={() => load(Math.max(shown, PAGE_SIZE))}
            >
              <RefreshCw size={14} className={busy ? "animate-spin" : undefined} />
            </Button>
          </div>
        </div>
        {error && <p className="px-4 sm:px-6 pb-2 text-xs text-danger-strong">{error}</p>}
        {rows.length === 0 ? (
          <p className="px-4 sm:px-6 pb-4 text-sm text-text-secondary">No movements yet. Top up or wait for an admin credit.</p>
        ) : (
          <LedgerTable rows={rows} fill label="Wallet ledger" />
        )}
        {shown < total && (
          <div className="px-4 sm:px-6 py-3 shrink-0 border-t border-border">
            <Button variant="outline" type="button" disabled={busy} className="w-full" onClick={() => load(shown + PAGE_SIZE)}>
              {busy ? "Loading…" : `Show older (${total - shown} more)`}
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
