import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { LedgerTable } from "./LedgerTable";
import type { LedgerRow } from "../lib/api";

/**
 * The ledger table at phone width.
 *
 * <p>
 * Five columns — Time, From, To, Amount, Comment — on a 375 px screen put <b>Amount and
 * Comment off the right edge</b>, so the wallet's ledger opened showing a member two
 * timestamps and two names and neither of the two things they came to read. There is no
 * horizontal scroll affordance on the card, so nothing said the rest existed.
 * </p>
 *
 * <p>
 * From and To are the pair that can go: on a member's own wallet one of them is always
 * the member, so the informative half rides under the amount instead — the counterparty,
 * chosen by the sign. They come back at <code>sm</code>.
 * </p>
 *
 * <p>
 * <b>These are class assertions, deliberately.</b> jsdom computes no layout and applies
 * no Tailwind, so it cannot be asked how wide anything is; a width test here would pass
 * on any markup at all. The responsive decision lives in the class list, so that is what
 * is checked, and the real widths were verified in a browser by the finder.
 * </p>
 */
describe("LedgerTable — what survives a 375px screen", () => {
  const rows: LedgerRow[] = [
    {
      id: "r1", at: "2026-09-01T10:00:00Z",
      from: "Naledi Khumalo", to: "Club treasury",
      amountCredits: 24, signedAmountCredits: -24,
      type: "BookingCharge", comment: "Court 1 · Tue 01 Sep 12:00–12:45",
      subjectUserId: "u1", subjectName: "Naledi Khumalo",
      actorUserId: "u1", actorName: "Naledi Khumalo",
      relatedBookingId: "b1",
    },
    {
      id: "r2", at: "2026-09-02T08:00:00Z",
      from: "Club treasury", to: "Naledi Khumalo",
      amountCredits: 2000, signedAmountCredits: 2000,
      type: "AdminAdjustment", comment: "Desk credit",
      subjectUserId: "u1", subjectName: "Naledi Khumalo",
      actorUserId: "a1", actorName: "Front desk",
      relatedBookingId: null,
    },
  ];

  const cellsOf = (label: string) => {
    const header = screen.getByRole("columnheader", { name: new RegExp(label) });
    const table = header.closest("table")!;
    const index = [...header.parentElement!.children].indexOf(header);
    return [...table.querySelectorAll("tbody tr")].map((tr) => tr.children[index] as HTMLElement);
  };

  it("keeps Amount and Comment on a phone and folds From/To away", () => {
    render(<LedgerTable rows={rows} />);

    // The two columns a member opened the wallet to read. Neither may carry a
    // hidden-below-sm class, because that is the state the finder photographed.
    for (const label of ["Amount", "Comment"]) {
      const header = screen.getByRole("columnheader", { name: new RegExp(label) });
      expect(header.className).not.toContain("hidden");
      for (const cell of cellsOf(label)) expect(cell.className).not.toContain("hidden");
    }

    // From and To fold away below `sm` and come back above it — hidden, not deleted.
    for (const label of ["From", "To"]) {
      const header = screen.getByRole("columnheader", { name: new RegExp(label) });
      expect(header.className).toContain("hidden");
      expect(header.className).toContain("sm:table-cell");
      for (const cell of cellsOf(label)) {
        expect(cell.className).toContain("hidden");
        expect(cell.className).toContain("sm:table-cell");
      }
    }
  });

  it("carries the counterparty under the amount, so folding From/To loses no information", () => {
    render(<LedgerTable rows={rows} />);
    const amounts = cellsOf("Amount");
    const text = amounts.map((c) => c.textContent);

    // A debit's counterparty is who was paid; a credit's is who paid. Picking by sign is
    // what makes one line enough — the member is always the other end. And the amount
    // keeps its sign, with a real U+2212 minus in a tabular column so debits line up.
    expect(text).toContain("\u221224.00 crClub treasury");
    expect(text).toContain("+2000.00 crClub treasury");
    for (const cell of amounts) expect(cell.className).toContain("tabular-nums");

    // The counterparty line is itself mobile-only: above `sm` the From/To columns are
    // back and repeating the name under the amount would be noise.
    for (const cell of amounts) {
      expect(cell.querySelector("span")!.className).toContain("sm:hidden");
    }
  });
});
