import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { SellPackageSheet } from "../SellPackageSheet";
import { refuse, renderPage, stubFetch, type StubRoute } from "../../../test/harness";
import { PACKAGE_IDS, shelfPackage } from "../../../test/minutesFixtures";
import { PAYMENT_CHOICES, SELL_COPY as COPY } from "../../../lib/deskMinutesCopy";
import { adminEndpoints } from "../../../lib/adminApi";
import { formatMoney } from "../../../lib/utils";

/** BA-20: the note's label says "(required)" up front, so it is found by its first word. */
const SALE_NOTE = new RegExp(`^${COPY.detailLabel}\\b`);

/**
 * Review round 9 on the desk's Sell sheet.
 *
 * J9-1: the sheet omitted the rand when it equalled the shown price, and the server priced the sale
 * at write time — a discount that moved between Check and Sell recorded (and mailed) R96 for a R108
 * the admin confirmed. The sheet now always states the price it showed (`quotedPriceZar`) and the rand
 * taken; a 409 `package_price_changed` names the new price and asks for a fresh confirm — never
 * "That didn't go through. Nothing was changed."
 *
 * J9-3: a package that costs the member nothing is GIVEN: the button, the confirm and the receipt say so.
 */
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const USER = "44444444-4444-4444-4444-444444444444";
const SHELF = `/api/v1/admin/minutes/${USER}/packages`;
const SELL = `/api/v1/admin/minutes/${USER}/sell`;
const POINTER = { button: 0, ctrlKey: false, pointerType: "mouse" } as const;

const HOUR = shelfPackage({ id: PACKAGE_IDS.hour, name: "1 hour", minutes: 60, list_price_zar: 120, discount_bps: 1000, price_zar: 108, saving_zar: null, saving_pct: null });
const HOUR_NOW = { ...HOUR, discount_bps: 2000, price_zar: 96 };
const FREE = shelfPackage({ id: PACKAGE_IDS.hour, name: "1 hour", minutes: 60, list_price_zar: 120, discount_bps: 10_000, price_zar: 0, saving_zar: null, saving_pct: null });
const FREE_GONE = { ...FREE, discount_bps: 0, price_zar: 120 };

const sold = (zar: number) => ({
  entry_id: "e1", type: "AdminTopUp", reason_code: "top_up_cash", amount_minutes: 60, zar_received: zar,
  balance_before_minutes: 120, balance_after_minutes: 180, member: { user_id: USER, email: "t@x.test" },
  package: { id: HOUR.id, name: HOUR.name, minutes: 60, price_zar: zar },
});

function draw(routes: StubRoute[]) {
  const stub = stubFetch(routes);
  const spy = vi.spyOn(adminEndpoints, "sellPackage");
  renderPage(<SellPackageSheet userId={USER} name="Thandi" balance={120} onClose={() => {}} onSold={() => {}} />);
  return { stub, spy };
}

async function toCheck(paid: boolean) {
  fireEvent.click(await screen.findByRole("radio", { name: /1 hour/ }));
  fireEvent.click(screen.getByRole("button", { name: COPY.next }));
  if (paid) {
    fireEvent.pointerDown(await screen.findByRole("combobox", { name: COPY.paymentLabel }), POINTER);
    fireEvent.click(await screen.findByRole("option", { name: PAYMENT_CHOICES[0].label }));
  }
  fireEvent.change(await screen.findByLabelText(SALE_NOTE), { target: { value: "Receipt 7" } });
  fireEvent.click(screen.getByRole("button", { name: COPY.next }));
}

async function press(idle: RegExp) {
  fireEvent.click(await screen.findByRole("button", { name: idle }), { detail: 1 });
  fireEvent.click(document.querySelector<HTMLButtonElement>("[data-confirm='go']")!, { detail: 1 });
}

const posts = (stub: ReturnType<typeof stubFetch>) => stub.calls.filter((c) => c.method === "POST" && c.path === SELL);

