import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ClubContact } from "./ClubContact";
import { CONTACT_UNKNOWN, liveContact, staleContact } from "../../lib/memberDoorCopy";

/**
 * The club's number, and the three states a page can be in about it.
 *
 * <p>
 * <b>This component had two and needed three.</b> It took a bare `MemberDoorContact` that
 * the page defaulted to two nulls, so a `/me/door` that failed on first load was
 * indistinguishable from a club that has set neither — and it went on to say so, to a
 * member standing outside a locked building, as a fact about the club. It then told them
 * to go and fix it under Admin settings, which is not a screen a member has.
 * </p>
 *
 * <p>
 * One probe per state, plus the pair that must never be confused: the failed read and the
 * empty answer say different things, and neither is ever the other.
 * </p>
 */
describe("ClubContact", () => {
  afterEach(cleanup);

  const BOTH = { phone: "021 555 0134", email: "desk@club.test" };

  it("offers what the club set, as things that can be pressed", () => {
    render(<ClubContact contact={liveContact(BOTH)} />);

    expect(screen.getByRole("link", { name: "021 555 0134" })).toHaveAttribute("href", "tel:0215550134");
    expect(screen.getByRole("link", { name: "desk@club.test" })).toHaveAttribute("href", "mailto:desk@club.test");
  });

  it("says the club set none when the club set none", () => {
    render(<ClubContact contact={liveContact({ phone: null, email: null })} />);

    expect(screen.getByText(/hasn't given the app a number/)).toBeInTheDocument();
    expect(document.querySelectorAll("a")).toHaveLength(0);
  });

  /** The finding, in one assertion. */
  it("never says the club set none off a read that never landed", () => {
    render(<ClubContact contact={CONTACT_UNKNOWN} />);

    expect(screen.getByText(/Couldn't load the club's number/)).toBeInTheDocument();
    expect(screen.queryByText(/hasn't given the app a number/)).toBeNull();
    expect(document.querySelectorAll("a")).toHaveLength(0);
  });

  /** And never the admin instruction, in any state. */
  it("sends a member to no screen they do not have", () => {
    for (const contact of [liveContact(BOTH), liveContact({ phone: null, email: null }), CONTACT_UNKNOWN]) {
      cleanup();
      render(<ClubContact contact={contact} />);
      expect(document.body.textContent).not.toMatch(/admin settings/i);
    }
  });

  /**
   * A number from an earlier read is still worth dialling — and a stale number passed off
   * as the current one is how a member ends up believing a club changed its number.
   */
  it("keeps a last-known number pressable, with its age beside it", () => {
    render(<ClubContact contact={staleContact({ phone: "021 555 0134", email: null }, 6)} />);

    expect(screen.getByRole("link", { name: "021 555 0134" })).toBeInTheDocument();
    expect(screen.getByText(/This is the number it gave 6 minutes ago/)).toBeInTheDocument();
  });

  it("says nothing about age when the answer is the live one", () => {
    render(<ClubContact contact={liveContact(BOTH)} />);

    expect(screen.queryByText(/minutes ago|a minute ago/)).toBeNull();
  });

  /** A cold thumb in the dark does not aim. */
  it("gives both links a target big enough to press", () => {
    render(<ClubContact contact={liveContact(BOTH)} />);

    for (const link of screen.getAllByRole("link")) {
      expect(link.className).toContain("min-h-11");
    }
  });
});
