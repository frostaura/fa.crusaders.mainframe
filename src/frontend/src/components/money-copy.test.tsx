import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { BookingConfirmModal } from "./BookingConfirmModal";
import { CancelBookingModal } from "./CancelBookingModal";
import { SlotCell, type BoardContext } from "./ScheduleCells";
import { ConflictPanel } from "./schedules/ConflictPanel";
import { GroupEditor } from "./groups/GroupEditor";
import { endpoints } from "../lib/api";
import { resetClubCurrencySymbol, setClubCurrencySymbol } from "../lib/currency";
import type { ViewerRules } from "../lib/gridRules";

afterEach(() => { cleanup(); vi.restoreAllMocks(); resetClubCurrencySymbol(); });

/**
 * Every figure a member meets on a screen that spends or returns their money.
 *
 * <p>
 * <b>The rule this file holds is one rule, applied twice.</b> A figure that is READ carries
 * the club's symbol in front of it — `formatMoney`. A figure that is only HEARD, because it
 * lives in an `aria-label` that replaces the element's contents, carries the currency's name
 * — `spokenMoney`, since a symbol is announced as a letter.
 * </p>
 *
 * <p>
 * <b>And where a figure is both, the visible form wins.</b> A button's visible label IS its
 * accessible name, and WCAG 2.5.3 Label in Name requires that name to contain the words on
 * the control — a speech user says what they can see. So "Book for R50.00" is named by those
 * words and is not given a differently-worded spoken name; the pronunciation cost is real and
 * bounded, and it is strictly smaller than the one it replaces, because a leading symbol is
 * announced as a letter IN FRONT of a number where a trailing "cr" was two orphan letters
 * carrying the unit after it.
 * </p>
 */

const BOOKING_INTENT = {
  courtId: "c1",
  courtName: "Court 1",
  startsAtUtc: "2030-09-09T15:00:00Z",
  whenLabel: "Mon, 09 Sep, 17:00",
  sliceMinutes: 45,
  priceCredits: 50,
};

/** A control's accessible name, as the accname computation this repo tests with gives it. */
const nameOf = (el: HTMLElement) => el.getAttribute("aria-label") ?? el.textContent ?? "";

describe("the booking dialog's figures", () => {
  const open = (balanceCredits: number | null = 500) => render(
    <MemoryRouter>
      <BookingConfirmModal
        intent={BOOKING_INTENT}
        balanceCredits={balanceCredits}
        members={[]}
        isAdmin={false}
        onCancel={() => {}}
        onConfirm={async () => ({ kind: "done" })}
      />
    </MemoryRouter>,
  );

  it("prices the confirm button in the club's money, symbol first", () => {
    open();
    expect(screen.getByRole("button", { name: "Book for R50.00" })).toBeInTheDocument();
  });

  it("follows the club onto the button", () => {
    setClubCurrencySymbol("CHF");
    open();
    expect(screen.getByRole("button", { name: "Book for CHF50.00" })).toBeInTheDocument();
  });

  /**
   * <b>WCAG 2.5.3, asserted rather than assumed.</b>
   *
   * <p>
   * The temptation with a symbol is to give the button a spoken `aria-label` — "Book for
   * 50.00 rand" — which is better to hear and unreachable by speech control, because the
   * words a speech user can read are no longer in the name. This control's name is its
   * visible text, exactly, and that is the deliberate call.
   * </p>
   */
  it("names the confirm button by the words printed on it, and nothing else", () => {
    open();
    const button = screen.getByRole("button", { name: /^Book for/ });
    expect(button.getAttribute("aria-label")).toBeNull();
    expect(nameOf(button)).toBe(button.textContent);
    // Which means the spoken noun must NOT have leaked into it.
    expect(nameOf(button)).not.toMatch(/rand|francs/i);
  });

  it("says how far short a member is, in money rather than in an invented unit", () => {
    open(10);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Short by")).toBeInTheDocument();
    expect(within(dialog).getByText("R40.00")).toBeInTheDocument();
    // "Balance after" is deliberately absent here: it is a figure for a booking this dialog
    // has already decided will not happen.
    expect(within(dialog).queryByText("Balance after")).not.toBeInTheDocument();
  });

  it("states the overdraft the override would leave, sign outside the symbol", async () => {
    render(
      <MemoryRouter>
        <BookingConfirmModal
          intent={BOOKING_INTENT}
          balanceCredits={500}
          members={[{ userId: "m1", name: "Thandi", balanceCredits: 10 }]}
          isAdmin
          onCancel={() => {}}
          onConfirm={async () => ({ kind: "short", currentCredits: 10, requiredCredits: 50 })}
        />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText("Book this as"), { target: { value: "member" } });
    fireEvent.change(screen.getByLabelText("Member"), { target: { value: "m1" } });
    fireEvent.click(screen.getByRole("button", { name: /^Book for/ }));

    // "R-40.00" would be a symbol in front of a malformed number.
    const override = await screen.findByRole("button", { name: "Book anyway — leaves -R40.00" });
    expect(override.getAttribute("aria-label")).toBeNull();
  });

  it("carries neither 'cr' nor 'credits' anywhere a member can read", () => {
    open(10);
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).not.toMatch(/\bcr\b/);
    expect(dialog.textContent).not.toMatch(/credits?/i);
  });
});

