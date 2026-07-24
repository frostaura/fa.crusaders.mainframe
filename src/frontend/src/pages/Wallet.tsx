import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { endpoints, type WalletResponse } from "../lib/api";
import { Card } from "../components/Card";
import { Button } from "../components/Button";
import { LedgerTable } from "../components/LedgerTable";

export default function WalletPage() {
  const [data, setData] = useState<WalletResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    endpoints.wallet().then(setData).catch(() => setError("Couldn't load wallet."));
  }, []);

  if (error) return <Card><p className="text-sm text-danger-strong">{error}</p></Card>;
  if (!data) return <Card>Loading…</Card>;

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-6">
      <Card>
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm text-text-secondary">Current balance</p>
            <p className="text-3xl font-semibold">{data.balance_zar.toFixed(2)} <span className="text-base font-normal text-text-secondary">credits</span></p>
            <p className="text-xs text-text-muted mt-1">Credits are the unit of account for bookings. Top up in rand → receive credits at your member-class rate.</p>
          </div>
          <Link to="/wallet/topup"><Button>Top up</Button></Link>
        </div>
      </Card>

      <Card className="!p-0 flex flex-col flex-1 min-h-0">
        <div className="px-4 sm:px-6 pt-4 pb-2 flex items-baseline justify-between shrink-0">
          <h2 className="text-lg font-medium">Ledger</h2>
          <span className="text-xs text-text-muted">{data.entries.length} movement{data.entries.length === 1 ? "" : "s"}</span>
        </div>
        {data.entries.length === 0 ? (
          <p className="px-4 sm:px-6 pb-4 text-sm text-text-secondary">No movements yet. Top up or wait for an admin credit.</p>
        ) : (
          <LedgerTable rows={data.entries} fill />
        )}
      </Card>
    </div>
  );
}
