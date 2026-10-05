import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { SellPackageSheet } from "../SellPackageSheet";
import { renderPage, stubFetch } from "../../../test/harness";
import { seededShelf } from "../../../test/minutesFixtures";
import { PAYMENT_CHOICES, SELL_COPY as COPY } from "../../../lib/deskMinutesCopy";

/**
 * Review round 14, J14-5: a priced package taken for R0.00 at the desk is a gift — the confirm
 * already read "Give … at no charge?", but the button that opened it still said "Sell 1 hour", and
 * the receipt said "sold". The words follow the money received, not only the shelf price.
 */
afterEach(() => vi.unstubAllGlobals());

const USER = "44444444-4444-4444-4444-444444444444";
const SHELF = `/api/v1/admin/minutes/${USER}/packages`;
const SELL = `/api/v1/admin/minutes/${USER}/sell`;
const POINTER = { button: 0, ctrlKey: false, pointerType: "mouse" } as const;

async function toCheck(zar: string) {
  fireEvent.click(await screen.findByRole("radio", { name: /1 hour/ }));
  fireEvent.click(screen.getByRole("button", { name: COPY.next }));
  fireEvent.pointerDown(await screen.findByRole("combobox", { name: COPY.paymentLabel }), POINTER);
  fireEvent.click(await screen.findByRole("option", { name: PAYMENT_CHOICES[0].label }));
  fireEvent.change(screen.getByLabelText(COPY.zarLabel), { target: { value: zar } });
  fireEvent.change(screen.getByLabelText(COPY.detailLabel), { target: { value: "Staff" } });
  fireEvent.click(screen.getByRole("button", { name: COPY.next }));
  await screen.findByText(COPY.revenueFor(Number(zar)));
}

function draw() {
  const sold = (zar: number) => ({ entry_id: "e1", type: "AdminTopUp", reason_code: "top_up_cash", amount_minutes: 60, zar_received: zar,
    balance_before_minutes: 120, balance_after_minutes: 180, member: { user_id: USER, email: "t@x.test" },
    package: { id: seededShelf()[0].id, name: seededShelf()[0].name, minutes: 60, price_zar: 120 } });
  const stub = stubFetch([
    { path: SHELF, body: { discount: null, packages: seededShelf() } },
    { method: "POST", path: SELL, body: sold(0) },
  ]);
  renderPage(<SellPackageSheet userId={USER} name="Thandi" balance={120} onClose={() => {}} onSold={() => {}} />);
  return stub;
}

describe("J14-5 — a sale at R0.00 is given, on the button and the receipt", () => {
  it("R0.00 for a priced package: 'Give 1 hour', the gift confirm, and a 'given' receipt", async () => {
    const stub = draw();
    await toCheck("0");
    expect(screen.queryByRole("button", { name: /^Sell / })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: `${COPY.idleFor(60, true)} — Thandi` }), { detail: 1 });
    expect(await screen.findByText(COPY.confirmFor("Thandi", seededShelf()[0].name, 0))).toBeInTheDocument();
    fireEvent.click(document.querySelector<HTMLButtonElement>("[data-confirm='go']")!, { detail: 1 });
    await waitFor(() => expect(stub.calls.some((c) => c.method === "POST" && c.path === SELL)).toBe(true));
    expect(await screen.findByText(COPY.receiptFor("Thandi", seededShelf()[0].name, 60, true))).toBeInTheDocument();
  });

  it("the same package for its price is still sold", async () => {
    draw();
    await toCheck("120");
    expect(screen.getByRole("button", { name: `${COPY.idleFor(60, false)} — Thandi` })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Give / })).toBeNull();
  });
});
