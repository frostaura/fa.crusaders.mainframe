import { endpoints, type WalletReport } from "@/lib/api";
import { cn } from "@/lib/utils";
import { MinutesFigure } from "./MinutesFigure";
import { typography } from "@/lib/typography";
import { WALLET_MINI_COPY as COPY } from "@/lib/walletCopy";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { TextLink } from "../ui/text-link";
import { presetRange, useReport } from "../reports/range";

const readLast30 = (markers: { from: string; to: string }): Promise<WalletReport> => endpoints.reportWallet(markers.from, markers.to);

/**
 * The last 30 days under the balance, in the desktop rail (R5 M5-9, SPEC 3.4): what came in, what
 * went out and the net — the question a member asks of a balance ("where did it go?") answered
 * beside it, with the way to the whole story.
 *
 * <p>
 * Three states, never collapsed: a skeleton while it is read; on a failed read a line that says
 * so (offline, that it needs a connection) and a retry — never three zeros, which would say the
 * member did nothing for a month.
 * </p>
 */
export function WalletMiniTotals({ offline = false }: { offline?: boolean }) {
  const report = useReport(presetRange("last30"), readLast30);
  const data = report.data;
  return (
    <section aria-label={COPY.title} data-wallet-mini="" className="flex flex-col gap-3 rounded-xl border border-border bg-bg-surface p-4">
      <h2 className={typography({ variant: "overline" })}>{COPY.title}</h2>
      {data ? <Figures data={data} /> : report.error ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm text-text-secondary">{offline ? COPY.offline : COPY.failed}</p>
          <Button variant="outline" size="sm" pending={report.loading} onClick={report.refresh}>{COPY.retry}</Button>
        </div>
      ) : (
        <div role="status" aria-label={`${COPY.title}: reading`} className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-5 w-full" />)}
        </div>
      )}
      <TextLink to="/wallet/activity" className="self-start text-sm">{COPY.more}</TextLink>
    </section>
  );
}

function Figures({ data }: { data: WalletReport }) {
  const rows = [
    { label: COPY.topUps, value: data.top_ups_minutes, tone: data.top_ups_minutes > 0 ? "text-success-strong" : "text-text-primary" },
    { label: COPY.spent, value: -data.spent_minutes, tone: "text-text-primary" },
    { label: COPY.net, value: data.net_movement_minutes, tone: "text-text-primary" },
  ];
  return (
    <dl className="flex flex-col gap-1.5 text-sm">
      {rows.map((row) => (
        // A figure beside its label wraps UNDER it at large text, never squeezes it (gotchas-frontend-layout).
        <div key={row.label} className="flex flex-wrap items-baseline justify-between gap-x-3">
          <dt className="text-text-secondary">{row.label}</dt>
          <dd className={cn("ml-auto whitespace-nowrap font-semibold tabular-nums", row.tone)}><MinutesFigure value={row.value} signed /></dd>
        </div>
      ))}
    </dl>
  );
}

