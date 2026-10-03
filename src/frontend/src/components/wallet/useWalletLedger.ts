import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { endpoints, type LedgerEntryType, type LedgerRow, type WalletResponse } from "@/lib/api";
import { useBalance } from "@/lib/balance";
import { heldFrom, type HeldFigures } from "@/lib/liveBalance";
import { memberReads, WALLET_PAGE_SIZE } from "@/lib/offline/memberReads";
import { fetchQuery, peekQuery, subscribeQuery } from "@/lib/offline/queryCache";
import { isConnectionFailure, JOIN_MS, useDataOwner } from "@/lib/offline/useCachedRead";
import { minutesArrivedSentence, minutesLeftSentence } from "@/lib/walletCopy";
import { useToast } from "../Toast";
import { shareBookingsFrom, type ShareBookings } from "./useShareBookings";
import { useBalanceMovement, useCountUp, useWalletLive } from "./useWalletLive";

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
export function useWalletLedger() {
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
    never again. So an admin adding minutes while the member watched showed one figure in the
    chip and another in the card underneath it, with no new row and no refresh control anywhere —
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

  // R4 wave B — the first page is kept by `lib/offline` for the member: drawn at once on a revisit
  // or a warm start, and from the phone with no signal (`stale`), until this page's read lands.
  const { who } = useDataOwner();
  const subscribeKept = useCallback((fn: () => void) => subscribeQuery(who, memberReads.wallet.key, fn), [who]);
  const peekKept = useCallback(() => peekQuery(who, memberReads.wallet.key), [who]);
  const kept = useSyncExternalStore(subscribeKept, peekKept, peekKept);
  const [stale, setStale] = useState(false);
  const firstRead = useRef(true);
  const [unreachable, setUnreachable] = useState(false);

  /** `join`: the page's first read may take the one a press on the Wallet tab started a moment ago (P4-5). */
  const load = useCallback(async (limit: number, join = false) => {
    setBusy(true);
    const issuedAt = Date.now();
    try {
      const data = limit === WALLET_PAGE_SIZE
        ? await fetchQuery(who, memberReads.wallet.key, memberReads.wallet.load, { reuseWithinMs: join ? JOIN_MS : 0 })
        : await endpoints.walletWithShareBookings(limit, 0);
      setStale(false);
      setUnreachable(false);
      setRows(data.entries);
      setShareBookings(shareBookingsFrom(data.share_bookings));
      setCardBalance(data.balance_minutes);
      setReadHeld(heldFrom(data));
      setTotal(data.total_entries);
      setError(null);
      setReadAt(Date.now());
      lastRead.current = data.balance_minutes;
      if ((confirmedAt.current ?? -Infinity) < issuedAt) apply(data.balance_minutes);
      return data.entries;
    } catch (err) {
      // The thrown value whole, so the failure sentence can say WHY and the retry can be
      // dropped for a fault the member cannot fix (`StateBlock`).
      setError(err ?? new Error("wallet read failed"));
      // Whatever is on screen stays, said as the last-known figures (offline, a 5xx, a 429 alike).
      setStale(true);
      setUnreachable(isConnectionFailure(err));
      return null;
    } finally {
      setBusy(false);
    }
  }, [apply, who]);

  useEffect(() => {
    // A live figure this page has just read (and handed over) is not news; re-reading it would
    // be a second identical round trip after every Refresh that moved the balance.
    if (live.balance !== null && lastRead.current !== null && live.balance === lastRead.current) return;
    // Fetch on mount, and re-read when the live balance moves.
    // Only the mount's read joins a link press's; a re-read after a balance move asks the club.
    void load(WALLET_PAGE_SIZE, firstRead.current);
    firstRead.current = false;
  }, [load, live.balance]);

  // R8 X8-2 — a visit that found no signal loads by itself when the phone finds one again.
  useEffect(() => {
    const again = () => { void load(WALLET_PAGE_SIZE); };
    window.addEventListener("online", again);
    return () => window.removeEventListener("online", again);
  }, [load]);

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
  if (rows === null && kept) {
    // Nothing read in this visit yet: the kept page, whole, with its "as of".
    return { ...fromKept(kept.value as WalletResponse, live.balance, liveHeld, countUp), busy, error, readAt: kept.at, stale, offline: unreachable, load };
  }
  return { rows, shareBookings, cardBalance, total, busy, error, readAt, stale: stale && rows !== null, offline: unreachable, balance, painted: countUp ?? balance, load, held };
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
 * the newest row that matches it says what it WAS. "The club added 3 h" would be
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
      // Minutes going out is not an error — spending your own minutes on a court you chose is
      // the product working — so it is `info`, and it is the quieter of the two.
      tone: rising ? "success" : "info",
      text: rising
        ? minutesArrivedSentence(delta.amount, match?.type ?? null, match?.actorName ?? null)
        : minutesLeftSentence(delta.amount, match?.type ?? null),
      durationMs: MONEY_TOAST_MS,
    });
  }, [delta, rows, toast]);
}

/** The page the phone kept, as the figures the card and ledger draw — the live figure still wins. */
function fromKept(page: WalletResponse, liveBalance: number | null, liveHeld: HeldFigures | null, countUp: number | null) {
  const balance = liveBalance ?? page.balance_minutes;
  return {
    rows: page.entries, shareBookings: shareBookingsFrom(page.share_bookings), cardBalance: page.balance_minutes,
    total: page.total_entries, balance, painted: countUp ?? balance, held: liveHeld ?? heldFrom(page),
  };
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
  const row = rows.find((r) => r.signedAmountMinutes === wanted);
  if (!row) return null;
  // An admin adding minutes is an actor who is not the subject. A purchase the member made
  // themselves has the member as both, and naming them back to themselves reads as a fault.
  const actor = row.actorUserId && row.actorUserId !== row.subjectUserId ? row.actorName : null;
  return { type: row.type, actorName: actor || null };
}
