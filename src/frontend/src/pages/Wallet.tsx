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
import { OfflineNothingKept } from "../lib/offline/OfflineNothingKept";
import { StillTrying } from "../lib/offline/StillTrying";
import { OFFLINE_COPY } from "../lib/offline/offlineCopy";
import { BUY_MINUTES_PATH } from "../lib/minutes";
import { MinutesFigure } from "../components/wallet/MinutesFigure";
import { keepFiguresWhole } from "../components/ui/figure-text";
import type { HeldFigures } from "../lib/liveBalance";
import { WALLET_PAGE_SIZE as PAGE_SIZE } from "../lib/offline/memberReads";
import { WalletNav } from "../components/wallet/WalletNav";
import { HeldLine } from "../components/wallet/HeldLine";
import {
  BALANCE_TONE, LEDGER_CLOCK_NOTE, SHORT_TONE, TOP_UP_LABEL, WALLET_LAYOUT, balanceSentence, cardLevel, memberLedgerRows, showOlderLabel,
  type BalanceLevel, type CardLevel,
} from "../lib/walletCopy";
import { useSmallestSlot } from "../components/wallet/useSmallestSlot";
import { ContextBar } from "../components/ui/context-bar";
import { useMediaQuery } from "../components/ui/use-media-query";
import { WithAside } from "../components/ui/with-aside";
import { WalletMiniTotals } from "../components/wallet/WalletMiniTotals";
import { usePagedFocus } from "../lib/usePagedFocus";

/**
 * The figure, its sentence and the way to fix it — one component because they are one claim.
 *
 * <p>
 * Every branch in here forks on the SAME answer, `walletTone`, which is the whole point of
 * having one: the fill, the edge, the ink on the figure, the sentence under it and the buy
 * control's own label and prominence all say the same thing about the same balance, and a
 * member reading a green card over "you can't book a court" is the disagreement that one rule
 * exists to make unrepresentable.
 * </p>
 *
 * <p>
 * The buy control is navigation, so it is a link — drawn as the page's primary action
 * (`<Button asChild><Link/></Button>`, design-system.md: Buttons vs links). It is drawn here only
 * in the desktop rail, and there it is PRIMARY beside the figure whatever the balance (R5 M5-9,
 * SPEC 3.4): a soft secondary next to the number read as an afterthought, while the phone's docked
 * button was primary — one verb, one weight, wherever it is drawn.
 * </p>
 */
/** The longest slice a club may set (settings: 5–240): above it every spendable figure books something. */
const LONGEST_SLICE = 240;

type CardState = { level: CardLevel; spendable: number | null; slot: number | null };

/**
 * R10 J10-3: what the member can SPEND decides the card's state (the chip's figure), and whether
 * that reaches the club's shortest court; the big figure stays the whole balance. One answer for
 * the card and the docked Buy button alike.
 */
function useCardState(balance: number | null, held: HeldFigures | null): CardState {
  const spendable = held ? held.spendable : balance;
  const slot = useSmallestSlot(spendable !== null && spendable >= 1 && spendable < LONGEST_SLICE);
  return { level: cardLevel(spendable, slot), spendable, slot };
}

function BalanceCard(props: { state: CardState; painted: number | null; held: HeldFigures | null; topUp?: boolean }) {
  const { state, painted, held, topUp = true } = props;
  const { level, spendable, slot } = state;
  const tone = level === "short" ? SHORT_TONE : BALANCE_TONE[level];
  const edge = level === "zero" ? "border-danger-strong" : "border-warning-strong";
  return (
    <Card data-balance-level={level} className={cn("px-4 sm:px-6", level !== "fine" && `${tone.fill} border-l-4 ${edge}`)}>
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
            {/*
              Whole minutes in the one compact form ("7 h 30 min"), spoken in full (P13 §7.1). R19
              L19-3 — each figure glued to its unit: at large text the line may break between the
              hours and the minutes ("9 h / 10 min"), never inside one ("9 h 10 / min").
            */}
            <span className={cn("tabular-nums", Math.trunc(painted ?? 0) < 0 && "text-danger-strong", level === "zero" && tone.ink)}>
              <MinutesFigure value={painted ?? 0} />
            </span>
          </p>
          <p data-balance-sentence="" className={cn("mt-2 max-w-prose text-sm", level === "fine" ? "text-text-secondary" : tone.ink)}>
            {/* R19 L19-3 — "15 minutes" is one piece when the sentence wraps. */}
            {keepFiguresWhole(balanceSentence(level, spendable, slot))}
          </p>
          <HeldLine held={held} />
        </div>
        {topUp ? <TopUpLink level={level} primary /> : null}
      </div>
    </Card>
  );
}

/**
 * The buy control. Navigation, so a link drawn as the page's primary action
 * (`<Button asChild><Link/></Button>`). Primary when there is nothing to play with; on a phone it is
 * docked in thumb reach (R4 form factor, SPEC 3.4) and primary there whatever the balance.
 */
