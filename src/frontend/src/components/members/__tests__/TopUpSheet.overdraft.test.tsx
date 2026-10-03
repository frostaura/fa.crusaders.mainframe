import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { TopUpSheet } from "../TopUpSheet";
import { renderPage } from "@/test/harness";
import { ADJUST_SHEET, TAKE_BACK_LINK } from "@/lib/deskMinutesCopy";

/**
 * Review round 6, J6-8 — "Take minutes back" below zero. The warning is drawn on the AMOUNT step,
 * as the amount is typed, whenever the balance was read (the reviewer's probe typed and pressed
 * Next in one breath and read only steps 2 and 3, where FB's copy now says the debt too). No
 * balance read, no arithmetic and no warning — a figure the console does not have is not zero.
 */
function draw(balance: number | null) {
  renderPage(
    <TopUpSheet name="Pieter" balance={balance} busy={false} bookingError={null} onApply={async () => null} onClose={() => {}} />,
  );
  fireEvent.click(screen.getByRole("button", { name: TAKE_BACK_LINK }));
  fireEvent.change(screen.getByLabelText(ADJUST_SHEET.amountLabel), { target: { value: "150" } });
}

describe("J6-8 — taking minutes back below zero", () => {
  it("warns on the amount step that the member would owe the club", () => {
    draw(120);
    expect(screen.getByText(/they would owe the club 30 minutes/)).toBeInTheDocument();
  });

  it("says nothing it cannot work out when the balance was not read", () => {
    draw(null);
    expect(document.body.textContent).not.toMatch(/owe the club/);
  });
});