describe("the cancellation dialog's sentences", () => {
  const quote = (over: Record<string, unknown> = {}) => {
    vi.spyOn(endpoints, "cancellationQuote").mockResolvedValue({
      refundCredits: 35, penaltyCredits: 15, penaltyPct: 30,
      amountChargedCredits: 50, checkedIn: false, ...over,
    } as never);
  };

  const open = (props: Record<string, unknown> = {}) => render(
    <CancelBookingModal
      bookingId="bk-1" courtName="Court 1" whenLabel="Mon, 09 Sep, 17:00"
      asAdmin={false} onClose={() => {}} onConfirm={async () => {}}
      {...props}
    />,
  );

  it("names the penalty and the refund in the club's money", async () => {
    quote();
    open();
    const line = await screen.findByText(/penalty of/);
    expect(line.textContent).toContain("R15.00");
    expect(line.textContent).toContain("R35.00");
  });

  /**
   * "your credit" became "your wallet", and that is a rewrite rather than a substitution.
   *
   * <p>
   * "credit" was carrying two jobs — the unit on a number, and the noun for the place the
   * money lives. Only the first is what the owner's ruling is about, but replacing the noun
   * with a bare symbol would have produced "goes back to your R", so the sentence needed the
   * word the rest of the product already uses for that place: the chip is a wallet, the route
   * is `/wallet`, and the top-up copy says "adds to your wallet".
   * </p>
   */
  it("says where the money goes in a word a member already knows", async () => {
    quote();
    open();
    const line = await screen.findByText(/goes back to/);
    expect(line.textContent).toContain("your wallet");
    expect(line.textContent).not.toMatch(/your credit/);
  });

  it("names the member rather than the desk when an admin is acting for them", async () => {
    quote();
    open({ asAdmin: true, memberName: "Thandi" });
    const line = await screen.findByText(/goes back to/);
    expect(line.textContent).toContain("Thandi's wallet");
  });

  it("states what stays spent once the lights have been on", async () => {
    quote({ checkedIn: true });
    open();
    const line = await screen.findByText(/stays spent/);
    expect(line.textContent).toContain("R50.00");
  });

  it("prices the waiver control the admin is agreeing to", async () => {
    quote();
    open({ asAdmin: true, memberName: "Thandi" });
    await screen.findByText(/Waive the/);
    expect(screen.getByLabelText(/Waive the R15.00 penalty/)).toBeInTheDocument();
  });

  it("carries neither 'cr' nor 'credits' anywhere a member can read", async () => {
    quote();
    open();
    await screen.findByText(/goes back to/);
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).not.toMatch(/\bcr\b/);
    expect(dialog.textContent).not.toMatch(/credits?/i);
  });
});

const RULES: ViewerRules = {
  known: false, adminExempt: false, groups: [], allowedWindows: null, clubHours: null,
  slicePriceCredits: null, maxSlotsPerDay: null, maxMinutesPerDay: null,
  bookedSlotsToday: null, bookedMinutesToday: null, remainingToday: null,
  emptyWindow: null, clubDay: null,
};

const COURT = { id: "c1", number: 1, name: "Court 1", isActive: true, slicePriceCredits: 50 };

const CTX = {
  day: { date: "2030-09-09", timezone: "Africa/Johannesburg", courts: [COURT], slots: [], sliceMinutes: 45 },
  rules: RULES,
  isAdmin: false,
  explain: () => {},
  onBook: () => {},
  onCancel: () => {},
  onLiftBlock: () => {},
  selection: null,
} as unknown as BoardContext;

/**
 * The grid cell is the one money control whose price is NOT its visible label.
 *
 * <p>
 * The button reads "Available"; the price lives in the column header above it, which conveys
 * it by POSITION — exactly what a screen reader cannot perceive, which is why the price is in
 * the cell's own name at all. So there is no visible wording for a spoken form to contradict,
 * WCAG 2.5.3 has nothing to bind, and the name is free to be the one that can be said.
 * </p>
 */