function TopUpLink({ level, primary = false, block = false }: { level: CardLevel; primary?: boolean; block?: boolean }) {
  // `short` cannot book either: its errand is the empty wallet's (R10 J10-3).
  const errand: BalanceLevel = level === "short" ? "zero" : level;
  return (
    <Button asChild block={block} variant={primary || errand === "zero" ? "primary" : "secondary"} className="shrink-0">
      <Link to={BUY_MINUTES_PATH}>{TOP_UP_LABEL[errand]}</Link>
    </Button>
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
          emptyHint="Buy minutes, or wait for the club to add some — every movement lands here."
        />
      ) : (
        // `overflow-clip`, not `-hidden`: a hidden overflow is a scroll container, and the ledger's
        // column heads would stick to the card (which never scrolls) instead of the page (R5 V5-6).
        // R16 L16-1: a clip cuts a ring all the same — the sort buttons sit 2px under its edge — so
        // every ring inside it is drawn inside its control.
        <Card className="gap-0 overflow-clip py-0 sm:gap-0 sm:py-0 [&_:focus-visible]:-outline-offset-2">
          <LedgerTable rows={memberLedgerRows(rows)} label="Wallet ledger" groupShares shareBookings={shareBookings} />
          {/* Said once under the list rather than on every row: every face on a member surface
              is the CLUB's day, which is right and otherwise invisible. */}
          <p className="border-t border-border px-4 py-3 text-xs text-text-muted sm:px-6">{LEDGER_CLOCK_NOTE}</p>
        </Card>
      )}
      {shown < total && (
        <Button variant="outline" block pending={busy} onClick={onOlder}>
          {showOlderLabel(total - shown)}
        </Button>
      )}
    </Section>
  );
}

/**
 * Where the first read is, with nothing on screen yet: still waiting (R9 X9-6's slow line), failed
 * for want of a connection (R8 X8-2), or neither. Out of `WalletPage` for lizard's CCN gate.
 */
function firstRead(loaded: boolean, error: unknown, offline: boolean): "trying" | "offline" | null {
  if (loaded) return null;
  if (error === null) return "trying";
  return offline ? "offline" : null;
}

export default function WalletPage() {
  const { rows, shareBookings, cardBalance, total, busy, error, readAt, stale, offline, balance, painted, load, held } = useWalletLedger();
  const loaded = rows !== null && cardBalance !== null;
  const shown = rows?.length ?? 0;
  const refresh = () => { void load(Math.max(shown, PAGE_SIZE)); };
  // One buy button, in one place: beside the figure from lg, docked in thumb reach below it.
  const wide = useMediaQuery(LG_UP);
  const card = useCardState(balance, held);
  // R14 X14-1 — the last page takes "Show older" away; the first movement it brought takes focus.
  // Visible lines only: a closed share group's member rows are `hidden` and never focusable.
  const showOlder = usePagedFocus(WALLET_ROWS, () => load(shown + PAGE_SIZE));

  return (
    <PageShell width="wide">
      <PageHeader
        title="Wallet"
        description="Your minutes, and every movement of them."
        actions={<RefreshButton onRefresh={refresh} loading={busy} />}
        freshness={<Freshness at={readAt} />}
      />
      <WalletNav />
      <StaleNotice stale={stale} readAt={readAt} offline={offline} />
      {/* A failed read is never "no movements yet" — that tells a member their history is gone.
          R8 X8-2 — and with no signal and nothing kept it is said as offline, not as red failure. */}
      {/* R9 X9-6 — a first read that has not answered says, after a few seconds, it is still trying. */}
      {firstRead(loaded, error, offline) === "trying" ? <StillTrying /> : null}
      {firstRead(loaded, error, offline) === "offline" ? <OfflineNothingKept line={OFFLINE_COPY.nothingKept.wallet} /> : (
        <StateBlock
          loading={!loaded}
          error={loaded ? null : error}
          action="load your wallet"
          onRetry={refresh}
          skeleton={<WalletSkeleton />}
          className="gap-8"
        >
          {loaded ? (
            // R4 form factor (SPEC 3.4): from a 64rem page the balance is a sticky rail beside the
            // ledger, first in reading order — the figure and Buy minutes together, not 800px apart.
            // The rail carries the last 30 days under the figure (R5 M5-9) where it is a rail.
            <WithAside placement="before" at="64rem" asideLabel={WALLET_LAYOUT.railLabel} aside={
              <>
                <BalanceCard state={card} painted={painted} held={held} topUp={wide} />
                {wide ? <WalletMiniTotals offline={offline} /> : null}
              </>
            }>
              <LedgerSection rows={rows} shareBookings={shareBookings} total={total} busy={busy} error={stale ? null : error} onOlder={showOlder} />
            </WithAside>
          ) : null}
        </StateBlock>
      )}
      {loaded && !wide ? (
        // One verb, the bar's whole width: the figure it is about is the card just above.
        <ContextBar position="bottom" until="lg" label={WALLET_LAYOUT.actionsLabel}>
          <TopUpLink level={card.level} primary block />
        </ContextBar>
      ) : null}
    </PageShell>
  );
}

const LG_UP = "(min-width: 1024px)";
/** The wallet ledger's drawn lines, in order: its own rows and each share group's line. */
const WALLET_ROWS = "[data-ledger-box] tbody > tr:not([hidden])";
