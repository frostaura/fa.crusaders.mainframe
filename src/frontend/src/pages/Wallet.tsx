import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { endpoints, type LedgerEntryType, type LedgerRow } from "../lib/api";
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
import { shareBookingsFrom, type ShareBookings } from "../components/wallet/useShareBookings";
import { useToast } from "../components/Toast";
import { useBalance, walletTone } from "../lib/balance";
import { heldFrom, type HeldFigures } from "../lib/liveBalance";
import { useBalanceMovement, useCountUp, useWalletLive } from "../components/wallet/useWalletLive";
import { WalletNav } from "../components/wallet/WalletNav";
import { HeldLine } from "../components/wallet/HeldLine";
import {
  BALANCE_SENTENCE, BALANCE_TONE, LEDGER_CLOCK_NOTE, TOP_UP_LABEL,
  creditArrivedSentence, creditLeftSentence,
} from "../lib/walletCopy";

/** One page of movements. Big enough that most members never press "Show older". */
const PAGE_SIZE = 100;

/**
 * Money deserves reading time. The default toast life is 4 000 ms; this is the one message on
 * the product that somebody may want to read twice, and it is dismissible by tap or Enter.
 */
const MONEY_TOAST_MS = 6_000;

/**
 * What the wallet page KNOWS: the ledger, the figure on the card, and the one announcement.
 *
 * <p>
 * <b>Extracted for the complexity gate, and the gate was right.</b> The page was twenty-five
 * branches, and the hard half was never the markup — it was three sources of one number (the
 * live stream, this page's own read, the tween between them), a movement measured against the
 * figure the card is actually painting, and a sentence read off the ledger row that caused it.
 * A reader checking the LAYOUT had to walk all of it first.
 * </p>
 *
 * <p>
 * A hook rather than a pure function because every one of those is a hook. What it buys is
 * that the component below only draws.
 * </p>
 */
function useWalletLedger() {
  const [rows, setRows] = useState<LedgerRow[] | null>(null);
  /** Each share row's booking, from the same read as the rows (`share_bookings`). */
  const [shareBookings, setShareBookings] = useState<ShareBookings>({});
  const [cardBalance, setCardBalance] = useState<number | null>(null);
  /** D11 §3a — what this page's own read said is held; the live stream's figure wins. */
  const [readHeld, setReadHeld] = useState<HeldFigures | null>(null);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  /** When the ledger on screen was read — the header's "Updated 12s ago". */
  const [readAt, setReadAt] = useState<number | null>(null);
  const toast = useToast();

  /*
    The header chip follows the live wallet stream; this page used to fetch once on mount and
    never again. So an admin crediting a member while they watched showed 517.01 in the chip
    and 510.01 in the card underneath it, with no +7.00 row and no refresh control anywhere —
    on the screen a member opens when they are arguing about their balance. Following the same
    signal is what keeps the two from disagreeing.

    Item 8 is the other half of that: following it silently is not the same as the member
    NOTICING. See `announce` below.
  */
  /*
    The LIVE figure wins over the one this page fetched, and falls back to it. The stream is
    ahead of a page read by design — that is the whole of item 8 — and a card showing the
    older of two figures it holds is the disagreement this page was fixed for once already.
  */
  const live = useWalletLive();

  /*
    ...and "live wins" is only true while the live figure is the NEWER one. It is not always:
    a stream that has gone quiet (degraded, parked, or one frame lost) leaves the provider on a
    figure it confirmed earlier, and the member presses Refresh precisely because the list looks
    wrong. The page then held 517.01 and the +7.00 row, and painted 510.01 above them — the
    two-numbers defect, on the one button that exists to end it. So a page read issued AFTER the
    provider last confirmed its figure is handed to the provider (`apply`: the server's own
    figure, marked as this tab's doing so the chip does not announce what this page will). A read
    issued BEFORE that confirmation may be the older of the two and is left alone — the frame
    that overtook it has already asked for a fresh read below.
  */
  const { apply, lastConfirmedAt, held: liveHeld } = useBalance();
  const confirmedAt = useRef(lastConfirmedAt);
  useEffect(() => { confirmedAt.current = lastConfirmedAt; }, [lastConfirmedAt]);
  /** The figure this page last read, so the provider taking it does not trigger a re-read of it. */
  const lastRead = useRef<number | null>(null);

  const load = useCallback(async (limit: number) => {
    setBusy(true);
    const issuedAt = Date.now();
    try {
      const data = await endpoints.walletWithShareBookings(limit, 0);
      setRows(data.entries);
      setShareBookings(shareBookingsFrom(data.share_bookings));
      setCardBalance(data.balance_credits);
      setReadHeld(heldFrom(data));
      setTotal(data.total_entries);
      setError(null);
      setReadAt(Date.now());
      lastRead.current = data.balance_credits;
      if ((confirmedAt.current ?? -Infinity) < issuedAt) apply(data.balance_credits);
      return data.entries;
    } catch (err) {
      // The thrown value whole, so the failure sentence can say WHY and the retry can be
      // dropped for a fault the member cannot fix (`StateBlock`).
      setError(err ?? new Error("wallet read failed"));
      return null;
    } finally {
      setBusy(false);
    }
  }, [apply]);

  useEffect(() => {
    // A live figure this page has just read (and handed over) is not news; re-reading it would
    // be a second identical round trip after every Refresh that moved the balance.
    if (live.balance !== null && lastRead.current !== null && Math.abs(live.balance - lastRead.current) < 0.005) return;
    // Fetch on mount, and re-read when the live balance moves.
    void load(PAGE_SIZE);
  }, [load, live.balance]);

  /*
    The figure the CARD is painting is what movement is measured against, not the stream's
    alone — see `useBalanceMovement`. `load` sets the rows and the figure in one batch, so by
    the time a movement is reported the row that caused it is already in hand.
  */
  const balance = live.balance ?? cardBalance;
  const delta = useBalanceMovement(balance);
  /** The tweened figure the card paints. Snaps under reduced motion — see `useCountUp`. */
  const countUp = useCountUp(balance);
  useMoneyAnnouncement(delta, rows, toast);

  const held = liveHeld ?? readHeld;
  return { rows, shareBookings, cardBalance, total, busy, error, readAt, balance, painted: countUp ?? balance, load, held };
}

