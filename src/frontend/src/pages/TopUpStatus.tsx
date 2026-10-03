import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ApiError, endpoints, type PurchaseStatus } from "../lib/api";
import { useBalance } from "../lib/balance";
import { formatMoney } from "../lib/utils";
import { minutesSpoken } from "../lib/minutes";
import { discountPercent } from "../lib/topUpShelf";
import { BUY_MINUTES_PATH } from "../lib/minutes";
import { Minutes } from "../components/Minutes";
import { typography } from "../lib/typography";
import { PageHeader, PageShell } from "../components/ui/page-shell";
import { Freshness } from "../components/ui/refresh-button";
import { WithAside } from "../components/ui/with-aside";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, Panel } from "../components/ui/card";
import { Skeleton } from "../components/ui/skeleton";
import { Spinner } from "../components/ui/spinner";
import { TextLink } from "../components/ui/text-link";
import { ArrowsClockwise, CheckCircle, Clock, Prohibit, WarningCircle } from "../components/ui/icons";
import { Alert } from "../components/Alert";
import { useAuth } from "../lib/auth";
import { pendingInvitePath } from "../lib/playersPending";
import { returnLabel, safeReturnTo, topUpReturnFor } from "../lib/topUpReturn";
import { CancelPending } from "./TopUpOpenCheckouts";
import { clubDayAndClock } from "../lib/clubClock";

/**
 * What each failure code means, to a member.
 *
 * <p>
 * The page rendered the raw column: a member whose R500 payment failed was shown
 * <code>amount_mismatch:reported=100,00:expected=500,00</code>, an internal string with
 * en-ZA comma decimals, as their explanation — and nothing about what to do next. Codes
 * are the API's stable contract; the sentences live here.
 * </p>
 */
const FAILURE_COPY: Record<string, string> = {
  amount_mismatch:
    "PayFast reported a different amount from the one this purchase was for, so no minutes were added. If money did leave your account, send the club your PayFast reference and they'll sort it out.",
  declined:
    "Your bank declined the payment, so nothing was charged. Try again, or use a different card.",
  gateway_error:
    "PayFast couldn't complete the payment and nothing was charged. Try again in a few minutes.",
  provider_register_failed:
    "The club's payment settings wouldn't accept this purchase. Nothing was charged — please tell an admin.",
};

/**
 * What a Cancelled purchase says, by who closed it (R4 M4-1). The member's own cancel keeps the
 * sentence it always had; one the club closed because nothing came back from PayFast for an hour
 * (`expired`) is not something the member did, and used to be told "You cancelled".
 */
const CANCELLED_COPY: Record<string, string> = {
  expired: "This payment was never finished, so nothing was charged and no minutes were added.",
};

/**
 * R4 M4-1 — the cancel return tells the club, so the purchase is closed rather than left Pending
 * for an hour. Whatever happens to that call, the row is then read back and the read is what the
 * page believes: a lost reply is the lost-reply rule (the cancel is idempotent, and a row the club
 * already closed is answered as it stands); the read's own 404 is the page's "no such purchase".
 */
async function cancelAtReturn(purchaseId: string): Promise<PurchaseStatus> {
  try {
    return await endpoints.minutesPurchaseCancel(purchaseId);
  } catch {
    return endpoints.minutesPurchaseStatus(purchaseId);
  }
}

/**
 * How long to wait before asking again, or null when this page should stop asking.
 *
 * <p>
 * It was a flat <code>attempts &lt; 30</code> at 2s, so the page stopped after 62
 * seconds — and said nothing. PayFast retries an ITN for hours and an EFT clears when it
 * clears, so the common case is that the money arrives AFTER the polling has quietly
 * given up: the member is left reading "Waiting for confirmation from PayFast…" for ever
 * beside minutes that are already in their ledger, with no control on the screen and no
 * way out but a manual browser reload.
 * </p>
 *
 * <p>
 * Two things had to change and only one of them is the budget. The budget widens — fast
 * while a card payment would clear, then slower, out to roughly six minutes — but the
 * page also has to say when it has stopped, and offer to ask again itself. A screen that
 * gives up silently is worse than one that never tried, because it still claims to be
 * waiting.
 * </p>
 */
