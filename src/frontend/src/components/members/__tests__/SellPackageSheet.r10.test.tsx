import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { SellPackageSheet } from "../SellPackageSheet";
import { refuse, renderPage, stubFetch, type StubRoute } from "../../../test/harness";
import { PACKAGE_IDS, shelfPackage } from "../../../test/minutesFixtures";
import { PAYMENT_CHOICES, SELL_COPY as COPY, percentOfBps } from "../../../lib/deskMinutesCopy";
import { formatMoney } from "../../../lib/utils";

/** BA-20: the note's label says "(required)" up front, so it is found by its first word. */
const SALE_NOTE = new RegExp(`^${COPY.detailLabel}\\b`);

/**
 * Review round 10 on the desk's Sell sheet.
 *
 * J10-1: after a 409 `package_price_changed` the header kept the old discount ("20% off" over a 10%
 * price; "100% off" asking R120) and Back listed the other packages at their old prices — only the
 * chosen package was patched. The 409 body's discount now goes on the sheet and the shelf is re-read.
 *
 * X10-2 / J10-4: the notice was said twice (its standing region and the Sell button's), focus fell
 * to the dialog container, and at 390 px / 200 % the notice sat out of view.
 *
 * X10-3: Next with a missing answer moved nothing — Adjust minutes takes focus to the first complaint.
 */
const scrollIntoView = Element.prototype.scrollIntoView;
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); Element.prototype.scrollIntoView = scrollIntoView; });

const USER = "44444444-4444-4444-4444-444444444444";
const SHELF = `/api/v1/admin/minutes/${USER}/packages`;
const SELL = `/api/v1/admin/minutes/${USER}/sell`;
const POINTER = { button: 0, ctrlKey: false, pointerType: "mouse" } as const;
const LEAGUE = { id: "g1", name: "League" };

const HOUR = shelfPackage({ id: PACKAGE_IDS.hour, name: "1 hour", minutes: 60, list_price_zar: 120, discount_bps: 1000, price_zar: 108, saving_zar: null, saving_pct: null });
const FIVE = shelfPackage({ id: PACKAGE_IDS.five, name: "5 hours", minutes: 300, list_price_zar: 550, discount_bps: 1000, price_zar: 495, saving_zar: null, saving_pct: null });
const HOUR_NOW = { ...HOUR, discount_bps: 2000, price_zar: 96 };
const FIVE_NOW = { ...FIVE, discount_bps: 2000, price_zar: 440 };
const FREE = shelfPackage({ id: PACKAGE_IDS.hour, name: "1 hour", minutes: 60, list_price_zar: 120, discount_bps: 10_000, price_zar: 0, saving_zar: null, saving_pct: null });
const FREE_GONE = { ...FREE, discount_bps: 0, price_zar: 120 };

const WAS = { discount: { bps: 1000, group: LEAGUE }, packages: [HOUR, FIVE] };
const NOW = { discount: { bps: 2000, group: LEAGUE }, packages: [HOUR_NOW, FIVE_NOW] };
const MOVED = refuse(409, { error: "package_price_changed", package: HOUR_NOW, discount: NOW.discount });

/** The nth read answers with the nth shelf, the last repeating (the harness wants `respond` or `body`). */
function inTurn(...shelves: unknown[]) {
  let n = 0;
  return () => shelves[Math.min(n++, shelves.length - 1)];
}

function draw(routes: StubRoute[]) {
  const stub = stubFetch(routes);
  renderPage(<SellPackageSheet userId={USER} name="Thandi" balance={120} onClose={() => {}} onSold={() => {}} />);
  return stub;
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
  const trigger = await screen.findByRole("button", { name: idle });
  trigger.focus();
  fireEvent.click(trigger, { detail: 1 });
  const go = document.querySelector<HTMLButtonElement>("[data-confirm='go']")!;
  go.focus();
  fireEvent.click(go, { detail: 1 });
}

const sheetText = () => document.querySelector("[data-sheet='sell-package']")!.textContent ?? "";
const reads = (stub: ReturnType<typeof stubFetch>) => stub.calls.filter((c) => c.method === "GET" && c.path.startsWith(SHELF));

