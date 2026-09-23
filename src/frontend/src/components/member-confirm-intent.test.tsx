import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { WhatsNextCard } from "./onboarding/WhatsNextCard";

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

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// R7/R8 (P4): the booking and cancel dialogs this file used to pin — BookingConfirmModal,
// CancelBookingModal, BulkBookSheet, BulkCancelSheet — are replaced by `components/bookings/
// BookSheet` and `CancelSheet`, which carry no `data-intent` (the thumbs ActionGlyph it themed is
// retired, D5/R8). Their invariants — outcome-named primary, the danger confirm on a cancel, "Back"
// between steps, no mark at rest — are asserted in `components/bookings/__tests__/`.

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
