import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { forgetClubZone } from "../lib/clubZone";
import { RECENT, UPCOMING } from "../lib/bookingsCopy";
import { signOut } from "../test/harness";
import { openBookings, resetSheets } from "../test/bookingsKit";

vi.mock("../components/bookings/BookSheet", async () => (await import("../test/fakeSheets")).bookSheetModule);
vi.mock("../components/bookings/CancelSheet", async () => (await import("../test/fakeSheets")).cancelSheetModule);

/** Review round 3 on the Bookings page itself (lane F1). */
vi.setConfig({ testTimeout: 20_000 });

beforeEach(() => { forgetClubZone(); resetSheets(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); signOut(); forgetClubZone(); });

function game(overrides: Record<string, unknown>) {
  return {
    booking_id: "bk-1", court_name: "Court 1", starts_at: "2030-09-09T14:00:00Z", ends_at: "2030-09-09T14:30:00Z",
    role: "organiser", status: "booked",
    players: [{ name: "Dean Martin", photo_url: null, status: "accepted" }],
    my_share_credits: 50, needs_action: false, ...overrides,
  };
}
const upcoming = (items: unknown[]) => ({ path: "/api/v1/me/bookings/upcoming", body: { timezone: "Africa/Johannesburg", items } });
const recent = (items: unknown[]) => ({ path: "/api/v1/me/bookings/recent", body: { timezone: "Africa/Johannesburg", items } });

const OPEN_SEAT = { name: null, photo_url: null, status: "invited" };
const INVITED_SAM = { name: "Sam Petersen", photo_url: null, status: "invited" };

describe("R3 V-1 — a game with an unclaimed invite-link seat does not crash the Bookings page", () => {
  it("draws the upcoming game, naming only the players who have a name", async () => {
    openBookings({ routes: [upcoming([game({ players: [{ name: "Dean Martin", photo_url: null, status: "accepted" }, OPEN_SEAT] })])] });
    const region = await screen.findByRole("region", { name: UPCOMING.title });
    const card = within(region).getByRole("link", { name: /^Court 1/ });
    expect(card).toHaveTextContent("Dean");
    expect(card).not.toHaveTextContent("null");
    // The grid is still there — the page did not fall over.
    expect(await screen.findByRole("grid")).toBeTruthy();
  });

  it("draws a recent game with an open seat too", async () => {
    openBookings({
      routes: [recent([{ ...game({ booking_id: "bk-past", players: [OPEN_SEAT] }), result_status: "none", can_record: false }])],
    });
    const region = await screen.findByRole("region", { name: RECENT.title });
    expect(within(region).getByRole("link", { name: /^Court 1/ })).not.toHaveTextContent("null");
  });
});

describe("R3 M-3 — the game lists name only the players who said yes", () => {
  it("counts an invited partner as still to answer instead of naming them as playing", async () => {
    openBookings({ routes: [upcoming([game({ players: [{ name: "Dean Martin", photo_url: null, status: "accepted" }, INVITED_SAM, OPEN_SEAT] })])] });
    const region = await screen.findByRole("region", { name: UPCOMING.title });
    const card = within(region).getByRole("link", { name: /^Court 1/ });
    expect(card).toHaveTextContent(UPCOMING.people(["Dean"], 2).replace(/\s+/g, " "));
    expect(card).not.toHaveTextContent("Sam");
    // No face for Sam either: only Dean's avatar is drawn.
    expect(within(card).queryByRole("img", { name: "Sam Petersen" })).toBeNull();
  });
});

describe("R3 V-9 — the share never trails the names behind a separator that can dangle", () => {
  it("puts the share on its own line, and keeps the names' separator glued to the name before it", async () => {
    openBookings({ routes: [upcoming([game({ players: [{ name: "Dean Martin", photo_url: null, status: "accepted" }, INVITED_SAM], my_share_credits: 25 })])] });
    const region = await screen.findByRole("region", { name: UPCOMING.title });
    const share = within(region).getByText(UPCOMING.share(25));
    expect(share.textContent?.startsWith("·")).toBe(false);
    expect(UPCOMING.people(["Dean"], 1)).toMatch(/Dean\u00a0· 1/);
  });
});
