import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import { endpoints, type LedgerEntryType, type LedgerRow } from "../lib/api";
import { Card } from "../components/Card";
import { Button } from "../components/Button";
import { LedgerTable } from "../components/LedgerTable";
import { useToast } from "../components/Toast";
import { useBalance, walletTone } from "../lib/balance";
import { useBalanceMovement, useCountUp, useWalletLive } from "../components/wallet/useWalletLive";
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
  const [cardBalance, setCardBalance] = useState<number | null>(null);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
  const { apply, lastConfirmedAt } = useBalance();
  const confirmedAt = useRef(lastConfirmedAt);
  useEffect(() => { confirmedAt.current = lastConfirmedAt; }, [lastConfirmedAt]);
  /** The figure this page last read, so the provider taking it does not trigger a re-read of it. */
  const lastRead = useRef<number | null>(null);

  const load = useCallback(async (limit: number) => {
    setBusy(true);
    const issuedAt = Date.now();
    try {
      const data = await endpoints.wallet(limit, 0);
      setRows(data.entries);
      setCardBalance(data.balance_credits);
      setTotal(data.total_entries);
      setError(null);
      lastRead.current = data.balance_credits;
      if ((confirmedAt.current ?? -Infinity) < issuedAt) apply(data.balance_credits);
      return data.entries;
    } catch {
      setError("Couldn't load wallet.");
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

  return { rows, cardBalance, total, busy, error, balance, painted: countUp ?? balance, load };
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
 * having one: the fill, the left border, the ink on the figure, the sentence under it and
 * the top-up button's own label and prominence all say the same thing about the same balance,
 * and a member reading a green card over "you can't book a court" is the disagreement that
 * one rule exists to make unrepresentable.
 * </p>
 */
function BalanceCard({ balance, painted }: { balance: number | null; painted: number | null }) {
  const level = walletTone(balance);
  const tone = BALANCE_TONE[level];
  const edge = level === "zero" ? "border-danger-strong" : "border-warning-strong";
  return (
    <Card className={level === "fine" ? undefined : `${tone.fill} border-l-4 ${edge}`}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm text-text-secondary">Current balance</p>
          {/*
            `tabular-nums` so the count-up does not reflow the card on every frame, and the
            figure is painted from the tween rather than the target. `aria-live` is NOT on
            it: a number that re-renders sixty times a second inside a live region is sixty
            announcements. The toast is the announcement.
          */}
          <p className={`text-3xl font-semibold tabular-nums ${level === "zero" ? tone.ink : ""}`}>
            {(painted ?? 0).toFixed(2)} <span className="text-base font-normal text-text-secondary">credits</span>
          </p>
          <p className={`text-xs mt-1 ${level === "fine" ? "text-text-muted" : tone.ink}`}>
            {BALANCE_SENTENCE[level]}
          </p>
        </div>
        <Link to="/wallet/topup" className="shrink-0">
          {/* Primary when there is nothing to play with: at zero this is the only control on
              the page that does anything for the member. */}
          <Button variant={level === "zero" ? "primary" : "default"}>{TOP_UP_LABEL[level]}</Button>
        </Link>
      </div>
    </Card>
  );
}

/**
 * The ledger's own heading row: how much of the list is on screen, and the way to re-read it.
 *
 * <p>
 * The count is a sentence rather than a number because "100" beside a list of a hundred rows
 * says nothing about whether there are more — and this page exists for the member who is
 * arguing about their balance, for whom "100 of 340 movements" is the difference between
 * believing the list and not.
 * </p>
 */
function LedgerHeader({ shown, total, busy, onRefresh }: {
  shown: number; total: number; busy: boolean; onRefresh: () => void;
}) {
  const plural = total === 1 ? "" : "s";
  return (
    <div className="px-4 sm:px-6 pt-4 pb-2 flex items-center justify-between gap-3 shrink-0">
      <h2 className="text-lg font-medium">Ledger</h2>
      <div className="flex items-center gap-3">
        <span className="text-xs text-text-muted">
          {shown < total ? `${shown} of ${total} movements` : `${total} movement${plural}`}
        </span>
        <Button variant="ghost" type="button" aria-label="Refresh" disabled={busy} onClick={onRefresh}>
          <RefreshCw size={14} className={busy ? "animate-spin motion-reduce:animate-none" : undefined} />
        </Button>
      </div>
    </div>
  );
}

export default function WalletPage() {
  const { rows, cardBalance, total, busy, error, balance, painted, load } = useWalletLedger();

  if (error && rows === null) return <Card><p className="text-sm text-danger-strong">{error}</p></Card>;
  if (rows === null || cardBalance === null) return <Card>Loading…</Card>;

  const shown = rows.length;

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-6">
      <BalanceCard balance={balance} painted={painted} />

      <Card className="!p-0 flex flex-col flex-1 min-h-0">
        <LedgerHeader shown={shown} total={total} busy={busy} onRefresh={() => load(Math.max(shown, PAGE_SIZE))} />
        {error && <p className="px-4 sm:px-6 pb-2 text-xs text-danger-strong">{error}</p>}
        {rows.length === 0 ? (
          <p className="px-4 sm:px-6 pb-4 text-sm text-text-secondary">No movements yet. Top up or wait for an admin credit.</p>
        ) : (
          <>
            <LedgerTable rows={rows} fill label="Wallet ledger" />
            {/* Said once under the list rather than on every row — the same rule the member's
                own door history follows, and for the same reason: every face on a member
                surface is the CLUB's day, which is right and otherwise invisible. */}
            <p className="px-4 sm:px-6 py-2 text-xs text-text-muted shrink-0">{LEDGER_CLOCK_NOTE}</p>
          </>
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
