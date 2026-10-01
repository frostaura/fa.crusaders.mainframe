import { Link } from "react-router-dom";
import type { LedgerRow } from "../lib/api";
import { cn } from "../lib/utils";
import { typography } from "../lib/typography";
import { PageHeader, PageShell, Section } from "../components/ui/page-shell";
import { Freshness, RefreshButton } from "../components/ui/refresh-button";
import { StateBlock } from "../components/ui/state-block";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Skeleton } from "../components/ui/skeleton";
import { Receipt } from "../components/ui/icons";
import { LedgerTable } from "../components/LedgerTable";
import type { ShareBookings } from "../components/wallet/useShareBookings";
import { useWalletLedger } from "../components/wallet/useWalletLedger";
import { StaleNotice } from "../components/shell/StaleNotice";
import { walletTone } from "../lib/balance";
import type { HeldFigures } from "../lib/liveBalance";
import { WALLET_PAGE_SIZE as PAGE_SIZE } from "../lib/offline/memberReads";
import { WalletNav } from "../components/wallet/WalletNav";
import { HeldLine } from "../components/wallet/HeldLine";
import { BALANCE_SENTENCE, BALANCE_TONE, LEDGER_CLOCK_NOTE, TOP_UP_LABEL } from "../lib/walletCopy";

/**
 * The figure, its sentence and the way to fix it — one component because they are one claim.
 *
 * <p>
 * Every branch in here forks on the SAME answer, `walletTone`, which is the whole point of
 * having one: the fill, the edge, the ink on the figure, the sentence under it and the top-up
 * control's own label and prominence all say the same thing about the same balance, and a
 * member reading a green card over "you can't book a court" is the disagreement that one rule
 * exists to make unrepresentable.
 * </p>
 *
 * <p>
 * The top-up control is navigation, so it is a link — drawn as the page's primary action
 * (`<Button asChild><Link/></Button>`, design-system.md: Buttons vs links). Primary when there is
 * nothing to play with: at zero it is the only thing on the page that does anything for them.
 * </p>
 */
function BalanceCard({ balance, painted, held }: { balance: number | null; painted: number | null; held: HeldFigures | null }) {
  const level = walletTone(balance);
  const tone = BALANCE_TONE[level];
  const edge = level === "zero" ? "border-danger-strong" : "border-warning-strong";
  return (
    <Card className={cn("px-4 sm:px-6", level !== "fine" && `${tone.fill} border-l-4 ${edge}`)}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className={typography({ variant: "overline" })}>Current balance</p>
          {/*
            `tabular-nums` so the count-up does not reflow the card on every frame, and the
            figure is painted from the tween rather than the target. `aria-live` is NOT on
            it: a number that re-renders sixty times a second inside a live region is sixty
            announcements. The toast is the announcement.
          */}
          <p className={cn(typography({ variant: "display" }), "mt-1 tabular-nums", level === "zero" && tone.ink)}>
            {(painted ?? 0).toFixed(2)} <span className="text-base font-medium tracking-normal text-text-secondary">credits</span>
          </p>
          <p className={cn("mt-2 max-w-prose text-sm", level === "fine" ? "text-text-secondary" : tone.ink)}>
            {BALANCE_SENTENCE[level]}
          </p>
          <HeldLine held={held} />
        </div>
        <Button asChild variant={level === "zero" ? "primary" : "secondary"} className="shrink-0">
          <Link to="/wallet/topup">{TOP_UP_LABEL[level]}</Link>
        </Button>
      </div>
    </Card>
  );
}

/** The wallet's layout while its first read is in flight: the balance card, then ledger rows. */
function WalletSkeleton() {
  return (
    <div className="flex flex-col gap-8">
      <Skeleton className="h-36 rounded-xl" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-6 w-32" />
        {[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-12" />)}
      </div>
    </div>
  );
}

/**
 * How much of the list is on screen, as a sentence rather than a number: "100" beside a list of
 * a hundred rows says nothing about whether there are more, and this page exists for the member
 * who is arguing about their balance, for whom "100 of 340 movements" is the difference between
 * believing the list and not.
 */
function countSentence(shown: number, total: number): string {
  if (shown < total) return `${shown} of ${total} movements`;
  return `${total} movement${total === 1 ? "" : "s"}`;
}

type LedgerProps = {
  rows: LedgerRow[];
  shareBookings: ShareBookings;
  total: number;
  busy: boolean;
  error: unknown;
  onOlder: () => void;
};

/** The ledger: every movement, newest first, a page at a time. */
function LedgerSection(props: LedgerProps) {
  // Destructured in the body: lizard counts every destructured name as a parameter (gate: 6).
  const { rows, shareBookings, total, busy, error, onOlder } = props;
  const shown = rows.length;
  return (
    <Section title="Ledger" description={countSentence(shown, total)}>
      {/* A re-read that failed keeps the rows it had, and says so above them. */}
      {error ? <StateBlock error={error} action="refresh the ledger" /> : null}
      {rows.length === 0 ? (
        <StateBlock
          empty
          emptyIcon={Receipt}
          emptyTitle="No movements yet"
          emptyHint="Top up, or wait for the club to credit you — every movement lands here."
        />
      ) : (
        <Card className="gap-0 overflow-hidden py-0 sm:gap-0 sm:py-0">
          <LedgerTable rows={rows} label="Wallet ledger" groupShares shareBookings={shareBookings} />
          {/* Said once under the list rather than on every row: every face on a member surface
              is the CLUB's day, which is right and otherwise invisible. */}
          <p className="border-t border-border px-4 py-3 text-xs text-text-muted sm:px-6">{LEDGER_CLOCK_NOTE}</p>
        </Card>
      )}
      {shown < total && (
        <Button variant="outline" block pending={busy} onClick={onOlder}>
          {`Show older (${total - shown} more)`}
        </Button>
      )}
    </Section>
  );
}

export default function WalletPage() {
  const { rows, shareBookings, cardBalance, total, busy, error, readAt, stale, balance, painted, load, held } = useWalletLedger();
  const loaded = rows !== null && cardBalance !== null;
  const shown = rows?.length ?? 0;
  const refresh = () => { void load(Math.max(shown, PAGE_SIZE)); };

  return (
    <PageShell>
      <PageHeader
        title="Wallet"
        description="Your credit, and every movement of it."
        actions={<RefreshButton onRefresh={refresh} loading={busy} />}
        freshness={<Freshness at={readAt} />}
      />
      <WalletNav />
      <StaleNotice stale={stale} readAt={readAt} />
      {/* A failed read is never "no movements yet" — that tells a member their history is gone. */}
      <StateBlock
        loading={!loaded}
        error={loaded ? null : error}
        action="load your wallet"
        onRetry={refresh}
        skeleton={<WalletSkeleton />}
        className="gap-8"
      >
        {loaded ? (
          <>
            <BalanceCard balance={balance} painted={painted} held={held} />
            <LedgerSection rows={rows} shareBookings={shareBookings} total={total} busy={busy} error={stale ? null : error} onOlder={() => void load(shown + PAGE_SIZE)} />
          </>
        ) : null}
      </StateBlock>
    </PageShell>
  );
}
