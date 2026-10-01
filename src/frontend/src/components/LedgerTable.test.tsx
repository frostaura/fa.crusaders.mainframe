import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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
    render(<LedgerTable rows={rows} label="Ledger" />);

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

  it("lets the Comment wrap on a phone instead of ellipsising it out of reach", () => {
    render(<LedgerTable rows={rows} label="Ledger" />);

    // The comment is the only column that says what a movement WAS, and for a top-up the
    // only place the rand amount and the conversion rate appear at all. It was capped at
    // 140px and ellipsised at EVERY width, so at 375px every row read "Booking Court 2 2…"
    // / "PayFast top-up (R100.00 → 160…" — and the container offered 30px of sideways
    // travel against a 287px cell, so the sentence under the table promising "there is
    // more to see" was true of the table and false of this column. The only escape was a
    // `title` tooltip, which a touch device has no way to open.
    for (const cell of cellsOf("Comment")) {
      // No unconditional truncate, and no phone-width cap: below `sm` the text wraps.
      expect(cell.className).not.toMatch(/(^|\s)truncate(\s|$)/);
      expect(cell.className).not.toMatch(/(^|\s)max-w-\[\d+px\]/);
      expect(cell.className).toContain("break-words");
      // From `sm` up there is room for a column, so it truncates with the tooltip again.
      expect(cell.className).toContain("sm:truncate");
      // P3 (theme-vocabulary ratchet): the cap is the named `max-w-xs` (320 px), not the
      // arbitrary `max-w-[280px]` it replaced — the assertion is on the rule, not the pixel.
      expect(cell.className).toContain("sm:max-w-xs");
      // The tooltip stays for a mouse, but it is no longer the only way to read the text.
      // P3: on a phone the Time column folds and the time rides under the comment, so the
      // cell's text is the comment plus its time — the tooltip is the comment alone.
      expect(cell.textContent!.startsWith(cell.getAttribute("title")!)).toBe(true);
    }
  });

  /**
   * P3 — the header says which way a column runs in words (`aria-sort`), not only by caret, and
   * money reads by sign: a debit is never painted in the warning ink (spending your own credit
   * on a court is not something to look at), a credit is the success ink.
   */
  it("says the sort in aria-sort and colours money by its sign, never debits as a warning", () => {
    render(<LedgerTable rows={rows} label="Ledger" />);
    expect(screen.getByRole("columnheader", { name: /Time/ })).toHaveAttribute("aria-sort", "descending");
    expect(screen.getByRole("columnheader", { name: /Amount/ })).toHaveAttribute("aria-sort", "none");
    const amounts = cellsOf("Amount");
    const debit = amounts.find((c) => c.textContent!.startsWith("\u2212"))!;
    const credit = amounts.find((c) => c.textContent!.startsWith("+"))!;
    expect(debit.className).not.toContain("warning");
    expect(credit.className).toContain("text-success-strong");
    // And nothing in the table is below the 12 px floor (the counterparty line was 10 px).
    expect(document.body.innerHTML).not.toMatch(/text-\[\d+px\]/);
  });

  /** P3 — mobile rows: two columns, the movement (time under it) and the money (who under it). */
  it("folds Time on a phone and carries it under the comment instead", () => {
    render(<LedgerTable rows={rows} label="Ledger" />);
    const time = screen.getByRole("columnheader", { name: /Time/ });
    expect(time.className).toContain("hidden");
    expect(time.className).toContain("sm:table-cell");
    for (const cell of cellsOf("Comment")) {
      const when = cell.querySelector("time")!;
      expect(when.className).toContain("sm:hidden");
    }
    // Money is the last column, where a ledger keeps it.
    const heads = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(heads[heads.length - 1]).toBe("Amount");
  });

  it("carries the counterparty under the amount, so folding From/To loses no information", () => {
    render(<LedgerTable rows={rows} label="Ledger" />);
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
      // R4 form factor: the amount cell is nowrap; the name under it wraps, or a long one held
      // the column wide and squeezed the movement beside it on a phone.
      expect(cell.querySelector("span")!.className.split(" ")).toEqual(expect.arrayContaining(["whitespace-normal", "break-words"]));
    }
  });
  /**
   * R4 form factor, SPEC §4.1 (MED): the club's book passes `wideOnly={["comment"]}`, and the
   * comment cell went `hidden` at EVERY width below the wide threshold — on a phone, where it is
   * the movement + time cell, Transactions read "+25.00 cr / Dispute Partner" with the left half
   * of every row blank. Wide-only means "folded from `sm` until the BOX is wide", never on a phone.
   */
  it("keeps a wide-only Comment on a phone and folds it only between sm and the wide box", () => {
    render(<LedgerTable rows={rows} label="Club book" wideOnly={["comment"]} />);
    const header = screen.getByRole("columnheader", { name: /Comment/ });
    expect(header.classList.contains("hidden")).toBe(false);
    expect(header.className).toContain("sm:hidden");
    for (const cell of cellsOf("Comment")) {
      expect(cell.classList.contains("hidden")).toBe(false);
      expect(cell.className).toContain("sm:hidden");
      // Back once the TABLE'S box is 64rem — beside the admin rail a viewport breakpoint lies.
      expect(cell.className).toContain("@[64rem]/ledger:!table-cell");
      expect(cell.querySelector("time")).not.toBeNull();
    }
    expect(header.className).toContain("@[64rem]/ledger:!table-cell");
    expect(document.querySelector("[data-ledger-box]")!.className).toContain("@container/ledger");
  });
  /**
   * R4 form factor (SPEC §3.9): with a movement open BESIDE the book, ↑/↓ inside the table open
   * the row below or above it, in the order the table shows — newest first — and mark it.
   */
  it("walks the open movement with the arrow keys, in the table's order", () => {
    const opened: string[] = [];
    const { rerender } = render(<LedgerTable rows={rows} label="Club book" onOpen={(row) => opened.push(row.id)} selectedId="r2" />);
    expect(document.querySelector('tr[data-ledger-row="r2"]')).toHaveAttribute("aria-current", "true");
    const first = document.querySelector('tr[data-ledger-row="r2"] button') as HTMLElement;
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(opened).toEqual(["r1"]);
    rerender(<LedgerTable rows={rows} label="Club book" onOpen={(row) => opened.push(row.id)} selectedId="r1" />);
    fireEvent.keyDown(document.querySelector('tr[data-ledger-row="r1"] button') as HTMLElement, { key: "ArrowUp" });
    expect(opened).toEqual(["r1", "r2"]);
  });
});
