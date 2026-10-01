import { act, fireEvent, screen, within } from "@testing-library/react";
import { LIFT_HOLD_SHEET } from "../lib/bookingsCopy";

/**
 * R5 A5-1 — a hold's Lift opens a confirm sheet that needs a reason. Presses Lift, writes the
 * reason and confirms; returns the sheet it went through.
 */
export async function liftWithReason(liftButton: HTMLElement, reason = "League moved to Thursday"): Promise<HTMLElement> {
  fireEvent.click(liftButton);
  const sheet = await screen.findByRole("dialog", { name: LIFT_HOLD_SHEET.title });
  fireEvent.change(within(sheet).getByRole("textbox", { name: LIFT_HOLD_SHEET.reasonLabel }), { target: { value: reason } });
  await act(async () => { fireEvent.click(within(sheet).getByRole("button", { name: LIFT_HOLD_SHEET.confirm })); });
  return sheet;
}
