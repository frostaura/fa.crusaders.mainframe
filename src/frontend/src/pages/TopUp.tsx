import { useCallback, useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { endpoints, phoneIsOffline, type MinutesShelf, type PayFastFormField, type ShelfPackage } from "../lib/api";
import { isConnectionFailure } from "../lib/offline/useCachedRead";
import { OfflineNothingKept } from "../lib/offline/OfflineNothingKept";
import { StillTrying } from "../lib/offline/StillTrying";
import { OFFLINE_COPY } from "../lib/offline/offlineCopy";
import { useBalance } from "../lib/useBalance";
import { walletTone } from "../lib/walletTone";
import { BALANCE_SENTENCE } from "../lib/walletCopy";
import { formatMoney } from "../lib/utils";
import { BUY_COPY, BUY_SAID, buyRefusal, isFreeHere, withRestated } from "../lib/topUpShelf";
import { rememberTopUpReturn, safeReturnTo } from "../lib/topUpReturn";
import { PageHeader, PageShell } from "../components/ui/page-shell";
import { StateBlock } from "../components/ui/state-block";
import { Button } from "../components/ui/button";
import { ContextBar } from "../components/ui/context-bar";
import { WithAside } from "../components/ui/with-aside";
import { useMediaQuery } from "../components/ui/use-media-query";
import { Alert } from "../components/Alert";
import { Coins } from "../components/ui/icons";
import { OpenCheckouts } from "./TopUpOpenCheckouts";
import { PurchaseSummary, ShelfCards, ShelfSkeleton } from "./TopUpShelf";

/**
 * `/wallet/buy` — the member's package shelf and its checkout (P13 §3.4, §4). Route
 * `/wallet/topup` redirects here (§12.14), so a link or a bookmark from before P13 still lands.
 *
 * <p>
 * <b>The form factor.</b> Wide: the shelf in columns (two, then three as the page grows) with the
 * purchase summary as a sticky rail beside it — the width used, never a centred narrow column. A
 * phone: the cards stacked, and the chosen package's price with Continue docked in thumb reach.
 * </p>
 *
 * <p>
 * <b>The price the member sees is the price they pay.</b> Continue sends the shelf's `price_zar`
 * as `quotedPriceZar`; a price the club moved meanwhile is refused (`package_price_changed`) with
 * the package as it is now, which this page puts on screen and stops — the member commits to the
 * new figure by pressing again. The shelf is also re-read whenever the tab regains focus.
 * </p>
 *
 * <p>
 * <b>A lost reply is read back, never re-sent.</b> If the purchase POST's answer never comes, the
 * shelf is read again: a NEW open checkout means a purchase was registered that this page cannot
 * hand to PayFast (the signed form lives only in the lost reply), so the member is told so and its
 * Cancel is right there; no new checkout means nothing was started.
 * </p>
 */
export default function BuyMinutesPage() {
  const { balance } = useBalance();
  const emptyWallet = walletTone(balance) === "zero";
  const [search] = useSearchParams();
  const returnTo = safeReturnTo(search.get("returnTo"));
  const { shelf, setShelf, loadError, reload } = useShelf();
  const [selected, setSelected] = useState<string | null>(null);
  const buy = usePurchase(shelf, setShelf, reload, returnTo);
  const wide = useMediaQuery(LG_UP);
  const pkg = shelf?.packages.find((p) => p.id === selected) ?? null;
  const choose = (id: string) => { setSelected(id); buy.clearNotice(); };
  const notice = buy.notice ? <Alert tone={buy.notice.tone} live="polite">{buy.notice.text}</Alert> : null;
  const summary = (
    <PurchaseSummary pkg={pkg} discountGroup={shelf?.discount?.group.name ?? null} pending={buy.pending} onBuy={() => { if (pkg) void buy.run(pkg); }} notice={notice} />
  );

  return (
    <PageShell width="wide">
      <PageHeader back={{ to: returnTo ?? "/wallet", label: returnTo ? BUY_COPY.back : "Wallet" }} title={BUY_COPY.title} description={BUY_COPY.description} />
      {/* Why they are here, when the answer is "you cannot book anything": a standing condition. */}
      {emptyWallet && <Alert tone="danger" live="polite">{BALANCE_SENTENCE.zero}</Alert>}
      {/* R6 X6-4 — offline there is nothing to show and nothing to buy: said, under the page's own heading. */}
      {/* R10 X10-1 — a first read that has not answered says, after a few seconds, it is still trying. */}
      {shelf === null && loadError === null ? <StillTrying /> : null}
      {shelf === null && loadError !== null && (isConnectionFailure(loadError) || phoneIsOffline()) ? (
        <OfflineNothingKept line={OFFLINE_COPY.buyNeedsConnection} />
      ) : (
        <StateBlock
          loading={shelf === null && !loadError}
          error={shelf === null ? loadError : null}
          action={BUY_COPY.readAction}
          onRetry={reload}
          empty={shelf !== null && shelf.packages.length === 0}
          emptyIcon={Coins}
          emptyTitle={BUY_COPY.emptyTitle}
          emptyHint={BUY_COPY.emptyHint}
          emptyAction={<Button asChild variant="outline"><Link to="/wallet">Wallet</Link></Button>}
          skeleton={<ShelfSkeleton />}
        >
          {shelf ? (
            <WithAside placement="after" at="56rem" asideLabel={BUY_COPY.summaryLabel} aside={wide ? summary : null}>
              <ShelfCards shelf={shelf} selected={selected} onSelect={choose} />
              {/* M5-2 — payments started at PayFast and not finished, each with its own Cancel. */}
              <OpenCheckouts open={shelf.open_checkouts} onChanged={reload} />
            </WithAside>
          ) : null}
        </StateBlock>
      )}
      {shelf && shelf.packages.length > 0 && !wide ? (
        <ContextBar position="bottom" until="lg" label={BUY_COPY.summaryLabel}>
          <div className="flex w-full flex-col gap-2">{summaryDocked(pkg, buy, notice)}</div>
        </ContextBar>
      ) : null}
    </PageShell>
  );
}

const LG_UP = "(min-width: 1024px)";

const PRICE_ID = "buy-docked-price";

/** The phone's docked bar: the price of the chosen package beside the one verb. */
function summaryDocked(pkg: ShelfPackage | null, buy: Purchase, notice: ReactNode) {
  return (
    <>
      {pkg && isFreeHere(pkg) ? <Alert tone="warning">{BUY_SAID.priceZero}</Alert> : notice}
      {/* R15 L15-8 — nothing picked: a short label at the default size. "Pick a package to see what
          you pay." in a large button was four lines (~300px) of a 320 / 200 % screen's bottom bar. */}
      {/* R16 L16-2 — picked, the price stands beside the verb where they fit on one line and above it
          where they do not: "Continue to PayFast · R120.00" inside one large button was three lines
          (308px, half of a 320 / 200 % screen) of bar. The price is the button's description. */}
      <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
        {pkg ? <span id={PRICE_ID} className="text-base font-semibold tabular-nums text-text-primary">{formatMoney(pkg.price_zar)}</span> : null}
        <Button
          size="md" className="min-w-0 flex-[1_1_12rem]" pending={buy.pending} disabled={!pkg || isFreeHere(pkg)}
          aria-describedby={pkg ? PRICE_ID : undefined} onClick={() => { if (pkg && !isFreeHere(pkg)) void buy.run(pkg); }}
        >
          {pkg ? BUY_COPY.cta : BUY_COPY.pickShort}
        </Button>
      </div>
    </>
  );
}

/** The member's shelf, read on mount and again whenever the tab regains focus. */
function useShelf() {
  const [shelf, setShelf] = useState<MinutesShelf | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const reload = useCallback(() => {
    endpoints.minutesPackages()
      .then((s) => { setShelf(s); setLoadError(null); })
      .catch((err: unknown) => setLoadError(err ?? new Error("shelf read failed")));
  }, []);
  useEffect(() => { reload(); }, [reload]);
  // A tab left open across a price edit quotes a price the club will not honour; re-reading on
  // focus narrows the window, and `package_price_changed` at Continue closes it.
  // R6 X6-4 — and when the phone finds a network again: an offline visit loads by itself.
  useEffect(() => {
    window.addEventListener("focus", reload);
    window.addEventListener("online", reload);
    return () => {
      window.removeEventListener("focus", reload);
      window.removeEventListener("online", reload);
    };
  }, [reload]);
  return { shelf, setShelf, loadError, reload };
}

type Notice = { tone: "warning" | "danger"; text: string };

type Purchase = { run: (pkg: ShelfPackage) => Promise<void>; pending: boolean; notice: Notice | null; clearNotice: () => void };

/**
 * Continue: register the purchase at the shelf price, then hand the browser to PayFast with the
 * signed form. Re-entry is ignored while one is in flight (a double tap never registers two).
 */
function usePurchase(
  shelf: MinutesShelf | null,
  setShelf: Dispatch<SetStateAction<MinutesShelf | null>>,
  reload: () => void,
  returnTo: string | null,
): Purchase {
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const inFlight = useRef(false);
  const shelfRef = useRef(shelf);
  useEffect(() => { shelfRef.current = shelf; }, [shelf]);

  const run = useCallback(async (pkg: ShelfPackage) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setNotice(null);
    const openBefore = new Set((shelfRef.current?.open_checkouts ?? []).map((c) => c.id));
    try {
      const res = await endpoints.minutesPurchase(pkg.id, pkg.price_zar);
      // The way back (an invite, usually) must survive PayFast, whose return URLs are the server's.
      rememberTopUpReturn(res.purchase_id, returnTo);
      postToGateway(res.redirect_url, res.form_fields);
      // Stays pending: the page is leaving for PayFast.
      return;
    } catch (error) {
      setNotice(await refusalNotice(error, openBefore, setShelf, reload));
    }
    inFlight.current = false;
    setPending(false);
  }, [returnTo, setShelf, reload]);

  return { run, pending, notice, clearNotice: () => setNotice(null) };
}

