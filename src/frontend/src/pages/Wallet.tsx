import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import { endpoints, type LedgerEntryType, type LedgerRow } from "../lib/api";
import { Card } from "../components/Card";
import { Button } from "../components/Button";
import { LedgerTable } from "../components/LedgerTable";
import { useToast } from "../components/Toast";
import { LOW_BALANCE_CREDITS } from "../lib/balance";
import { useBalanceMovement, useCountUp, useWalletLive } from "../components/wallet/useWalletLive";
import {
  BALANCE_SENTENCE, BALANCE_TONE, LEDGER_CLOCK_NOTE, TOP_UP_LABEL,
  balanceLevel, creditArrivedSentence, creditLeftSentence,
} from "../lib/walletCopy";

/** One page of movements. Big enough that most members never press "Show older". */
const PAGE_SIZE = 100;

/**
 * Money deserves reading time. The default toast life is 4 000 ms; this is the one message on
 * the product that somebody may want to read twice, and it is dismissible by tap or Enter.
 */
const MONEY_TOAST_MS = 6_000;

export default function WalletPage() {
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

  const load = useCallback(async (limit: number) => {
    setBusy(true);
    try {
      const data = await endpoints.wallet(limit, 0);
      setRows(data.entries);
      setCardBalance(data.balance_credits);
      setTotal(data.total_entries);
      setError(null);
      return data.entries;
    } catch {
      setError("Couldn't load wallet.");
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount + refetch when the live balance moves; the loader sets its flag synchronously
  useEffect(() => { load(PAGE_SIZE); }, [load, live.balance]);

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
  /*
    The figure the CARD is painting is what movement is measured against, not the stream's
    alone — see `useBalanceMovement`. `load` sets the rows and the figure in one batch, so by
    the time a movement is reported the row that caused it is already in hand.
  */
  const balance = live.balance ?? cardBalance;
  const delta = useBalanceMovement(balance);
  /** The tweened figure the card paints. Snaps under reduced motion — see `useCountUp`. */
  const countUp = useCountUp(balance);
  const announced = useRef<number>(0);
  useEffect(() => {
    if (!delta || delta.at === announced.current) return;
    announced.current = delta.at;
    const match = matchingRow(rows, delta.amount, delta.direction);
    toast.push({
      // Money going out is not an error — spending your own credit on a court you chose is
      // the product working — so it is `info`, and it is the quieter of the two.
      tone: delta.direction === "up" ? "success" : "info",
      text: delta.direction === "up"
        ? creditArrivedSentence(delta.amount, match?.type ?? null, match?.actorName ?? null)
        : creditLeftSentence(delta.amount, match?.type ?? null),
      durationMs: MONEY_TOAST_MS,
    });
  }, [delta, rows, toast]);

  if (error && rows === null) return <Card><p className="text-sm text-danger-strong">{error}</p></Card>;
  if (rows === null || cardBalance === null) return <Card>Loading…</Card>;

  const shown = rows.length;
  const painted = countUp ?? balance;
  const level = balanceLevel(balance, LOW_BALANCE_CREDITS);
  const tone = BALANCE_TONE[level];

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-6">
      <Card className={level === "fine" ? undefined : `${tone.fill} border-l-4 ${level === "empty" ? "border-danger-strong" : "border-warning-strong"}`}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm text-text-secondary">Current balance</p>
            {/*
              `tabular-nums` so the count-up does not reflow the card on every frame, and the
              figure is painted from the tween rather than the target. `aria-live` is NOT on
              it: a number that re-renders sixty times a second inside a live region is sixty
              announcements. The toast is the announcement.
            */}
            <p className={`text-3xl font-semibold tabular-nums ${level === "empty" ? tone.ink : ""}`}>
              {(painted ?? 0).toFixed(2)} <span className="text-base font-normal text-text-secondary">credits</span>
            </p>
            <p className={`text-xs mt-1 ${level === "fine" ? "text-text-muted" : tone.ink}`}>
              {BALANCE_SENTENCE[level]}
            </p>
          </div>
          <Link to="/wallet/topup" className="shrink-0">
            {/* Primary when there is nothing to play with: at zero this is the only control on
                the page that does anything for the member. */}
            <Button variant={level === "empty" ? "primary" : "default"}>{TOP_UP_LABEL[level]}</Button>
          </Link>
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
              <RefreshCw size={14} className={busy ? "animate-spin motion-reduce:animate-none" : undefined} />
            </Button>
          </div>
        </div>
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