describe("J10-1 — a moved price moves the whole sheet", () => {
  it("the header takes the 409's discount, the shelf is read again, and Back lists every package at its price now", { timeout: 15_000 }, async () => {
    const stub = draw([
      { path: SHELF, respond: inTurn(WAS, NOW) },
      { method: "POST", path: SELL, respond: () => MOVED },
    ]);
    await toCheck(true);
    expect(sheetText()).toContain(COPY.discountLine(percentOfBps(1000), "League"));
    await press(/^Sell /);
    await waitFor(() => expect(document.querySelector("[data-sale-notice]")).toHaveTextContent(COPY.priceChanged(formatMoney(96), formatMoney(108))));
    expect(sheetText()).toContain(COPY.discountLine(percentOfBps(2000), "League"));
    expect(sheetText()).not.toContain(COPY.discountLine(percentOfBps(1000), "League"));
    await waitFor(() => expect(reads(stub)).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: COPY.back }));
    fireEvent.click(await screen.findByRole("button", { name: COPY.back }));
    const five = await screen.findByRole("radio", { name: /5 hours/ });
    await waitFor(() => expect(five).toHaveTextContent(formatMoney(440)));
    expect(five).not.toHaveTextContent(formatMoney(495));
    expect(screen.getByRole("radio", { name: /1 hour/ })).toHaveTextContent(formatMoney(96));
  });

  it("a free give whose discount vanished drops the '100% off' line", async () => {
    draw([
      { path: SHELF, respond: inTurn({ discount: { bps: 10_000, group: LEAGUE }, packages: [FREE] }, { discount: null, packages: [FREE_GONE] }) },
      { method: "POST", path: SELL, status: 409, body: { error: "package_price_changed", package: FREE_GONE, discount: null } },
    ]);
    await toCheck(false);
    expect(sheetText()).toContain(percentOfBps(10_000));
    await press(/^Give /);
    await waitFor(() => expect(document.querySelector("[data-sale-notice]")).toHaveTextContent(COPY.noLongerFree("Thandi", formatMoney(120))));
    expect(sheetText()).not.toContain(percentOfBps(10_000));
    expect(screen.getByRole("heading", { name: COPY.titleFor("Thandi", false) })).toBeInTheDocument();
  });
});

describe("X10-2 / J10-4 — the moved price is said once, seen, and leaves the keyboard on Sell", () => {
  it("one live region says it, the notice is scrolled into view, focus lands on Sell", async () => {
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = vi.fn(function (this: Element) { scrolled.push(this); });
    draw([
      { path: SHELF, respond: inTurn(WAS, NOW) },
      { method: "POST", path: SELL, respond: () => MOVED },
    ]);
    await toCheck(true);
    await press(/^Sell /);
    const said = COPY.priceChanged(formatMoney(96), formatMoney(108));
    await waitFor(() => expect(document.querySelector("[data-sale-notice]")).toHaveTextContent(said));
    const sell = await screen.findByRole("button", { name: /^Sell / });
    await waitFor(() => expect(document.activeElement).toBe(sell));
    const live = [...document.querySelectorAll("[data-sheet='sell-package'] [aria-live], [data-sheet='sell-package'] [role=alert], [data-sheet='sell-package'] [role=status]")]
      .filter((region) => region.textContent?.includes(said));
    expect(live).toHaveLength(1);
    expect(live[0].closest("[data-sale-notice]")).toBeNull();
    expect(scrolled.some((el) => el.closest("[data-sale-notice]") !== null)).toBe(true);
  });

  it("a gift that now costs money speaks from the notice, the step's own focus taking the keyboard", async () => {
    draw([
      { path: SHELF, respond: inTurn({ discount: null, packages: [FREE] }, { discount: null, packages: [FREE_GONE] }) },
      { method: "POST", path: SELL, status: 409, body: { error: "package_price_changed", package: FREE_GONE, discount: null } },
    ]);
    await toCheck(false);
    await press(/^Give /);
    const said = COPY.noLongerFree("Thandi", formatMoney(120));
    await waitFor(() => expect(document.querySelector("[data-sale-notice]")).toHaveTextContent(said));
    const notice = document.querySelector("[data-sale-notice]")!;
    await waitFor(() => expect(notice.querySelector("[aria-live]")).toHaveTextContent(said));
    await waitFor(() => expect(document.activeElement?.getAttribute("aria-label")).toMatch(/^Step 2 of 3/));
  });
});

describe("X10-3 — Next with a missing answer takes the keyboard to it", () => {
  it("step 1: nothing chosen → the first package, which carries the complaint", async () => {
    draw([{ path: SHELF, body: WAS }]);
    await screen.findByRole("radio", { name: /1 hour/ });
    fireEvent.click(screen.getByRole("button", { name: COPY.next }));
    const first = screen.getByRole("radio", { name: /1 hour/ });
    await waitFor(() => expect(document.activeElement).toBe(first));
    const group = screen.getByRole("radiogroup");
    expect(group).toHaveAttribute("aria-invalid", "true");
    expect(document.getElementById(group.getAttribute("aria-describedby")!)).toHaveTextContent(COPY.pickPackage);
  });

  it("step 2: nothing answered → how it was paid", async () => {
    draw([{ path: SHELF, body: WAS }]);
    fireEvent.click(await screen.findByRole("radio", { name: /1 hour/ }));
    fireEvent.click(screen.getByRole("button", { name: COPY.next }));
    const how = await screen.findByRole("combobox", { name: COPY.paymentLabel });
    fireEvent.click(screen.getByRole("button", { name: COPY.next }));
    await waitFor(() => expect(document.activeElement).toBe(how));
  });

  it("step 2: paid but no note → the note", async () => {
    draw([{ path: SHELF, body: WAS }]);
    fireEvent.click(await screen.findByRole("radio", { name: /1 hour/ }));
    fireEvent.click(screen.getByRole("button", { name: COPY.next }));
    fireEvent.pointerDown(await screen.findByRole("combobox", { name: COPY.paymentLabel }), POINTER);
    fireEvent.click(await screen.findByRole("option", { name: PAYMENT_CHOICES[0].label }));
    fireEvent.click(screen.getByRole("button", { name: COPY.next }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText(SALE_NOTE)));
  });
});