function pollDelayMs(attempt: number): number | null {
  if (attempt < 15) return 2_000;   // ~30s: a card payment is confirmed well inside this
  if (attempt < 39) return 5_000;   // ~2½ minutes
  if (attempt < 54) return 15_000;  // ~6 minutes, then stop and say so
  return null;
}

/**
 * F4.2 — what the page shows for a snapshot, given how the member came back from PayFast.
 *
 * <p>
 * PayFast sends no ITN for a cancel; its cancel URL is the only word the page gets
 * (the server's `cancel_url` carries `?cancelled=1`), and the page passes it on (`cancelAtReturn`).
 * When even that could not be said — the cancel's reply was lost and the read still shows
 * Pending — the snapshot is the member's own cancel all the same: shown as Cancelled, and not
 * polled for six minutes under "Waiting for confirmation". Anything final the club reports
 * still wins over the flag.
 * </p>
 */
function shownStatus(snap: PurchaseStatus, cancelledReturn: boolean): PurchaseStatus {
  return cancelledReturn && snap.status === "Pending" ? { ...snap, status: "Cancelled" } : snap;
}

/**
 * `/wallet/buy/:purchaseId` — where PayFast sends the member back (P13 §3.1), and where a purchase
 * is watched until it is done. Three states a member reads: <b>waiting</b> (Pending, polled), <b>done</b>
 * (Completed: the minutes are in the wallet) and <b>not done</b> (Failed, or Cancelled — by the
 * member at PayFast or by the club after an hour). The old `/wallet/topup/:id` redirects here, and
 * `:topupId` is still read so the page works under either route table while the deploy settles.
 */
