import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import BuyMinutesPage from "./TopUp";
import { refuse, renderPage, signIn, signOut, stubFetch, type StubRoute } from "../test/harness";
import {
  PACKAGE_IDS, discountedShelf, minutesShelf, openCheckout, purchaseStart, shelfPackage,
} from "../test/minutesFixtures";
import { BUY_COPY, BUY_SAID } from "../lib/topUpShelf";
import { topUpReturnFor } from "../lib/topUpReturn";
import { formatMoney } from "../lib/utils";

/**
 * `/wallet/buy` — the package shelf and its checkout (P13 §3.4, §4).
 *
 * <p>
 * What goes OUT is on trial as much as what the screen says: the purchase body names a package
 * and the price the member was shown, and the browser leaves with the SIGNED form the API built
 * (PayFast has no server-side checkout; a GET to its process URL carries nothing it can act on).
 * </p>
 */
const PURCHASE = "/api/v1/minutes/purchase";
const SHELF = "/api/v1/minutes/packages";

/** Every form the page actually submitted — the last one is the checkout. */
const submitted: HTMLFormElement[] = [];

beforeEach(() => {
  submitted.length = 0;
  // jsdom does not implement `HTMLFormElement.prototype.submit`; the receiver is the form on trial.
  vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(function (this: HTMLFormElement) {
    submitted.push(this);
  });
  vi.stubGlobal("EventSource", class {
    close() {}
    addEventListener() {}
    removeEventListener() {}
  } as unknown as typeof EventSource);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); signOut(); sessionStorage.clear(); });

function show(routes: StubRoute[], entry = "/wallet/buy") {
  const stub = stubFetch([...routes, { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) }]);
  renderPage(<BuyMinutesPage />, { initialEntries: [entry] });
  return stub;
}

const card = (name: string) => screen.findByRole("radio", { name });
const continueButton = () => screen.getByRole("button", { name: new RegExp(BUY_COPY.cta) });

