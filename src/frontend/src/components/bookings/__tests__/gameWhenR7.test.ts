import { describe, expect, it } from "vitest";
import { when } from "../gameWhen";
import type { UpcomingGame } from "@/lib/bookingsApi";

const NO_SHOW: UpcomingGame & { sold_ends_at?: string } = {
  booking_id: "b1", court_name: "Court 1", starts_at: "2030-01-01T04:24:00Z",
  // The no-show sweep cut ends_at to five minutes in; the game was SOLD to 07:09 club time.
  ends_at: "2030-01-01T04:29:00Z", sold_ends_at: "2030-01-01T05:09:00Z",
  role: "organiser", status: "NoShow", players: [], my_share_minutes: 45, needs_action: false,
};

describe("R7 E7-6 — a recent no-show shows the time it was sold for, not the sweep's cut", () => {
  it("ends at sold_ends_at", () => {
    expect(when(NO_SHOW, "UTC")).toMatch(/04:24–05:09$/);
  });
  it("falls back to ends_at from a server that does not send it", () => {
    const { sold_ends_at: _gone, ...older } = NO_SHOW;
    void _gone;
    expect(when(older, "UTC")).toMatch(/04:24–04:29$/);
  });
});
