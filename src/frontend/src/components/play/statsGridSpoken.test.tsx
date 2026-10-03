import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatsGrid } from "./StatsGrid";

/** R6 X6-2 — the profile's time tile is seen as "6 h 45 min" and heard in words. */
describe("the time-on-court tile", () => {
  it("pairs the compact figure with its spoken words", () => {
    render(<StatsGrid stats={{
      sessions_attended: 3, minutes_on_court: 405, minutes_this_year: 900,
      matches_won: 1, matches_lost: 0, games_won: 3, games_lost: 1, win_rate_percent: 100,
    } as never} />);
    const tile = document.querySelector('[data-stat="time"]') as HTMLElement;
    expect(tile.querySelector('[aria-hidden="true"]')).toHaveTextContent("6 h 45 min");
    expect(tile.querySelector(".sr-only")).toHaveTextContent("6 hours 45 minutes");
    expect(screen.getByText("15 hours this year")).toBeInTheDocument();
  });
});