/**
 * <b>The one announcement, and it is the accessibility requirement rather than decoration.</b>
 *
 * <p>
 * A figure re-rendering in a card is not a live region and no screen reader will read it, so
 * without this a blind member is never told the club paid them. The toast carries
 * `role="status"` per instance and the viewport deliberately carries none, so this is exactly
 * one announcement — the defect that file records having paid for twice.
 * </p>
 *
 * <p>
 * <b>What it says is read off the ledger, never assumed.</b> The delta says how much moved;
 * the newest row that matches it says what it WAS. "The club added 200 credits" would be
 * false if a partner had cancelled a court in another tab, and this page cannot tell those
 * apart except by looking at the row.
 * </p>
 */
function useMoneyAnnouncement(
  delta: ReturnType<typeof useBalanceMovement>,
  rows: LedgerRow[] | null,
  toast: ReturnType<typeof useToast>,
) {
  const announced = useRef<number>(0);
  useEffect(() => {
    if (!delta || delta.at === announced.current) return;
    announced.current = delta.at;
    const match = matchingRow(rows, delta.amount, delta.direction);
    const rising = delta.direction === "up";
    toast.push({
      // Money going out is not an error — spending your own credit on a court you chose is
      // the product working — so it is `info`, and it is the quieter of the two.
      tone: rising ? "success" : "info",
      text: rising
        ? creditArrivedSentence(delta.amount, match?.type ?? null, match?.actorName ?? null)
        : creditLeftSentence(delta.amount, match?.type ?? null),
      durationMs: MONEY_TOAST_MS,
    });
  }, [delta, rows, toast]);
}

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
  const { rows, shareBookings, cardBalance, total, busy, error, readAt, balance, painted, load, held } = useWalletLedger();
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
            <LedgerSection rows={rows} shareBookings={shareBookings} total={total} busy={busy} error={error} onOlder={() => void load(shown + PAGE_SIZE)} />
          </>
        ) : null}
      </StateBlock>
    </PageShell>
  );
}

/**
 * The newest row whose signed amount is the movement we are announcing.
 *
 * <p>
 * Matched on the amount and the direction rather than on the newest row outright, because the
 * newest row is not necessarily the one that moved the balance: a page that refetches after a
 * stream tick can land a read that already contains a later charge. No match is a real answer
 * — the copy then uses the neutral sentence, which is true whoever caused it.
 * </p>
 */
function matchingRow(
  rows: LedgerRow[] | null,
  amount: number,
  direction: "up" | "down",
): { type: LedgerEntryType; actorName: string | null } | null {
  if (!rows) return null;
  const wanted = direction === "up" ? amount : -amount;
  const row = rows.find((r) => Math.abs(r.signedAmountCredits - wanted) < 0.005);
  if (!row) return null;
  // An admin crediting somebody is an actor who is not the subject. A top-up the member made
  // themselves has the member as both, and naming them back to themselves reads as a fault.
  const actor = row.actorUserId && row.actorUserId !== row.subjectUserId ? row.actorName : null;
  return { type: row.type, actorName: actor || null };
}
