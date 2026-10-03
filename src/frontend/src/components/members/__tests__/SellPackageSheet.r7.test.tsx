import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { SellPackageSheet } from "../SellPackageSheet";
import { TopUpSheet } from "../TopUpSheet";
import { renderPage, stubFetch, type StubRoute } from "../../../test/harness";
import { PACKAGE_IDS, seededShelf, shelfPackage } from "../../../test/minutesFixtures";
import { ADJUST_SHEET, PAYMENT_CHOICES, SELL_COPY as COPY } from "../../../lib/deskMinutesCopy";

/**
 * Review round 7 on the desk's sheets: the payment step's refusal names the payment (J7-6); a
 * package that costs the member nothing is GIVEN — no payment questions, not revenue, `package_free`
 * (J7-10, the integrator's contract); and every Next / Back takes focus to the new step, named (X7-5).
 */
afterEach(() => vi.unstubAllGlobals());

const USER = "44444444-4444-4444-4444-444444444444";
const SHELF = `/api/v1/admin/minutes/${USER}/packages`;
const SELL = `/api/v1/admin/minutes/${USER}/sell`;
const POINTER = { button: 0, ctrlKey: false, pointerType: "mouse" } as const;

const FREE = shelfPackage({ id: PACKAGE_IDS.five, name: "Coaching gift", minutes: 300, list_price_zar: 550, price_zar: 0, discount_bps: 10_000, saving_zar: 550, saving_pct: 100 });

function draw(routes: StubRoute[]) {
  const stub = stubFetch(routes);
  renderPage(<SellPackageSheet userId={USER} name="Thandi" balance={120} onClose={() => {}} onSold={() => {}} />);
  return stub;
}

describe("J7-6 — the payment step asks for the payment", () => {
  it("says 'Choose how it was paid.' under How was it paid?", async () => {
    draw([{ path: SHELF, body: { discount: null, packages: seededShelf() } }]);
    fireEvent.click(await screen.findByRole("radio", { name: /1 hour/ }));
    fireEvent.click(screen.getByRole("button", { name: COPY.next }));
    fireEvent.click(await screen.findByRole("button", { name: COPY.next }));
    expect(await screen.findByText(COPY.paymentMissing)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: COPY.paymentLabel })).toHaveAccessibleDescription(expect.stringContaining(COPY.paymentMissing));
  });
});

describe("J7-10 — a R0.00 package is given, not sold for cash", () => {
  it("asks no payment questions, says it is not revenue, and sends package_free with no rand", async () => {
    const stub = draw([
      { path: SHELF, body: { discount: null, packages: [FREE] } },
      { method: "POST", path: SELL, body: { entry_id: "e1", type: "AdminTopUp", reason_code: "package_free", amount_minutes: 300, zar_received: 0,
        balance_before_minutes: 120, balance_after_minutes: 420, member: { user_id: USER, email: "t@x.test" },
        package: { id: FREE.id, name: FREE.name, minutes: 300, price_zar: 0 } } },
    ]);
    fireEvent.click(await screen.findByRole("radio", { name: /Coaching gift/ }));
    fireEvent.click(screen.getByRole("button", { name: COPY.next }));
    expect(await screen.findByText(COPY.freeNote)).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: COPY.paymentLabel })).toBeNull();
    expect(screen.queryByLabelText(COPY.zarLabel)).toBeNull();
    // Still a note: the member sees why on their wallet.
    fireEvent.click(screen.getByRole("button", { name: COPY.next }));
    expect(await screen.findByText(/Say why this one/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(COPY.detailLabel), { target: { value: "League prize" } });
    fireEvent.click(screen.getByRole("button", { name: COPY.next }));
    expect(await screen.findByText(COPY.revenueFor(0))).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(PAYMENT_CHOICES[0].label);
    expect(screen.queryByText(COPY.zarRow)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Sell / }), { detail: 1 });
    expect(await screen.findByText(COPY.confirmFor("Thandi", FREE.name, 0))).toBeInTheDocument();
    fireEvent.click(document.querySelector<HTMLButtonElement>("[data-confirm='go']")!, { detail: 1 });
    await waitFor(() => expect(stub.calls.some((c) => c.method === "POST" && c.path === SELL)).toBe(true));
    const sent = stub.calls.find((c) => c.method === "POST" && c.path === SELL)!.body as Record<string, unknown>;
    expect(sent.reasonCode).toBe("package_free");
    expect(sent.zarReceived).toBeUndefined();
  });

  it("a priced package still asks how it was paid and counts as revenue", async () => {
    draw([{ path: SHELF, body: { discount: null, packages: seededShelf() } }]);
    fireEvent.click(await screen.findByRole("radio", { name: /1 hour/ }));
    fireEvent.click(screen.getByRole("button", { name: COPY.next }));
    expect(await screen.findByRole("combobox", { name: COPY.paymentLabel })).toBeInTheDocument();
    expect(screen.queryByText(COPY.freeNote)).toBeNull();
    fireEvent.pointerDown(screen.getByRole("combobox", { name: COPY.paymentLabel }), POINTER);
    fireEvent.click(await screen.findByRole("option", { name: PAYMENT_CHOICES[0].label }));
    fireEvent.change(screen.getByLabelText(COPY.detailLabel), { target: { value: "Receipt 1" } });
    fireEvent.click(screen.getByRole("button", { name: COPY.next }));
    expect(await screen.findByText(COPY.revenueFor(120))).toBeInTheDocument();
  });
});

const focusedName = () => document.activeElement?.getAttribute("aria-label") ?? null;

describe("X7-5 — Next and Back take focus to the new step and name it", () => {
  it("Sell: package → payment → back", async () => {
    draw([{ path: SHELF, body: { discount: null, packages: seededShelf() } }]);
    fireEvent.click(await screen.findByRole("radio", { name: /1 hour/ }));
    fireEvent.click(screen.getByRole("button", { name: COPY.next }));
    await waitFor(() => expect(focusedName()).toBe(`Step 2 of 3: ${COPY.steps[1]}`));
    fireEvent.click(screen.getByRole("button", { name: COPY.back }));
    await waitFor(() => expect(focusedName()).toBe(`Step 1 of 3: ${COPY.steps[0]}`));
  });

  it("Adjust: amount → reason", async () => {
    stubFetch([]);
    renderPage(<TopUpSheet name="Thandi" balance={120} busy={false} bookingError={null} onApply={async () => null} onClose={() => {}} />);
    fireEvent.change(screen.getByRole("textbox", { name: ADJUST_SHEET.amountLabel }), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: ADJUST_SHEET.next }));
    await waitFor(() => expect(focusedName()).toBe(`Step 2 of 3: ${ADJUST_SHEET.steps[1]}`));
  });
});
