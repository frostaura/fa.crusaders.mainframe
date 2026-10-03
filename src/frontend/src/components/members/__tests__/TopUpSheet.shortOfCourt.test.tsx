import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { TopUpSheet } from "../TopUpSheet";
import { renderPage, stubFetch } from "@/test/harness";
import { ADJUST_SHEET, TAKE_BACK_LINK, shortOfCourtLine } from "@/lib/deskMinutesCopy";

/**
 * Review round 11, J11-2 — the desk's take-back never said the result leaves the member unable to
 * book, while the member's mail did ("That leaves 5 minutes to spend — less than the 15 minutes a
 * court needs"). The Check step now says it from SPENDABLE (balance − held − owed back) against
 * the club's shortest court, and names the minutes held for partners when there are some.
 */
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const USER = "55555555-5555-5555-5555-555555555555";
const POINTER = { button: 0, ctrlKey: false, pointerType: "mouse" } as const;

async function toCheck(balance: number, amount: string, held = 0, owed = 0) {
  stubFetch([
    { method: "GET", path: `/api/v1/admin/members/${USER}`, body: { held_minutes: held, owed_back_minutes: owed } },
    { method: "GET", path: "/api/v1/admin/settings/", body: { slice_minutes: 15 } },
  ]);
  renderPage(
    <TopUpSheet userId={USER} name="Pieter" balance={balance} busy={false} bookingError={null} onApply={async () => null} onClose={() => {}} />,
  );
  fireEvent.click(screen.getByRole("button", { name: TAKE_BACK_LINK }));
  fireEvent.change(screen.getByLabelText(ADJUST_SHEET.amountLabel), { target: { value: amount } });
  fireEvent.click(screen.getByRole("button", { name: ADJUST_SHEET.next }));
  fireEvent.pointerDown(await screen.findByRole("combobox"), POINTER);
  fireEvent.click((await screen.findAllByRole("option"))[0]);
  fireEvent.change(screen.getByLabelText(ADJUST_SHEET.detailLabel), { target: { value: "Entered twice" } });
  fireEvent.click(screen.getByRole("button", { name: ADJUST_SHEET.next }));
}

describe("J11-2 — a take-back that leaves less than a court", () => {
  it("says what is left to spend against the shortest court, as the mail does", async () => {
    await toCheck(30, "25");
    expect(await screen.findByText("That leaves 5 minutes to spend — less than the 15 minutes a court needs.")).toBeInTheDocument();
  });

  it("counts held minutes out of what is spendable and names them", async () => {
    await toCheck(60, "20", 30);
    expect(await screen.findByText(
      "That leaves 10 minutes to spend — less than the 15 minutes a court needs. "
      + "Their balance also carries 30 minutes held for partners, which they cannot spend.",
    )).toBeInTheDocument();
  });

  it("says nothing when what is left still books a court", async () => {
    await toCheck(60, "20");
    await screen.findByText(ADJUST_SHEET.balanceAfter);
    expect(document.body.textContent).not.toMatch(/a court needs/);
  });
});

describe("shortOfCourtLine", () => {
  const room = { held: 0, owedBack: 0, slot: 15 };
  it("leaves the overdraft to its own warning and says nothing it cannot work out", () => {
    expect(shortOfCourtLine(10, 20, room)).toBeNull();
    expect(shortOfCourtLine(null, 5, room)).toBeNull();
    expect(shortOfCourtLine(30, 25, null)).toBeNull();
  });
  it("says 'nothing to spend' when held and owed eat the rest", () => {
    expect(shortOfCourtLine(40, 20, { held: 10, owedBack: 15, slot: 15 })).toBe(
      "That leaves nothing to spend — a court needs at least 15 minutes. "
      + "Their balance also carries 10 minutes held for partners and 15 minutes owed back to partners, which they cannot spend.",
    );
  });
});