export default function BuyMinutesStatusPage() {
  const params = useParams<{ purchaseId?: string; topupId?: string }>();
  const purchaseId = params.purchaseId ?? params.topupId;
  const [search] = useSearchParams();
  const cancelledReturn = search.get("cancelled") === "1";
  const wayBack = useWayBack(purchaseId, search.get("returnTo"));
  const [s, setS] = useState<PurchaseStatus | null>(null);
  /* Whether the LAST attempt to read the status failed. Not the sentence — the two places
     that report it say different things, because "we could not reach the club" means something
     different before a status is known than it does beside one that is already on screen. */
  const [loadFailed, setLoadFailed] = useState(false);
  /**
   * The club answered, definitively, that there is no such purchase for this member.
   *
   * <p>
   * Held apart from {@link loadFailed} because a 404 is not an outage and the two owe the
   * member opposite things. The catch below used to be bare, so a 404 rendered "We couldn't
   * reach the club to check on this payment … we'll email you either way" beside a Check-again
   * button that can never resolve — a promise of a mail against a row that does not exist, and
   * an invitation to keep pressing. A definite answer deserves a definite screen.
   * </p>
   */
  const [missing, setMissing] = useState(false);
  const [gaveUp, setGaveUp] = useState(false);
  const [checking, setChecking] = useState(false);
  /** When the status on screen was read — the header's "Updated 12s ago" while it polls. */
  const [readAt, setReadAt] = useState<number | null>(null);
  /** Bumped by "Check again", which restarts the schedule from the top. */
  const [round, setRound] = useState(0);
  const { refresh: refreshBalance } = useBalance();
  const refreshedOnce = useRef(false);
  // Held in a ref rather than named as a dependency. `refresh` is rebuilt when the auth
  // status flips from loading to authenticated, and with it in the dependency list the
  // whole poll was torn down and restarted a few milliseconds after mount — two requests
  // for the same answer on every visit to this page, and a schedule that could not be
  // reasoned about from the code.
  const refreshBalanceRef = useRef(refreshBalance);
  useEffect(() => { refreshBalanceRef.current = refreshBalance; }, [refreshBalance]);

  useEffect(() => {
    if (!purchaseId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let first = true;
    // The cancel return is said once per round, on its first read; the polls after it only read.
    let tellCancel = cancelledReturn;

    const settled = () => { if (first) { first = false; setChecking(false); } };

    const tick = async () => {
      try {
        const read = tellCancel ? cancelAtReturn(purchaseId) : endpoints.minutesPurchaseStatus(purchaseId);
        tellCancel = false;
        const snap = shownStatus(await read, cancelledReturn);
        if (cancelled) return;
        settled();
        setS(snap);
        setReadAt(Date.now());
        setLoadFailed(false);
        if (snap.status === "Completed" && !refreshedOnce.current) {
          refreshedOnce.current = true;
          // The member's own purchase, and this page says so (D4) — not a toast about the club.
          void refreshBalanceRef.current({ expectSelf: true });
        }
        // Anything but Pending is final; there is nothing left to ask about.
        if (snap.status !== "Pending") return;
        const delay = pollDelayMs(attempts++);
        if (delay === null) { setGaveUp(true); return; }
        timer = setTimeout(() => { void tick(); }, delay);
      } catch (err) {
        if (cancelled) return;
        settled();
        // A 404 is the club answering, not the club being unreachable — and there is
        // nothing left to ask, so the poll stops here rather than rescheduling.
        if (err instanceof ApiError && err.status === 404) { setMissing(true); return; }
        setLoadFailed(true);
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [purchaseId, round, cancelledReturn]);

  // M5-2 — the member cancelled from this page: the club's answer is the snapshot now, and a
  // payment that went through after all refreshes the wallet as the poll would have.
  const settled = (next: PurchaseStatus) => {
    setS(next);
    setReadAt(Date.now());
    if (next.status === "Completed" && !refreshedOnce.current) {
      refreshedOnce.current = true;
      void refreshBalanceRef.current({ expectSelf: true });
    }
  };

  const checkAgain = () => {
    setChecking(true);
    setGaveUp(false);
    setMissing(false);
    setRound((r) => r + 1);
  };

  const header = <PageHeader back={{ to: "/wallet", label: "Wallet" }} title={STATUS_TITLE} freshness={<Freshness at={readAt} />} />;

  if (missing) return <StatusShell header={header}><NoSuchPurchase /></StatusShell>;

  /*
    A failed status request is not a dead end, and it used to be one: a bare sentence in a bare
    card, no controls, so the only way out was a manual browser reload. A failure BEFORE anything
    is known keeps the two controls the Pending branch has; a failure AFTER a status has been
    read keeps that status, and says beside it that the screen may be stale. Nothing here
    touches the payment, and a member watching a R500 purchase needs to be told so.
  */
  if (loadFailed && !s) {
    return (
      <StatusShell header={header}>
        <Card className="px-4 sm:px-6" data-status-card="">
          {/*
            "we'll email you either way" is TRUE: the server mails a member whose payment ends
            Failed, Cancelled or amount-mismatched (`PurchaseNotCompleted`), alongside the
            confirmation a completion sends (`PurchaseConfirmation`, P13 §6).
            `topup-status-email-promise.test.ts` holds this sentence to the backend.
          */}
          <Alert tone="danger">{UNREACHABLE_FIRST}</Alert>
          <StatusActions checking={checking} onCheck={checkAgain} />
        </Card>
      </StatusShell>
    );
  }
  if (!s) return <StatusShell header={header}><StatusSkeleton /></StatusShell>;

  return (
    <StatusShell header={header} aside={<AboutPurchase status={s} />}>
      <Card className="px-4 sm:px-6" data-status-card="">
        <StatusHead status={s} />
        {/* The status above was read before the club stopped answering, so it is kept and
            labelled rather than replaced by the failure. */}
        {loadFailed && (
          <Alert tone="danger">{UNREACHABLE_LATER}</Alert>
        )}
        <StatusBody status={s} gaveUp={gaveUp} checking={checking} onCheck={checkAgain} wayBack={wayBack} onSettled={settled} />
        {s.status === "Completed" || s.status === "Cancelled" ? <WayBack path={wayBack} /> : null}
      </Card>
    </StatusShell>
  );
}

/**
 * Where this purchase was started from: `?returnTo=`, else the path kept when the member left for
 * PayFast, else an invite this device is still waiting to answer (R1, lane F2's journey).
 */
function useWayBack(purchaseId: string | undefined, fromQuery: string | null): string | null {
  const auth = useAuth();
  const userId = auth.status === "authenticated" ? auth.userId : null;
  return safeReturnTo(fromQuery) ?? topUpReturnFor(purchaseId) ?? pendingInvitePath(userId);
}

function WayBack({ path }: { path: string | null }) {
  if (!path) return null;
  return (
    <div>
      <Button asChild variant="primary" className={WRAPS}><Link to={path}>{returnLabel(path)}</Link></Button>
    </div>
  );
}

/**
 * R6 L6-3 — the page USES a desktop: the status card with the purchase's details beside it (a
 * 36rem column left 60 % of a 1280 screen empty). Stacked on a phone, details after the status.
 * R7 J7-1 / L7-12 — and the 120rem frame from 3xl, as every member page now stands on: at 1920 a
 * 64rem column was 48 % of the window and the title sat 496 px in, apart from the app bar.
 */
function StatusShell({ header, aside, children }: { header: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <PageShell width="content" fullFrom3xl>
      {header}
      {aside ? (
        <WithAside at="56rem" asideWidth="22rem" sticky={false} asideLabel={STATUS_COPY.aboutTitle} aside={aside}>{children}</WithAside>
      ) : children}
    </PageShell>
  );
}

/**
 * R6 L6-2 — a button in these rows wraps its label inside the card at large text: nowrap at
 * 320 px and 200 % ran "Check again" and "Cancel this purchase" 92 px past the card's edge.
 */
const WRAPS = "max-w-full whitespace-normal";

/** The card's shape while the first status is read: the minutes, the badge, a line, two controls. */
function StatusSkeleton() {
  return (
    <Card className="px-4 sm:px-6" aria-busy="true" data-status-card="">
      <p role="status" className="sr-only">Checking this payment…</p>
      <div className="flex items-center justify-between gap-4">
        <Skeleton className="h-10 w-32" />
        <Skeleton className="h-6 w-24 rounded-full" />
      </div>
      <Skeleton className="h-5 w-full" />
      <Skeleton className="h-touch w-40" />
    </Card>
  );
}

/**
 * Cancelled is the member's own decision and gets its own neutral treatment. It used to be
 * stored and shown as "Failed", so somebody who deliberately backed out at PayFast was told
 * their payment had failed. Each status carries an icon as well as a colour.
 */
const STATUS_LOOK = {
  Completed: { tone: "success", icon: CheckCircle, word: "Done" },
  Failed: { tone: "danger", icon: WarningCircle, word: "Not completed" },
  Cancelled: { tone: "neutral", icon: Prohibit, word: "Cancelled" },
  Pending: { tone: "info", icon: Clock, word: "Waiting" },
} as const;

/** The minutes being bought, big — the thing the member is waiting for — then the package and its rand. */
function StatusHead({ status }: { status: PurchaseStatus }) {
  const look = STATUS_LOOK[status.status];
  const Icon = look.icon;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className={typography({ variant: "display" })}><Minutes value={status.minutes} /></p>
        <Badge tone={look.tone} icon={<Icon size={14} weight="bold" aria-hidden="true" />}>{look.word}</Badge>
      </div>
      <p className="text-sm text-text-secondary" data-status-package="">{packageLine(status)}</p>
    </div>
  );
}

const STATUS_TITLE = "Buying minutes";

/** "5 hours for R495.00 (10% off R550.00)". */
function packageLine(status: PurchaseStatus): string {
  const off = status.discount_bps > 0 && status.list_price_zar > status.amount_zar
    ? ` (${discountPercent(status.discount_bps)} off ${formatMoney(status.list_price_zar)})` : "";
  return `${status.package_name} for ${formatMoney(status.amount_zar)}${off}`;
}

function StatusActions({ checking, onCheck }: { checking: boolean; onCheck: () => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" className={WRAPS} onClick={onCheck} pending={checking} icon={<ArrowsClockwise aria-hidden="true" />}>Check again</Button>
      <Button asChild variant="ghost" className={WRAPS}><Link to="/wallet">View wallet</Link></Button>
    </div>
  );
}

export const STATUS_COPY = {
  unreachableFirst: "We couldn't reach the club to check on this payment. Nothing here cancels or changes it — if it has already cleared, your minutes are in your wallet, and we'll email you either way.",
  unreachableLater: "We couldn't reach the club just now, so this may be out of date. Nothing here cancels or changes your payment — press Check again in a moment.",
  notFound: "We can't find this purchase on your account. The link may be wrong, or it may belong to a different account — nothing has been charged for it. Your wallet shows every purchase that did go through.",
  gaveUp: "We've stopped checking on this page. PayFast can take a while — an instant EFT usually lands within minutes and a normal EFT can take until the next working day. Your minutes appear the moment it clears, and we'll email you.",
  waiting: "Waiting for confirmation from PayFast…",
  done: (minutes: number) => `${minutesSpoken(minutes)} added to your wallet.`,
  cancelled: "You cancelled this payment, so nothing was charged and no minutes were added.",
  failedFallback: "This payment didn't go through. Nothing was charged — try again, or tell an admin if it keeps happening.",
  tryAgain: "Try again",
  buy: "Buy minutes",
  /** R6 L6-3 — the details beside the status. */
  aboutTitle: "About this purchase",
  aboutPackage: "Package",
  aboutGet: "You get",
  aboutPay: "You pay",
  aboutStarted: "Started",
  aboutReference: "Reference",
  aboutReferenceHelp: "Quote it to the club if anything about this payment looks wrong.",
} as const;

const UNREACHABLE_FIRST = STATUS_COPY.unreachableFirst;
const UNREACHABLE_LATER = STATUS_COPY.unreachableLater;
const NOT_FOUND = STATUS_COPY.notFound;
const GAVE_UP = STATUS_COPY.gaveUp;
const CANCELLED = STATUS_COPY.cancelled;
const FAILED_FALLBACK = STATUS_COPY.failedFallback;

type BodyProps = {
  status: PurchaseStatus; gaveUp: boolean; checking: boolean; onCheck: () => void; wayBack: string | null;
  onSettled: (next: PurchaseStatus) => void;
};

/**
 * "Try again" keeps the way back (F4-12): a member sent to buy minutes from an invite who cancelled
 * at PayFast and tried again used to lose the invite — the new purchase had no `returnTo`, so its
 * own status page, and its Cancel, only knew the wallet.
 */
function retryPath(wayBack: string | null): string {
  return wayBack ? `${BUY_MINUTES_PATH}?returnTo=${encodeURIComponent(wayBack)}` : BUY_MINUTES_PATH;
}

/**
 * What the member reads under the figure, and what they can do. The Pending branch carries a
 * control and stops claiming to wait once it has stopped asking: it used to be one line — no
 * Check again, no way out — so a member whose R500 had already landed sat in front of
 * "Waiting for confirmation from PayFast…" indefinitely.
 */
function StatusBody(props: BodyProps) {
  // Destructured in the body: lizard counts every destructured name as a parameter (gate: 6).
  const { status, gaveUp, checking, onCheck, wayBack, onSettled } = props;
  if (status.status === "Pending") {
    return (
      <>
        {gaveUp ? (
          <p className="text-sm text-text-secondary">{GAVE_UP}</p>
        ) : (
          <p className="flex items-center gap-2 text-sm text-text-secondary">
            <Spinner className="text-accent-strong" />
            <span>{STATUS_COPY.waiting}</span>
          </p>
        )}
        <StatusActions checking={checking} onCheck={onCheck} />
        <CancelPending status={status} onSettled={onSettled} />
      </>
    );
  }
  if (status.status === "Completed") {
    return (
      <div className="flex flex-col items-start gap-1">
        <p className="text-sm text-text-primary">{STATUS_COPY.done(status.minutes)}</p>
        <TextLink to="/wallet" variant="standalone">View wallet</TextLink>
      </div>
    );
  }
  const failed = status.status === "Failed";
  const copy = failed ? FAILURE_COPY : CANCELLED_COPY;
  const sentence = (status.failure_code && copy[status.failure_code]) || (failed ? FAILED_FALLBACK : CANCELLED);
  return (
    <>
      <p className={failed ? "text-sm font-medium text-danger-strong" : "text-sm text-text-secondary"}>{sentence}</p>
      <div>
        <Button asChild variant="outline" className={WRAPS}><Link to={retryPath(wayBack)}>{STATUS_COPY.tryAgain}</Link></Button>
      </div>
    </>
  );
}

/**
 * K-F6 — the club answered, and the answer was "there is no such purchase".
 *
 * <p>
 * Three things followed from treating that 404 as an outage, and all three were wrong. It
 * blamed the club's connection for an answer the club had given. It promised a mail that
 * the server can only send against a real purchase row, so on this branch nothing would ever
 * arrive — the one channel the screen falls back to does not exist. And it offered <b>Check again</b>, which re-asks a question already
 * answered and can never resolve, to a member who is watching for money.
 * </p>
 *
 * <p>
 * What a member can actually do is look at their wallet — the minutes are either in it or
 * they are not — or start a purchase that does exist. Both are offered; neither is a retry.
 * Out here as its own component because the page is against the 200-line gate, and
 * lizard measures a .tsx function by what it last scoped: moving code to another function is
 * what shrinks it, extracting it into the same one is not.
 * </p>
 */
function NoSuchPurchase() {
  return (
    <Card className="px-4 sm:px-6">
      <Alert tone="danger">{NOT_FOUND}</Alert>
      <div className="flex flex-wrap gap-2">
        <Button asChild variant="outline" className={WRAPS}><Link to="/wallet">View wallet</Link></Button>
        <Button asChild variant="ghost" className={WRAPS}><Link to={BUY_MINUTES_PATH}>{STATUS_COPY.buy}</Link></Button>
      </div>
    </Card>
  );
}

/**
 * R6 L6-3 — what this purchase is, beside its status: the package, what it buys and costs, when it
 * started, and the reference the club can look it up by.
 */
function AboutPurchase({ status }: { status: PurchaseStatus }) {
  const off = status.discount_bps > 0 && status.list_price_zar > status.amount_zar;
  return (
    <Panel className="flex flex-col gap-4" data-about-purchase="">
      <h2 className="text-base font-semibold text-text-primary">{STATUS_COPY.aboutTitle}</h2>
      <dl className="flex flex-col gap-3 text-sm">
        <AboutRow term={STATUS_COPY.aboutPackage}>{status.package_name}</AboutRow>
        <AboutRow term={STATUS_COPY.aboutGet}><Minutes value={status.minutes} /></AboutRow>
        <AboutRow term={STATUS_COPY.aboutPay}>
          {formatMoney(status.amount_zar)}
          {off ? <span className="block text-xs font-normal text-text-secondary">{`${discountPercent(status.discount_bps)} off ${formatMoney(status.list_price_zar)}`}</span> : null}
        </AboutRow>
        <AboutRow term={STATUS_COPY.aboutStarted}>{clubDayAndClock(status.created_at)}</AboutRow>
        {/* R7 J7-1 — when a waiting purchase closes by itself is said ONCE, under the status beside
            its Cancel (`CancelPending`); repeating it here said it twice on one screen. */}
        <AboutRow term={STATUS_COPY.aboutReference} help={STATUS_COPY.aboutReferenceHelp}>
          <span className="font-mono text-xs [overflow-wrap:anywhere]">{status.id}</span>
        </AboutRow>
      </dl>
    </Panel>
  );
}

function AboutRow({ term, help, children }: { term: string; help?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-text-secondary">{term}</dt>
      <dd className="min-w-0 font-semibold tabular-nums text-text-primary [overflow-wrap:anywhere]">{children}</dd>
      {help ? <dd className="text-xs text-text-secondary">{help}</dd> : null}
    </div>
  );
}
