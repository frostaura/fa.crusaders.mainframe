import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { SellPackageSheet } from "../SellPackageSheet";
import { renderPage, stubFetch } from "../../../test/harness";
import { seededShelf } from "../../../test/minutesFixtures";
import { PAYMENT_CHOICES, SELL_COPY as COPY } from "../../../lib/deskMinutesCopy";

/** BA-20: the note's label says "(required)" up front, so it is found by its first word. */
const SALE_NOTE = new RegExp(`^${COPY.detailLabel}\\b`);

/**
 * R15 J15-11 — the Give step at R0.00 said "Cash paid at the desk — 'Staff'" under "Money received
 * R0.00": a payment nobody made. No rand taken is a gift on the check step too; with rand taken the
 * payment is named as before.
 */
afterEach(() => vi.unstubAllGlobals());

const USER = "44444444-4444-4444-4444-444444444444";
const SHELF = `/api/v1/admin/minutes/${USER}/packages`;
const POINTER = { button: 0, ctrlKey: false, pointerType: "mouse" } as const;
const CASH = PAYMENT_CHOICES[0].label;

async function toCheck(zar: string) {
  stubFetch([{ path: SHELF, body: { discount: null, packages: seededShelf() } }]);
  renderPage(<SellPackageSheet userId={USER} name="Thandi" balance={120} onClose={() => {}} onSold={() => {}} />);
  fireEvent.click(await screen.findByRole("radio", { name: /1 hour/ }));
  fireEvent.click(screen.getByRole("button", { name: COPY.next }));
  fireEvent.pointerDown(await screen.findByRole("combobox", { name: COPY.paymentLabel }), POINTER);
  fireEvent.click(await screen.findByRole("option", { name: CASH }));
  fireEvent.change(screen.getByLabelText(COPY.zarLabel), { target: { value: zar } });
  fireEvent.change(screen.getByLabelText(SALE_NOTE), { target: { value: "Staff" } });
  fireEvent.click(screen.getByRole("button", { name: COPY.next }));
  await screen.findByText(COPY.revenueFor(Number(zar)));
}

describe("R15 J15-11 — the check step of a gift names no payment", () => {
  it("R0.00: the note alone, never 'Cash paid at the desk'", async () => {
    await toCheck("0");
    expect(screen.getByText("“Staff”")).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(CASH))).toBeNull();
  });

  it("R120.00: the payment is named", async () => {
    await toCheck("120");
    expect(screen.getByText(`${CASH} — “Staff”`)).toBeInTheDocument();
  });
});
