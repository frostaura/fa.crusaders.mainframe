import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { PLAYERS_REFUSAL, playersRefusal } from "@/lib/playersCopy";

/**
 * R19 J19-5 (BE19j) — adding players to a booking with no room was answered `seat_taken` ("That seat
 * was taken a moment ago. Pick another." — there was no other). The API now says `409 booking_full`
 * when every seat is held, and `409 too_many_players {free_seats}` when fewer seats are free than
 * players asked for. Each is said as what it is; the free-seat figure is used when it comes.
 */
describe("R19 J19-5 — no room is said as no room", () => {
  it("booking_full: four players already", () => {
    expect(playersRefusal(new ApiError(409, { error: "booking_full", max_players: 4 }))).toBe(PLAYERS_REFUSAL.booking_full);
    expect(PLAYERS_REFUSAL.booking_full).toMatch(/four players/);
  });

  it("too_many_players with one seat free: says one, and how many may be added", () => {
    expect(playersRefusal(new ApiError(409, { error: "too_many_players", max_players: 3, free_seats: 1 })))
      .toBe("Only 1 seat is still free on this booking — add 1 player, or fewer.");
  });

  it("too_many_players with two seats free", () => {
    expect(playersRefusal(new ApiError(409, { error: "too_many_players", max_players: 3, free_seats: 2 })))
      .toBe("Only 2 seats are still free on this booking — add 2 players, or fewer.");
  });

  it("the 400 (more than three asked for, no seat figure): the plain limit", () => {
    expect(playersRefusal(new ApiError(400, { error: "too_many_players", max_players: 3 }))).toBe(PLAYERS_REFUSAL.too_many_players);
  });
});