describe("J9-1 — a sale states the price the admin confirmed", () => {
  it("sends the shown price as the quote and the rand taken, even when they are equal", async () => {
    const { stub, spy } = draw([
      { path: SHELF, body: { discount: null, packages: [HOUR] } },
      { method: "POST", path: SELL, body: sold(108) },
    ]);
    await toCheck(true);
    await press(/^Sell /);
    await waitFor(() => expect(posts(stub)).toHaveLength(1));
    expect((posts(stub)[0].body as Record<string, unknown>).zarReceived).toBe(108);
    expect(spy.mock.calls[0][1]).toMatchObject({ quotedPriceZar: 108, zarReceived: 108 });
  });

  it("on package_price_changed names the new price, takes it as the rand, and needs a fresh confirm", async () => {
    let tries = 0;
    const { stub, spy } = draw([
      { path: SHELF, body: { discount: null, packages: [HOUR] } },
      { method: "POST", path: SELL, respond: () => (++tries === 1
        ? refuse(409, { error: "package_price_changed", package: HOUR_NOW, discount: { bps: 2000, group: { id: "g1", name: "League" } } })
        : sold(96)) },
    ]);
    await toCheck(true);
    await press(/^Sell /);
    await waitFor(() => expect(document.querySelector("[data-sale-notice]")).toHaveTextContent(COPY.priceChanged(formatMoney(96), formatMoney(108))));
    expect(screen.queryByText(/didn't go through/)).toBeNull();
    // Nothing is sent again until the admin confirms again, at the new price.
    expect(posts(stub)).toHaveLength(1);
    // The check now shows the new price as the money received (it was the default, the old price).
    expect(document.querySelector("dl")).toHaveTextContent(formatMoney(96));
    await press(/^Sell /);
    await waitFor(() => expect(posts(stub)).toHaveLength(2));
    expect(spy.mock.calls[1][1]).toMatchObject({ quotedPriceZar: 96, zarReceived: 96 });
  });

  it("a free give whose discount vanished says it now costs money and asks how it was paid", async () => {
    const { stub } = draw([
      { path: SHELF, body: { discount: null, packages: [FREE] } },
      { method: "POST", path: SELL, status: 409, body: { error: "package_price_changed", package: FREE_GONE, discount: null } },
    ]);
    await toCheck(false);
    await press(/^Give /);
    await waitFor(() => expect(document.querySelector("[data-sale-notice]")).toHaveTextContent(COPY.noLongerFree("Thandi", formatMoney(120))));
    expect(screen.queryByText(/didn't go through/)).toBeNull();
    expect(await screen.findByRole("combobox", { name: COPY.paymentLabel })).toBeInTheDocument();
    expect(posts(stub)).toHaveLength(1);
    const sent = posts(stub)[0].body as Record<string, unknown>;
    expect(sent.reasonCode).toBe("package_free");
    expect(sent.zarReceived).toBe(0);
  });
});

describe("J9-3 — a free package is given, never sold", () => {
  it("the button, the title and the receipt say give", async () => {
    draw([
      { path: SHELF, body: { discount: null, packages: [FREE] } },
      { method: "POST", path: SELL, body: { ...sold(0), reason_code: "package_free" } },
    ]);
    await toCheck(false);
    expect(await screen.findByRole("button", { name: new RegExp(`^${COPY.idleFor(60, true)}`) })).toBeInTheDocument();
    expect(COPY.idleFor(60, true)).toBe("Give 1 hour");
    expect(screen.getByRole("heading", { name: COPY.titleFor("Thandi", true) })).toBeInTheDocument();
    await press(/^Give /);
    expect(await screen.findByText(COPY.receiptFor("Thandi", "1 hour", 60, true))).toBeInTheDocument();
    expect(COPY.receiptFor("Thandi", "1 hour", 60, true)).toBe("1 hour given — 1 hour added for Thandi at no charge.");
    expect(document.body.textContent).not.toMatch(/\bsold\b|\bSell\b/);
  });
});