describe("Buy minutes — the shelf", () => {
  it("shows each package as minutes in human form, its rand price and the saving against the smallest", async () => {
    show([{ path: SHELF, body: minutesShelf() }]);
    const five = await card("5 hours");
    expect(within(five).getByText("5 h")).toBeInTheDocument();
    expect(within(five).getByText(formatMoney(550))).toBeInTheDocument();
    expect(within(five).getByText(BUY_COPY.save(8))).toBeInTheDocument();
    // §4.3's worked example: 10 h saves R200 (16%) against 1 h at a time.
    const ten = await card("10 hours");
    expect(within(ten).getByText(BUY_COPY.save(16))).toBeInTheDocument();
    expect(within(ten).getByText(`${formatMoney(200)} less than 1 h at a time`)).toBeInTheDocument();
    // The baseline itself never claims a saving.
    expect(within(await card("1 hour")).queryByText(/Save/)).toBeNull();
    // Screen readers hear the long form, never "h".
    expect(five).toHaveAccessibleDescription(/^5 hours for R550\.00, saves R50\.00 \(8%\) against buying 1 hour at a time\.$/);
  });

  it("offers no free amount, no limit and no rate — a package is the only thing to buy", async () => {
    show([{ path: SHELF, body: minutesShelf() }]);
    await card("5 hours");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(document.body.textContent).not.toMatch(/limit|multiples of|per member|rate|credit|\bcr\b|top up/i);
  });

  it("names the member's group discount once, and shows each club price against its list price", async () => {
    show([{ path: SHELF, body: discountedShelf() }]);
    const five = await card("5 hours");
    expect(screen.getByText(BUY_COPY.discountNote("10%", "League"))).toBeInTheDocument();
    expect(within(five).getByText(formatMoney(495))).toBeInTheDocument();
    expect(within(five).getByText(BUY_COPY.wasPrice(550))).toBeInTheDocument();
    expect(five).toHaveAccessibleDescription(/10% off R550\.00/);
  });

  it("shows a group's own packages under the group's name AND the club's packages (Dean's answer 2)", async () => {
    const league = { id: "00000000-0000-0000-0000-0000000000c1", name: "League" };
    const shelf = minutesShelf({
      packages: [
        shelfPackage({ id: "g-1", name: "League night", minutes: 90, list_price_zar: 150, price_zar: 150, saving_zar: null, saving_pct: null, source: "group", group: league }),
        ...minutesShelf().packages,
      ],
    });
    show([{ path: SHELF, body: shelf }]);
    const groupSection = await screen.findByRole("region", { name: BUY_COPY.groupSection("League") });
    expect(within(groupSection).getByRole("radio", { name: "League night" })).toBeInTheDocument();
    expect(within(groupSection).getByText("1 h 30 min")).toBeInTheDocument();
    const clubSection = screen.getByRole("region", { name: BUY_COPY.clubSection });
    expect(within(clubSection).getAllByRole("radio")).toHaveLength(3);
    // One choice across both shelves.
    expect(screen.getAllByRole("radiogroup")).toHaveLength(1);
  });

  it("says plainly when the club has no packages — an answer, not a failure", async () => {
    show([{ path: SHELF, body: minutesShelf({ packages: [] }) }]);
    expect(await screen.findByText(BUY_COPY.emptyTitle)).toBeInTheDocument();
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("never calls a failed read 'no packages', and offers the retry", async () => {
    let fail = true;
    show([{ path: SHELF, respond: () => (fail ? refuse(503, { error: "down" }) : minutesShelf()) }]);
    const retry = await screen.findByRole("button", { name: /try again/i });
    expect(screen.queryByText(BUY_COPY.emptyTitle)).toBeNull();
    fail = false;
    fireEvent.click(retry);
    expect(await card("5 hours")).toBeInTheDocument();
  });
});

describe("Buy minutes — the checkout", () => {
  it("sends the package and the price the member was shown, then POSTs the signed form to PayFast", async () => {
    const stub = show([{ path: SHELF, body: minutesShelf() }, { method: "POST", path: PURCHASE, body: purchaseStart() }]);
    fireEvent.click(await card("5 hours"));
    fireEvent.click(continueButton());
    await waitFor(() => expect(submitted).toHaveLength(1));
    const post = stub.calls.find((c) => c.method === "POST" && c.path === PURCHASE)!;
    expect(post.body).toEqual({ packageId: PACKAGE_IDS.five, quotedPriceZar: 550 });
    const form = submitted[0];
    expect(form.method.toLowerCase()).toBe("post");
    expect(form.action).toBe(purchaseStart().redirect_url);
    expect([...form.querySelectorAll("input")].map((i) => [i.name, i.value])).toEqual(purchaseStart().form_fields.map((f) => [f.name, f.value]));
  });

  it("sends the DISCOUNTED price the shelf showed, never the list price", async () => {
    const stub = show([{ path: SHELF, body: discountedShelf() }, { method: "POST", path: PURCHASE, body: purchaseStart({ amount_zar: 495 }) }]);
    fireEvent.click(await card("5 hours"));
    fireEvent.click(continueButton());
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(stub.calls.find((c) => c.method === "POST" && c.path === PURCHASE)!.body).toEqual({ packageId: PACKAGE_IDS.five, quotedPriceZar: 495 });
  });

  it("cannot continue before a package is chosen", async () => {
    const stub = show([{ path: SHELF, body: minutesShelf() }]);
    await card("5 hours");
    const button = screen.getByRole("button", { name: BUY_COPY.pickOne });
    fireEvent.click(button);
    expect(stub.calls.some((c) => c.method === "POST" && c.path === PURCHASE)).toBe(false);
  });

  it("keeps the way back (an invite) through the PayFast round-trip", async () => {
    show([{ path: SHELF, body: minutesShelf() }, { method: "POST", path: PURCHASE, body: purchaseStart() }], "/wallet/buy?returnTo=%2Fj%2Fabc");
    fireEvent.click(await card("5 hours"));
    fireEvent.click(continueButton());
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(topUpReturnFor(purchaseStart().purchase_id)).toBe("/j/abc");
  });

  it("stops on a moved price, shows the new one, and the next press pays exactly that", async () => {
    const now = shelfPackage({ price_zar: 600, list_price_zar: 600 });
    let calls = 0;
    const stub = show([
      { path: SHELF, body: minutesShelf() },
      { method: "POST", path: PURCHASE, respond: () => (++calls === 1 ? refuse(409, { error: "package_price_changed", package: now }) : purchaseStart({ amount_zar: 600 })) },
    ]);
    fireEvent.click(await card("5 hours"));
    fireEvent.click(continueButton());
    expect(await screen.findByText(BUY_SAID.priceChanged(now))).toBeInTheDocument();
    expect(submitted).toHaveLength(0);
    expect(within(await card("5 hours")).getByText(formatMoney(600))).toBeInTheDocument();
    fireEvent.click(continueButton());
    await waitFor(() => expect(submitted).toHaveLength(1));
    const posts = stub.calls.filter((c) => c.method === "POST" && c.path === PURCHASE);
    expect(posts.map((p) => (p.body as { quotedPriceZar: number }).quotedPriceZar)).toEqual([550, 600]);
  });

  it("re-reads the shelf when a package has gone, and says nothing was sent", async () => {
    let gone = false;
    const stub = show([
      { path: SHELF, respond: () => (gone ? minutesShelf({ packages: minutesShelf().packages.filter((p) => p.id !== PACKAGE_IDS.five) }) : minutesShelf()) },
      { method: "POST", path: PURCHASE, respond: () => { gone = true; return refuse(409, { error: "package_unavailable" }); } },
    ]);
    fireEvent.click(await card("5 hours"));
    fireEvent.click(continueButton());
    expect(await screen.findByText(BUY_SAID.unavailable)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("radio", { name: "5 hours" })).toBeNull());
    expect(stub.calls.filter((c) => c.path === SHELF).length).toBeGreaterThanOrEqual(2);
  });

  it("says a coded gateway refusal (502 provider_register_failed) as the club's answer, not a lost reply", async () => {
    const stub = show([{ path: SHELF, body: minutesShelf() }, { method: "POST", path: PURCHASE, status: 502, body: { error: "provider_register_failed", reason: "x" } }]);
    fireEvent.click(await card("5 hours"));
    fireEvent.click(continueButton());
    expect(await screen.findByText(BUY_SAID.providerFailed)).toBeInTheDocument();
    expect(stub.calls.filter((c) => c.path === SHELF)).toHaveLength(1);
  });
});

/** A purchase that LANDS on the server and loses its reply: the shelf is read back, never re-sent. */
describe("Buy minutes — a lost reply", () => {
  const lostAfterRegistering = (registered: { yes: boolean }): StubRoute => ({
    method: "POST", path: PURCHASE, respond: () => { registered.yes = true; return refuse(502, {}); },
  });

  it("finds the checkout the lost reply registered, says so, and offers its Cancel", async () => {
    const registered = { yes: false };
    const stub = show([
      { path: SHELF, respond: () => (registered.yes ? minutesShelf({ open_checkouts: [openCheckout()] }) : minutesShelf()) },
      lostAfterRegistering(registered),
    ]);
    fireEvent.click(await card("5 hours"));
    fireEvent.click(continueButton());
    expect(await screen.findByText(BUY_SAID.lostStarted)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /^Cancel the 5 hours \(5 h\) for R550\.00 purchase/ })).toBeInTheDocument();
    expect(submitted).toHaveLength(0);
    expect(stub.calls.filter((c) => c.method === "POST" && c.path === PURCHASE)).toHaveLength(1);
  });

  it("says nothing was started when the club's record shows no new checkout", async () => {
    const before = openCheckout({ id: "old-one" });
    show([
      { path: SHELF, body: minutesShelf({ open_checkouts: [before] }) },
      { method: "POST", path: PURCHASE, status: 504, body: {} },
    ]);
    fireEvent.click(await card("5 hours"));
    fireEvent.click(continueButton());
    expect(await screen.findByText(BUY_SAID.lostNothing)).toBeInTheDocument();
  });

  it("says it cannot tell when the record cannot be read either", async () => {
    let reads = 0;
    show([
      { path: SHELF, respond: () => (++reads === 1 ? minutesShelf() : refuse(503, {})) },
      { method: "POST", path: PURCHASE, status: 502, body: {} },
    ]);
    fireEvent.click(await card("5 hours"));
    fireEvent.click(continueButton());
    expect(await screen.findByText(BUY_SAID.lostUnknown)).toBeInTheDocument();
  });
});