describe("a bookable grid cell", () => {
  const cell = () => render(
    <SlotCell
      ctx={CTX}
      court={COURT as never}
      where="Court 1 at 06:00"
      isHead={() => true}
      startsAtUtc="2030-09-09T04:00:00Z"
      facts={{ minuteOfDay: 360, sliceMinutes: 45, isPast: false, outOfHours: false, peakRestricted: false }}
    />,
  );

  it("says the price in a form a screen reader can pronounce", () => {
    cell();
    expect(screen.getByRole("button", { name: "Book Court 1 at 06:00 for 50.00 rand" })).toBeInTheDocument();
  });

  it("follows the club's currency into the spoken name", () => {
    setClubCurrencySymbol("CHF");
    cell();
    expect(screen.getByRole("button", { name: "Book Court 1 at 06:00 for 50.00 Swiss francs" })).toBeInTheDocument();
  });

  it("drops the noun rather than guessing for a currency it cannot name", () => {
    setClubCurrencySymbol("₸"); // tenge
    cell();
    const button = screen.getByRole("button", { name: /^Book Court 1/ });
    // "for 50.00" inside a sentence that already says what it is buying.
    expect(nameOf(button)).toBe("Book Court 1 at 06:00 for 50.00");
    expect(nameOf(button)).not.toContain("₸");
  });

  it("keeps the symbol out of the spoken name, where it would be read as a letter", () => {
    cell();
    expect(nameOf(screen.getByRole("button", { name: /^Book Court 1/ }))).not.toContain("R50");
  });

  it("says neither 'cr' nor 'credits'", () => {
    cell();
    const button = screen.getByRole("button", { name: /^Book Court 1/ });
    expect(nameOf(button)).not.toMatch(/\bcr\b/);
    expect(nameOf(button)).not.toMatch(/credits?/i);
  });
});

/**
 * The one place a club TYPES a figure, and therefore the one label that has to say what unit
 * the box is in.
 *
 * <p>
 * It read "Credits per slot" — a unit the product no longer writes anywhere else, on the
 * field that sets a court price. The sentence under the field already restates the figure
 * through `formatMoney`, so the label's job is to name the thing, not to invent a unit.
 * </p>
 */
describe("the group pricing field", () => {
  const editor = () => render(
    <GroupEditor
      group={{ id: "g1", name: "League", pricing: { mode: "flat_per_slice", flat_slice_price_credits: 80 } } as never}
      club={{}}
      sliceMinutes={45}
      courtPrice={50}
      clubCaps={{ slotCap: null, minuteCap: null, advanceDays: null }}
      creditsPerZar={1.6}
      blockZar={100}
      saving={false}
      error={null}
      onSave={() => {}}
      onCancel={() => {}}
    />,
  );

  it("names the field without naming a unit the product stopped writing", () => {
    editor();
    expect(screen.queryByLabelText(/credits per slot/i)).toBeNull();
    expect(screen.getByLabelText("Price per slot")).toHaveValue("80");
  });

  it("restates the typed figure in the club's own money underneath it", () => {
    setClubCurrencySymbol("CHF");
    editor();
    expect(screen.getByText(/One slot costs CHF80\.00/)).toBeInTheDocument();
  });
});

describe("the schedule conflict panel", () => {
  const CONFLICTS = [
    {
      occurrence_date: "2030-10-06", court_id: "c1", court_name: "Court 1",
      starts_at: "2030-10-06T16:00:00Z", booking_id: "bk-1", kind: "booking",
      member_name: "Thandi", would_refund_credits: 157,
    },
    {
      occurrence_date: "2030-10-13", court_id: "c1", court_name: "Court 1",
      starts_at: "2030-10-13T16:00:00Z", booking_id: "bk-2", kind: "booking",
      member_name: "Sipho", would_refund_credits: 157,
    },
  ];

  /** Arms the clear-all confirm, which is where the total is stated. */
  const arm = () => {
    render(<ConflictPanel conflicts={CONFLICTS as never} timezone="Africa/Johannesburg" onCleared={() => {}} />);
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: "League from 6 October" } });
    fireEvent.click(screen.getByRole("button", { name: /Cancel 2 bookings/ }));
  };

  /**
   * The CONSEQUENCE, which `ConfirmButton` deliberately renders twice — once as page text and
   * once inside its own live region, so a listener hears what a reader can see.
   */
  const consequence = () => screen.getAllByText(/goes back in full/);

  it("states the total it is about to refund in the club's money", () => {
    arm();
    // The button's own idle label and the consequence beneath it, in one unit rather than two:
    // the label went through `formatMoney` while the sentence composed its own `toFixed` + "cr".
    expect(screen.getByRole("button", { name: /Cancel 2 bookings and refund R314\.00 in full/ })).toBeInTheDocument();
    for (const node of consequence()) expect(node.textContent).toContain("R314.00 goes back in full");
  });

  it("reports what each cancellation actually paid back in the same unit", async () => {
    vi.spyOn(endpoints, "adminCancelBooking").mockResolvedValue({ refunded_credits: 157 } as never);
    arm();
    fireEvent.click(document.querySelector('[data-confirm="go"]') as HTMLElement);
    await waitFor(() => expect(screen.getAllByText(/R157\.00 went back in full\./)).toHaveLength(2));
  });

  it("carries neither 'cr' nor 'credits' on the panel an admin reads before deciding", () => {
    arm();
    for (const node of consequence()) {
      expect(node.textContent).not.toMatch(/\bcr\b/);
      expect(node.textContent).not.toMatch(/credits?/i);
    }
  });
});
