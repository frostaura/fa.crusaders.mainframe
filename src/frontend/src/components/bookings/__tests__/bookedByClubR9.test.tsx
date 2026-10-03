import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UPCOMING } from "@/lib/bookingsCopy";
import type { UpcomingGame } from "@/lib/bookingsApi";
import { DETAIL_COPY } from "@/lib/playersCopy";
import { signOut } from "@/test/harness";
import { detail, renderDetail, serve } from "@/components/players/__tests__/detailKit";
import { GameCard } from "../UpcomingGames";

vi.mock("@/components/players/PlayerPicker", () => ({ PlayerPicker: () => null, PlayerPickerDialog: () => null }));

/**
 * R9 J9-5 — a booking the club made FOR the member (the desk's "Book for member"): the upcoming
 * card said "You booked" and the booking's page "You organised this game". The API marks it
 * `booked_by_club` (asked of BE9; optional, absent on an older API), and both say the club did.
 */
beforeEach(() => { signOut(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const GAME: UpcomingGame = {
  booking_id: "b1", court_name: "Court 2", starts_at: "2030-01-01T10:00:00Z", ends_at: "2030-01-01T11:00:00Z",
  role: "organiser", status: "Booked", players: [], my_share_minutes: 60, needs_action: false,
};
const byClub = <T extends object>(x: T) => ({ ...x, booked_by_club: true }) as T;

describe("J9-5 — the club booked it for you", () => {
  it("the upcoming card says so, not 'You booked'", () => {
    render(<MemoryRouter><GameCard game={byClub(GAME)} zone="UTC" /></MemoryRouter>);
    expect(screen.getByText(UPCOMING.bookedForYou)).toBeInTheDocument();
    expect(screen.queryByText(UPCOMING.organiser)).toBeNull();
  });

  it("a booking the member made is still theirs", () => {
    render(<MemoryRouter><GameCard game={GAME} zone="UTC" /></MemoryRouter>);
    expect(screen.getByText(UPCOMING.organiser)).toBeInTheDocument();
  });

  it("the booking's page says the club booked it, not 'You organised this game'", async () => {
    serve({ detail: byClub(detail()) });
    renderDetail();
    expect(await screen.findByText(DETAIL_COPY.bookedForYou, { exact: false })).toBeInTheDocument();
    expect(screen.queryByText(DETAIL_COPY.organisedByYou, { exact: false })).toBeNull();
  });
});
