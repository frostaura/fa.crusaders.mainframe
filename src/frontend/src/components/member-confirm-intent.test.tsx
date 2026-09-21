import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { BookingConfirmModal } from "./BookingConfirmModal";
import { CancelBookingModal } from "./CancelBookingModal";
import { BulkBookSheet } from "./BulkBookSheet";
import { BulkCancelSheet } from "./BulkCancelSheet";
import { WhatsNextCard } from "./onboarding/WhatsNextCard";
import { endpoints } from "../lib/api";

/**
 * Item 12, where a member actually meets it — the confirm/decline pairs on the screens that
 * spend or return their money.
 *
 * <p>
 * <b>Three lanes built the halves of this and none of them owned the join.</b> The UI lane put
 * the four-phase theme inside `Button` behind an `intent` prop that defaults to today's look,
 * precisely so that a hundred existing call sites could not be restyled unreviewed. That was
 * the right default and it means the theme reached nothing: `intent` was passed on the
 * primitives demo page and nowhere else in the product. This file is the list of places it
 * must reach, asserted rather than remembered.
 * </p>
 *
 * <p>
 * <b>What is asserted is `data-intent`, not a class.</b> The attribute is the contract between
 * the call site and the theme — `e2e/feedback-theme.spec.ts` counts the same nodes in a real
 * browser, and the glyph and the phases are measured there, where a layout exists. Here the
 * question is only whether each control declares what it MEANS.
 * </p>
 *
 * <p>
 * <b>And the destructive carve-out is asserted alongside it</b>, because it is the half that
 * goes wrong quietly. Ruling 4: a thumbs-up on "Cancel the booking" is the software claiming
 * it approves of a member losing a 15.00 penalty. Those controls declare `destructive`, which
 * draws no thumb, does not celebrate, and settles rather than snapping.
 * </p>
 */

const INTENT_OF = (name: string | RegExp) =>
  screen.getByRole("button", { name }).getAttribute("data-intent");

const BOOKING_INTENT = {
  courtId: "c1",
  courtName: "Court 1",
  startsAtUtc: "2030-09-09T15:00:00Z",
  whenLabel: "Mon, 09 Sep, 17:00",
  sliceMinutes: 45,
  priceCredits: 50,
};

const DAY = {
  date: "2030-09-09",
  timezone: "Africa/Johannesburg",
  courts: [{ id: "c1", number: 1, name: "Court 1", isActive: true }],
  slots: [],
  sliceMinutes: 45,
} as never;

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("the booking dialog says which button is the yes", () => {
  const open = (balanceCredits: number | null = 500) => render(
    <BookingConfirmModal
      intent={BOOKING_INTENT}
      balanceCredits={balanceCredits}
      members={[]}
      isAdmin={false}
      onCancel={() => {}}
      onConfirm={async () => ({ kind: "done" })}
    />,
  );

  it("marks the confirm affirm and the way out decline", () => {
    open();
    expect(INTENT_OF(/Book for/)).toBe("affirm");
    expect(INTENT_OF("Keep looking")).toBe("decline");
  });

  /**
   * The override is an AFFIRMATIVE action with a destructive consequence, and the consequence
   * is what the glyph must not cheer. "Book anyway — leaves -12.00 cr" beside a thumbs-up is
   * the software approving of pushing a member into the red on a desk clerk's judgement.
   */
  it("keeps the overdraft override out of the thumbs, on the danger treatment", async () => {
    render(
      <BookingConfirmModal
        intent={BOOKING_INTENT}
        balanceCredits={500}
        members={[{ userId: "m1", name: "Thandi", balanceCredits: 10 }]}
        isAdmin
        onCancel={() => {}}
        onConfirm={async () => ({ kind: "short", currentCredits: 10, requiredCredits: 50 })}
      />,
    );
    fireEvent.change(screen.getByLabelText("Book this as"), { target: { value: "member" } });
    fireEvent.change(screen.getByLabelText("Member"), { target: { value: "m1" } });
    fireEvent.click(screen.getByRole("button", { name: /Book for/ }));

    const override = await screen.findByRole("button", { name: /Book anyway/ });
    expect(override.getAttribute("data-intent")).toBe("destructive");
  });
});

describe("the cancel dialog does not congratulate a member on a penalty", () => {
  it("is destructive on the confirm and a decline on the way out", async () => {
    vi.spyOn(endpoints, "cancellationQuote").mockResolvedValue({
      refundCredits: 35, penaltyCredits: 15, checkedIn: false,
    } as never);
    render(
      <CancelBookingModal
        bookingId="bk-1" courtName="Court 1" whenLabel="Mon, 09 Sep, 17:00"
        asAdmin={false} onClose={() => {}} onConfirm={async () => {}}
      />,
    );
    await waitFor(() => expect(INTENT_OF("Cancel the booking")).toBe("destructive"));
    expect(INTENT_OF("Keep the booking")).toBe("decline");
  });
});

describe("the bulk sheets", () => {
  it("marks the book-them commit affirm and the abandon decline", () => {
    render(
      <BulkBookSheet
        day={DAY}
        slots={[{ courtId: "c1", courtName: "Court 1", startsAtUtc: BOOKING_INTENT.startsAtUtc, priceCredits: 50 }]}
        members={[]} actorUserId="me" onClose={() => {}} onSettled={() => {}}
      />,
    );
    // Step 1 — the only commitment available is abandoning the sheet.
    expect(INTENT_OF("Cancel")).toBe("decline");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(INTENT_OF(/^Book 1 slot$/)).toBe("affirm");
  });

  /**
   * `Back` is NOT a decline. It abandons nothing — it returns to the previous step with every
   * choice intact — and a thumbs-down on it would teach a member that the mark means "go
   * backwards" on every other screen they meet it. The glyph marks the commit and the abandon,
   * and navigation between two halves of one decision is neither.
   */
  it("leaves step navigation unthemed, because a step back declines nothing", () => {
    render(
      <BulkBookSheet
        day={DAY}
        slots={[{ courtId: "c1", courtName: "Court 1", startsAtUtc: BOOKING_INTENT.startsAtUtc, priceCredits: 50 }]}
        members={[]} actorUserId="me" onClose={() => {}} onSettled={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("button", { name: "Back" })).not.toHaveAttribute("data-intent");
  });

  it("marks the keep-them way out of a bulk cancel a decline", async () => {
    vi.spyOn(endpoints, "cancellationQuote").mockResolvedValue({
      refundCredits: 50, penaltyCredits: 0, checkedIn: false,
    } as never);
    render(
      <BulkCancelSheet
        day={DAY}
        targets={[{ bookingId: "bk-1", courtName: "Court 1", slot: { isMine: true, status: "booked" } as never }]}
        onClose={() => {}} onSettled={() => {}}
      />,
    );
    await waitFor(() => expect(INTENT_OF("Keep them")).toBe("decline"));
  });
});

describe("the onboarding card", () => {
  /**
   * "Got it" acknowledges the instructions — it does not refuse them. A thumbs-down on the
   * only button under a list of steps reads as "no, I do not want to know", which is the
   * opposite of what the member just did.
   */
  it("treats Got it as an acknowledgement rather than a refusal", () => {
    render(
      <MemoryRouter>
        <WhatsNextCard
          booking={{
            court_number: 1,
            starts_at: "2030-09-09T15:00:00Z",
            ends_at: "2030-09-09T15:45:00Z",
          } as never}
          timezone="Africa/Johannesburg"
          doors="yes"
          unlockSeconds={15}
        />
      </MemoryRouter>,
    );
    expect(INTENT_OF("Got it")).toBe("affirm");
  });
});
