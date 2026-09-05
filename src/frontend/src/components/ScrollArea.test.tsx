import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ScrollArea } from "./ScrollArea";
import { LedgerTable } from "./LedgerTable";
import type { LedgerRow } from "../lib/api";

/**
 * A container that hides content has to say so.
 *
 * <p>
 * On a phone the wallet ledger overflowed its container correctly — the page itself never
 * scrolled sideways — and gave no sign of it: no chevron, no gradient, no hint. The two columns
 * a member opens their wallet to read, Amount and Comment, were simply not there as far as the
 * screen was concerned, and the row was cut mid-word.
 * </p>
 *
 * <p>
 * jsdom has no layout, so overflow has to be staged: `scrollWidth` and `clientWidth` are
 * defined on the element directly. That is the whole mechanism the component reads, so staging
 * it is testing the real decision rather than a mock of it.
 * </p>
 */

/** Makes an element report that it is wider than its box, the way a real overflow would. */
function stageOverflow(el: HTMLElement, { scrollWidth, clientWidth, scrollLeft }: {
  scrollWidth: number; clientWidth: number; scrollLeft: number;
}) {
  Object.defineProperty(el, "scrollWidth", { value: scrollWidth, configurable: true });
  Object.defineProperty(el, "clientWidth", { value: clientWidth, configurable: true });
  Object.defineProperty(el, "scrollLeft", { value: scrollLeft, writable: true, configurable: true });
}

function scroller(): HTMLElement {
  return screen.getByRole("region", { name: "Wallet ledger" });
}

describe("ScrollArea", () => {
  it("says nothing when everything already fits", () => {
    render(<ScrollArea label="Wallet ledger"><div>rows</div></ScrollArea>);
    expect(screen.queryByTestId("scroll-hint")).not.toBeInTheDocument();
  });

  it("tells the reader there is more, once there is more", () => {
    render(<ScrollArea label="Wallet ledger"><div>rows</div></ScrollArea>);
    const el = scroller();
    stageOverflow(el, { scrollWidth: 700, clientWidth: 375, scrollLeft: 0 });

    act(() => { el.dispatchEvent(new Event("scroll", { bubbles: true })); });

    expect(screen.getByTestId("scroll-hint")).toHaveTextContent(
      "Wallet ledger scrolls sideways — there is more to see.",
    );
  });

  it("is reachable and operable from the keyboard", () => {
    // A scrolling region with no tab stop cannot be scrolled without a mouse at all — the
    // content is simply unreachable, which is a stronger failure than the missing affordance.
    render(<ScrollArea label="Wallet ledger"><div>rows</div></ScrollArea>);
    const el = scroller();
    expect(el).toHaveAttribute("tabindex", "0");
    el.focus();
    expect(el).toHaveFocus();
  });
});

function ledgerRow(id: string): LedgerRow {
  return {
    id, at: "2026-09-05T10:00:00Z", from: "Club treasury", to: "Erin AgentE",
    amountCredits: 50, signedAmountCredits: -50, type: "BookingCharge",
    comment: "Booking charge", subjectUserId: "u", subjectName: "Erin AgentE",
    actorUserId: "u", actorName: "Erin AgentE", relatedBookingId: null,
  };
}

describe("the wallet ledger", () => {
  it("is a named, scrollable region rather than an anonymous clipped box", () => {
    render(<LedgerTable rows={[ledgerRow("r1")]} label="Wallet ledger" />);
    const el = scroller();

    stageOverflow(el, { scrollWidth: 700, clientWidth: 375, scrollLeft: 0 });
    act(() => { el.dispatchEvent(new Event("scroll", { bubbles: true })); });

    expect(screen.getByTestId("scroll-hint")).toBeInTheDocument();
    // And the Amount column is genuinely in the document — it is off-screen, not absent, and
    // the hint is what makes those two different things to a reader.
    expect(screen.getByRole("columnheader", { name: /Amount/ })).toBeInTheDocument();
  });
});
