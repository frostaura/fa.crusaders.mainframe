import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { UPCOMING } from "@/lib/bookingsCopy";
import type { UpcomingGame } from "@/lib/bookingsApi";
import { GameCard } from "../UpcomingGames";

const GAME: UpcomingGame = {
  booking_id: "b1", court_name: "Court 2", starts_at: "2030-01-01T10:00:00Z", ends_at: "2030-01-01T11:00:00Z",
  role: "payer", status: "Booked", players: [], my_share_minutes: 60, needs_action: false,
};

describe("R7 E7-5 — a court the member paid for at the box", () => {
  it("is badged as paid for, never as theirs to organise", () => {
    render(<MemoryRouter><GameCard game={GAME} zone="UTC" /></MemoryRouter>);
    expect(screen.getByText(UPCOMING.payerBadge)).toBeInTheDocument();
    expect(screen.queryByText(UPCOMING.organiser)).toBeNull();
  });
});
