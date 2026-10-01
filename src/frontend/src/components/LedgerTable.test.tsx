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
 * chosen by the sign. They come back once the TABLE'S box has room (R5 F5-1: every fold is a
 * container query on `@container/ledger`, in rem, never the viewport's `sm`).
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

    // The two columns a member opened the wallet to read. The Comment is never folded; the
    // Amount column only below a 16rem box, where the amount rides in the comment's cell.
    const comment = screen.getByRole("columnheader", { name: /Comment/ });
    expect(comment.className).not.toContain("hidden");
    for (const cell of cellsOf("Comment")) expect(cell.className).not.toContain("hidden");
    const amount = screen.getByRole("columnheader", { name: /Amount/ });
    expect(amount.className).toContain("@[16rem]/ledger:table-cell");
    for (const cell of cellsOf("Amount")) expect(cell.className).toContain("@[16rem]/ledger:table-cell");

    // From and To fold away until the box is 60rem — hidden, not deleted. Never by the viewport.
    for (const label of ["From", "To"]) {
      const header = screen.getByRole("columnheader", { name: new RegExp(label) });
      expect(header.className).toContain("hidden");
      expect(header.className).toContain("@[60rem]/ledger:table-cell");
      expect(header.className).not.toMatch(/(^|\s)sm:/);
      for (const cell of cellsOf(label)) {
        expect(cell.className).toContain("hidden");
        expect(cell.className).toContain("@[60rem]/ledger:table-cell");
        expect(cell.className).not.toMatch(/(^|\s)sm:/);
      }
    }
  });

  /**
   * R5 F5-1 (HIGH): at 390 with 200 % text the box is 10.1rem and the two-column form needs
   * 14.3–15.9rem, so a pinned Amount sat over half the words. Below 16rem the amount (and who it
   * moved to or from) rides in the movement's own cell — and only there.
   */
  it("carries the amount inside the movement's cell for the one-column form only", () => {
    render(<LedgerTable rows={rows} label="Ledger" />);
    for (const cell of cellsOf("Comment")) {
      const stacked = cell.querySelector("[data-stacked-amount]")!;
      expect(stacked.className).toContain("@[16rem]/ledger:hidden");
    }
    // Newest first: the desk credit (2 Sep), then the court (1 Sep).
    const [credit, debit] = cellsOf("Comment").map((c) => c.querySelector("[data-stacked-amount]")!);
    expect(debit).toHaveTextContent("\u221224.00 crClub treasury");
    expect(credit).toHaveTextContent("+2000.00 crClub treasury");
    expect(credit.firstElementChild!.className).toContain("text-success-strong");
    expect(credit.firstElementChild!.className).toContain("whitespace-nowrap");
  });

  /**
   * R5 F5-1 (HIGH) — a book wider than its box scrolls inside its region with the Amount (and the
   * Details beside it) PINNED to the right edge; the pins apply only while the region scrolls.
   * R5 V5-6 — the heads stick to the PAGE under its top bar, and to the region's top while it scrolls.
   */
  it("pins the Amount and Details while the region scrolls, and sticks the heads to the page", () => {
    render(<LedgerTable rows={rows} label="Club book" onOpen={() => undefined} />);
    const amountHead = screen.getByRole("columnheader", { name: /Amount/ });
    expect(amountHead.className.split(" ")).toEqual(expect.arrayContaining([
      "sticky", "[[data-scrolls]_&]:!top-0", "[[data-scrolls]_&]:right-touch", "[[data-scrolls]_&]:z-sticky-corner",
    ]));
    expect(amountHead.style.top).toBe("var(--context-bar-top-height, 0px)");
    for (const cell of cellsOf("Amount")) {
      expect(cell.className.split(" ")).toEqual(expect.arrayContaining(["[[data-scrolls]_&]:sticky", "[[data-scrolls]_&]:right-touch", "[[data-scrolls]_&]:bg-bg-surface"]));
    }
    const details = document.querySelector('tr[data-ledger-row="r1"] td:last-child')!;
    expect(details.className.split(" ")).toEqual(expect.arrayContaining(["w-touch", "px-0", "[[data-scrolls]_&]:sticky", "[[data-scrolls]_&]:right-0"]));
    // The Details button scrolls clear of the sticky heads when focus brings it into view (X5-2).
    expect(details.querySelector("button")!.className).toContain("scroll-mt-14");
  });

  it("pins the Amount at the very edge when no Details column is drawn", () => {
    render(<LedgerTable rows={rows} label="Ledger" />);
    for (const cell of cellsOf("Amount")) expect(cell.className).toContain("[[data-scrolls]_&]:right-0");
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
      // No unconditional truncate, and no phone-width cap: in the compact form the text wraps.
      expect(cell.className).not.toMatch(/(^|\s)truncate(\s|$)/);
      expect(cell.className).not.toMatch(/(^|\s)max-w-\[\d+px\]/);
      expect(cell.className).toContain("break-words");
      // From a 36rem box there is room for a column, so it truncates with the tooltip again.
      expect(cell.className).toContain("@[36rem]/ledger:truncate");
      // P3 (theme-vocabulary ratchet): the cap is the named `max-w-xs` (320 px), not the
      // arbitrary `max-w-[280px]` it replaced — the assertion is on the rule, not the pixel.
      expect(cell.className).toContain("@[36rem]/ledger:max-w-xs");
      // The tooltip stays for a mouse, but it is no longer the only way to read the text.
      // P3: on a phone the Time column folds and the time rides under the comment (and, in the
      // one-column form, the amount) — the tooltip is the comment alone.
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
    expect(time.className).toContain("@[36rem]/ledger:table-cell");
    for (const cell of cellsOf("Comment")) {
      const when = cell.querySelector("time")!;
      expect(when.className).toContain("@[36rem]/ledger:hidden");
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

    // The counterparty line goes once the box draws the From/To columns (60rem): repeating the
    // name under the amount would be noise.
    for (const cell of amounts) {
      expect(cell.querySelector("span")!.className).toContain("@[60rem]/ledger:hidden");
      // R4 form factor: the amount cell is nowrap; the name under it wraps, or a long one held
      // the column wide and squeezed the movement beside it on a phone.
      expect(cell.querySelector("span")!.className.split(" ")).toEqual(expect.arrayContaining(["whitespace-normal", "break-words"]));
    }
  });
  /**
   * R4 form factor, SPEC §4.1 (MED): the club's book passes `wideOnly={["comment"]}`, and the
   * comment cell went `hidden` at EVERY width below the wide threshold — on a phone, where it is
   * the movement + time cell, Transactions read "+25.00 cr / Dispute Partner" with the left half
   * of every row blank. Wide-only means "folded out of the full form until the BOX is wide",
   * never in the compact form.
   */
  it("keeps a wide-only Comment on a phone and folds it only between the compact form and the wide box", () => {
    render(<LedgerTable rows={rows} label="Club book" wideOnly={["comment"]} />);
    const header = screen.getByRole("columnheader", { name: /Comment/ });
    expect(header.classList.contains("hidden")).toBe(false);
    expect(header.className).toContain("@[36rem]/ledger:hidden");
    for (const cell of cellsOf("Comment")) {
      expect(cell.classList.contains("hidden")).toBe(false);
      expect(cell.className).toContain("@[36rem]/ledger:hidden");
      // Back once the TABLE'S box is 84rem (R5 F5-1: measured — at 64rem the Amount went off the edge).
      expect(cell.className).toContain("@[84rem]/ledger:!table-cell");
      expect(cell.querySelector("time")).not.toBeNull();
    }
    expect(header.className).toContain("@[84rem]/ledger:!table-cell");
    expect(document.querySelector("[data-ledger-box]")!.className).toContain("@container/ledger");
  });

  /** R5 F5-1: a book that folds its comment out gives the comment's room to the others, earlier. */
  it("draws From/To at 52rem and Done by at 60rem when the comment is folded out", () => {
    render(<LedgerTable rows={rows} columns={["time", "from", "to", "category", "actor", "comment", "amount"]} label="Club book" wideOnly={["comment"]} />);
    for (const label of ["From", "To"]) {
      expect(screen.getByRole("columnheader", { name: new RegExp(`^${label}`) }).className).toContain("@[52rem]/ledger:table-cell");
      for (const cell of cellsOf(`^${label}`)) expect(cell.className).toContain("@[52rem]/ledger:table-cell");
    }
    expect(screen.getByRole("columnheader", { name: /Done by/ }).className).toContain("@[60rem]/ledger:table-cell");
    for (const cell of cellsOf("Amount")) expect(cell.className).toContain("@[52rem]/ledger:[&>span]:hidden");
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
