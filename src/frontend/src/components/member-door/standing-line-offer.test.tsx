import { describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach } from "vitest";
import { StandingLine } from "./StandingLine";
import { decisionActionKinds } from "../../lib/memberDoorCopy";
import { memberDoorsOnFixture } from "../../test/harness";

/**
 * One "Book a court" on the screen, and never none.
 *
 * <p>
 * The decision card offers it because the last refusal's reason wants a booking; this line
 * offers it because the club's policy wants one and the member has none. They are the same
 * fact from two sides, and on one screen they were two identical filled brand-coloured
 * buttons a few hundred pixels apart — to somebody standing outside a locked door, two
 * different things they have not understood.
 * </p>
 *
 * <p>
 * <b>Tested here rather than through the page, deliberately.</b> The page-level version of
 * this — render `/my-code`, dismiss the card, assert the offer comes back — went red only
 * when the file ran beside its neighbours, and a test whose answer depends on what else is
 * running is not evidence about the product. The mechanism is one prop; this is the prop.
 * </p>
 */

const DOOR = memberDoorsOnFixture({ policy: "booking_window", next_booking: null }) as never;

const line = (actionOfferedAbove: boolean) => render(
  <MemoryRouter>
    <StandingLine
      door={DOOR}
      cached={null}
      cachedMinutesAgo={0}
      loading={false}
      failure={null}
      code={null}
      staleSince={null}
      hasLiveCode={false}
      actionOfferedAbove={actionOfferedAbove}
    />
  </MemoryRouter>,
);

afterEach(cleanup);

describe("the standing line's offer of a court", () => {
  it("is drawn when nothing above it is offering the same act", () => {
    line(false);
    expect(screen.getByRole("link", { name: "Book a court" })).toHaveAttribute("href", "/bookings") // R15: Bookings lives at /bookings;
  });

  /**
   * The event outranks the standing rule. The card is what just happened to this member at
   * this door; the line is what the club's rule says in general.
   */
  it("yields while the decision card above is offering it", () => {
    line(true);
    expect(screen.queryByRole("link", { name: "Book a court" })).toBeNull();
    // The SENTENCE stays. What is withdrawn is the duplicate control, not the explanation —
    // a member who dismisses the card still has to be told why a door will not open.
    expect(screen.getByText(/nothing booked/i)).toBeInTheDocument();
  });

  /**
   * The half that makes yielding safe: the card is dismissible and this line is permanent,
   * so the page's flag has to follow the card. `decisionActionKinds` reads the same `ARMS`
   * table the card renders from — a call site spelling the rule as `reason === "no_booking"`
   * would be right until an arm changed its mind and silently wrong afterwards.
   */
  it("is only suppressed by a decision that really does offer a court", () => {
    const wantsBooking = { reason: "no_booking", released: false, offline: false };
    const doesNot = { reason: "member_not_active", released: false, offline: false };
    expect(decisionActionKinds(wantsBooking)).toContain("book_a_court");
    expect(decisionActionKinds(doesNot)).not.toContain("book_a_court");
    // And a dismissed card is no card at all, so the page's flag goes false with it and the
    // offer above comes back here — which is the first case in this file.
  });
});
