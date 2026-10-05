import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderPage } from "@/test/harness";
import { BOOK_CONFIRM } from "@/lib/playersCopy";
import { ResultPlayers } from "./PlayersOutcomeView";

/**
 * R16 J16-11 — a booking made with a partner already at their daily limit still books, and the
 * answer says `players_error: "at_daily_limit"` (no seats added). The done step said only "the
 * players weren't added"; it now says who could not be added and why.
 */

const outcome = { bookings: [{ bookingId: "b1", slot: null, links: [], error: "at_daily_limit" }] };
const face = () => "";

describe("R16 J16-11 — the done step when a partner is at their daily limit", () => {
  it("one member: named, with the reason", () => {
    renderPage(<ResultPlayers outcome={outcome} face={face} members={["Pia"]} />);
    expect(screen.getByText(BOOK_CONFIRM.playersAtLimit(["Pia"]))).toBeInTheDocument();
    expect(BOOK_CONFIRM.playersAtLimit(["Pia"])).toBe(
      "Your court is booked, but Pia wasn't added — they've already used their court time for that day. Invite someone else from the booking's page.");
  });

  it("two members: either may be the one, and nobody was added", () => {
    expect(BOOK_CONFIRM.playersAtLimit(["Pia", "Sam"])).toBe(
      "Your court is booked, but no players were added — Pia or Sam has already used their court time for that day. Add players from the booking's page.");
  });

  it("any other players_error keeps the general sentence", () => {
    renderPage(<ResultPlayers outcome={{ bookings: [{ ...outcome.bookings[0], error: "players_failed" }] }} face={face} members={["Pia"]} />);
    expect(screen.getByText(BOOK_CONFIRM.playersError)).toBeInTheDocument();
  });
});
