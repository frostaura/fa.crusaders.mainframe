import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { render } from "@testing-library/react";
import { LedgerDetailPanel, LedgerDetailSheet } from "./LedgerDetailSheet";
import type { LedgerRow } from "../../lib/api";

/**
 * R7 X7-6: the movement's title is a standalone figure inside words — "Booking charge · −30 min"
 * — and it named the sheet, its close × and the side panel's heading, so a screen reader heard
 * "minus 30 min". The figure is a <Minutes>: the eye reads "−30 min", the name says "minus 30 minutes".
 */
const ROW: LedgerRow = {
  id: "l1", at: "2026-09-30T17:05:00Z", from: "Bea Nkosi", to: "Club", amountMinutes: 30, signedAmountMinutes: -30,
  type: "BookingCharge" as LedgerRow["type"], comment: "", subjectUserId: "u1", subjectName: "Bea Nkosi",
  actorUserId: "u1", actorName: "Bea Nkosi", relatedBookingId: null,
};

describe("LedgerDetailSheet — the movement's name", () => {
  it("names the sheet and its × with the amount in words", async () => {
    render(<MemoryRouter><LedgerDetailSheet row={ROW} onClose={() => {}} /></MemoryRouter>);
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAccessibleName(/· minus 30 minutes$/);
    expect(screen.getByRole("button", { name: /^Close .*· minus 30 minutes$/ })).toBeInTheDocument();
  });

  it("names the side panel's heading the same way", () => {
    render(<MemoryRouter><LedgerDetailPanel row={ROW} onClose={() => {}} /></MemoryRouter>);
    expect(screen.getByRole("heading", { level: 2 })).toHaveAccessibleName(/· minus 30 minutes$/);
  });
});
