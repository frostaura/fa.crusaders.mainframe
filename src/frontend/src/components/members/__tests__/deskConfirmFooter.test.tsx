import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { TopUpSheet } from "../TopUpSheet";
import { SellPackageSheet } from "../SellPackageSheet";
import { renderPage, stubFetch } from "../../../test/harness";
import { PACKAGE_IDS, seededShelf } from "../../../test/minutesFixtures";
import { ADJUST_SHEET, PAYMENT_CHOICES, SELL_COPY } from "../../../lib/deskMinutesCopy";

/**
 * BA-20: the check step of every desk money sheet is ONE footer — Back on its own line, the confirm's
 * full row beneath it — and arming the confirm changes only what is inside the confirm's own box.
 * The adjust sheet used to re-lay its footer into a column under the pointer while the sale's stayed
 * a row, so the two flows moved differently under the same hand.
 */
afterEach(() => vi.unstubAllGlobals());

const POINTER = { button: 0, ctrlKey: false, pointerType: "mouse" } as const;
const USER = "44444444-4444-4444-4444-444444444444";

function footerShape() {
  const footer = document.querySelector<HTMLElement>("[data-desk-confirm]");
  expect(footer).not.toBeNull();
  const back = footer!.firstElementChild!.querySelector("button");
  const press = footer!.querySelector<HTMLElement>("[data-desk-confirm-press]");
  return { footer: footer!, back, press };
}

/** Arms the confirm and proves Back and the press box are the very same nodes, in the same order. */
function armKeepsTheFooter(idle: RegExp) {
  const before = footerShape();
  expect(before.back).toHaveTextContent("Back");
  fireEvent.click(screen.getByRole("button", { name: idle }), { detail: 1 });
  const after = footerShape();
  expect(after.footer).toBe(before.footer);
  expect(after.back).toBe(before.back);
  expect(after.press).toBe(before.press);
  expect(after.press!.querySelector("[data-confirm='go']")).not.toBeNull();
  expect(after.footer.closest("[data-slot='dialog-footer']")).toHaveClass("sm:flex-col");
}

describe("the one desk confirm footer", () => {
  it("is the adjust sheet's", async () => {
    renderPage(<TopUpSheet name="Sam" balance={200} busy={false} bookingError={null} onApply={vi.fn()} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText(ADJUST_SHEET.amountLabel), { target: { value: "15" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.pointerDown(await screen.findByRole("combobox"), POINTER);
    fireEvent.click(await screen.findByRole("option", { name: /^Goodwill/ }));
    fireEvent.change(screen.getByLabelText(ADJUST_SHEET.detailLabel), { target: { value: "Lights failed" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByRole("button", { name: /^Add / });
    armKeepsTheFooter(/^Add /);
  });

  it("is the sale's", async () => {
    stubFetch([{ path: `/api/v1/admin/minutes/${USER}/packages`, body: { discount: null, packages: seededShelf() } }]);
    renderPage(<SellPackageSheet userId={USER} name="Thandi" balance={120} onClose={() => {}} onSold={() => {}} />);
    fireEvent.click(await screen.findByRole("radio", { name: /5 hours/ }));
    fireEvent.click(screen.getByRole("button", { name: SELL_COPY.next }));
    fireEvent.pointerDown(await screen.findByRole("combobox", { name: SELL_COPY.paymentLabel }), POINTER);
    fireEvent.click(await screen.findByRole("option", { name: PAYMENT_CHOICES[0].label }));
    fireEvent.change(screen.getByLabelText(new RegExp(`^${SELL_COPY.detailLabel}\\b`)), { target: { value: "Cash" } });
    fireEvent.click(screen.getByRole("button", { name: SELL_COPY.next }));
    await screen.findByRole("button", { name: /^Sell / });
    expect(PACKAGE_IDS.five).toBeTruthy();
    armKeepsTheFooter(/^Sell /);
  });
});
