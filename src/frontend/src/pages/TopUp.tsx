import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, endpoints } from "../lib/api";
import { Card } from "../components/Card";
import { Button, Input, Label } from "../components/Button";

// Blueprint A.3: top-ups in blocks of R100 to a max of R1000 for members.
const PRESETS = [100, 200, 500, 1000];
const MIN_ZAR = 100;
const MAX_ZAR = 1000;
const BLOCK_ZAR = 100;

// Conservative client-side preview rates. Backend re-resolves from tenant_settings + member class
// at callback time; this is just so the player sees "you'll receive ~N credits" before redirect.
const PREVIEW_RATE_REGULAR = 1.6;
const PREVIEW_RATE_LEAGUE = 2.4;

export default function TopUpPage() {
  const nav = useNavigate();
  const [amount, setAmount] = useState<string>("100");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [memberClass, setMemberClass] = useState<"Regular" | "LeagueOrSenior">("Regular");

  // Best-effort fetch of my member class for the conversion preview. If it fails, fall back to Regular.
  useEffect(() => {
    (async () => {
      try {
        const me = (await fetch("/api/v1/me/profile", { headers: { authorization: `Bearer ${localStorage.getItem("crusaders.mainframe.token") ?? ""}` } }));
        if (me.ok) {
          const json = await me.json();
          if (json?.member_class === "LeagueOrSenior") setMemberClass("LeagueOrSenior");
        }
      } catch { /* keep default */ }
    })();
  }, []);

  const numeric = parseFloat(amount);
  const validAmount = !isNaN(numeric) && numeric >= MIN_ZAR && numeric <= MAX_ZAR && numeric % BLOCK_ZAR === 0;
  const rate = memberClass === "LeagueOrSenior" ? PREVIEW_RATE_LEAGUE : PREVIEW_RATE_REGULAR;
  const creditsPreview = validAmount ? Math.round(numeric * rate) : 0;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (isNaN(numeric)) { setError("Enter an amount."); return; }
    if (numeric < MIN_ZAR || numeric > MAX_ZAR) { setError(`Amount must be between R${MIN_ZAR} and R${MAX_ZAR}.`); return; }
    if (numeric % BLOCK_ZAR !== 0) { setError(`Amount must be a multiple of R${BLOCK_ZAR}.`); return; }
    setLoading(true);
    try {
      const res = await endpoints.topupStart(numeric);
      window.location.href = res.redirect_url;
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 400) setError("Amount rejected by server — must be a multiple of R100 within R100–R1000.");
        else if (err.status === 503) setError("Payments aren't configured for this club yet — ask an admin.");
        else if (err.status === 502) setError("Payment provider rejected the request. Try again later.");
        else setError("Top-up failed.");
      } else setError("Network error.");
      setLoading(false);
    }
  };

  return (
    <div className="max-w-md mx-auto px-4">
      <Card>
        <h1 className="text-xl font-semibold mb-1">Top up</h1>
        <p className="text-sm text-text-secondary mb-5">Pay in ZAR via PayFast — your wallet is credited in <strong>credits</strong> at your member-class rate.</p>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <Label>Amount (ZAR)</Label>
            <div className="flex gap-2 mb-2 flex-wrap">
              {PRESETS.map((p) => (
                <Button key={p} type="button" variant={String(p) === amount ? "default" : "outline"} onClick={() => setAmount(String(p))}>
                  R{p}
                </Button>
              ))}
            </div>
            <Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="Custom amount (multiple of R100)" />
            <p className="text-xs text-text-muted mt-1">Min R{MIN_ZAR} · Max R{MAX_ZAR} · Multiples of R{BLOCK_ZAR} only</p>
          </div>

          {/* Conversion preview */}
          <div className="bg-bg-muted rounded-lg p-3 text-sm">
            <div className="flex items-baseline justify-between">
              <span className="text-text-secondary">You pay</span>
              <span className="font-semibold">R{validAmount ? numeric.toFixed(2) : "—"}</span>
            </div>
            <div className="flex items-baseline justify-between mt-1">
              <span className="text-text-secondary">You receive</span>
              <span className="font-semibold text-accent-strong">{validAmount ? creditsPreview : "—"} credits</span>
            </div>
            <p className="text-[11px] text-text-muted mt-2">
              At {rate.toFixed(2)} credits / R1 ({memberClass === "LeagueOrSenior" ? "league / senior rate" : "regular rate"}). Final rate is applied server-side from your tenant's settings.
            </p>
          </div>

          {error && <p className="text-sm text-danger-strong">{error}</p>}
          <Button type="submit" disabled={loading || !validAmount} className="w-full">{loading ? "Redirecting…" : "Continue to PayFast"}</Button>
          <Button type="button" variant="ghost" onClick={() => nav("/wallet")} className="w-full">Cancel</Button>
        </form>
      </Card>
    </div>
  );
}