/** What a failed Continue puts on screen — after reading the club back when the reply was lost. */
async function refusalNotice(
  error: unknown,
  openBefore: Set<string>,
  setShelf: Dispatch<SetStateAction<MinutesShelf | null>>,
  reload: () => void,
): Promise<Notice> {
  const refusal = buyRefusal(error);
  if (refusal.kind === "price_changed") return priceChangedNotice(refusal.restated, setShelf);
  if (refusal.kind === "unavailable") { reload(); return { tone: "warning", text: BUY_SAID.unavailable }; }
  if (refusal.kind === "sentence") return { tone: "danger", text: refusal.text };
  try {
    const now = await endpoints.minutesPackages();
    setShelf(now);
    const started = now.open_checkouts.some((c) => !openBefore.has(c.id));
    return { tone: "warning", text: started ? BUY_SAID.lostStarted : BUY_SAID.lostNothing };
  } catch {
    return { tone: "danger", text: BUY_SAID.lostUnknown };
  }
}

/**
 * R8 J8-2 — a moved price is rarely one package's: a group discount gained or lost moves every club
 * price and the banner above them. So the WHOLE shelf is read again and the sentence names the
 * price the fresh shelf holds; a package the re-read no longer has is said as gone. Only when that
 * read fails is the refused package restated alone, from the refusal's own copy.
 */
async function priceChangedNotice(
  restated: ShelfPackage,
  setShelf: Dispatch<SetStateAction<MinutesShelf | null>>,
): Promise<Notice> {
  const now = await endpoints.minutesPackages().catch(() => null);
  if (!now) {
    setShelf((s) => (s ? withRestated(s, restated) : s));
    return { tone: "warning", text: BUY_SAID.priceChanged(restated) };
  }
  setShelf(now);
  const fresh = now.packages.find((p) => p.id === restated.id);
  return { tone: "warning", text: fresh ? BUY_SAID.priceChanged(fresh) : BUY_SAID.unavailable };
}

/**
 * Hands the browser to PayFast by **submitting the signed form the API built**. PayFast has no
 * server-side checkout registration; the signed form IS the checkout, and a GET to its process URL
 * (what this page once did) carries no merchant, amount or signature. A real form submission rather
 * than `fetch`: the member must LAND on PayFast's page to pay, and cross-origin posts navigate.
 */
function postToGateway(actionUrl: string, fields: PayFastFormField[]) {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = actionUrl;
  form.style.display = "none";
  for (const f of fields) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = f.name;
    input.value = f.value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
}
