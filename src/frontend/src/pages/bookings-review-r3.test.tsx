import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { forgetClubZone } from "../lib/clubZone";
import { RECENT, UPCOMING } from "../lib/bookingsCopy";
import { liftWithReason } from "../test/liftHold";
import { HOLD_LIFTED, HOLD_LIFT_OFFLINE, HOLD_LIFT_UNANSWERED, HOLD_LIFT_UNKNOWN } from "../lib/scheduleEnd";
import { refuse, signOut } from "../test/harness";
import { COURT_A, dayFixture, openBookings, resetSheets, sast, slotRow } from "../test/bookingsKit";

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

describe("R3 lost-reply audit — lifting a hold whose answer was lost reads the day back", () => {
  const HELD = dayFixture({
    slots: [slotRow({ courtId: COURT_A, startsAtUtc: sast(17), endsAtUtc: sast(17, 30), status: "adminblock",
      bookingId: "hold-1", blockLabel: "League night", checkedIn: null, amountChargedCredits: null })],
  });
  const LIFT = "Lift the League night hold on Court 1 at 17:00";

  it("a lift that landed but lost its reply says lifted and shows the court free", async () => {
    let lifted = false;
    openBookings({
      isAdmin: true,
      routes: [
        { path: "/api/v1/schedule", respond: () => (lifted ? dayFixture() : HELD) },
        { method: "DELETE", path: "/api/v1/admin/blocks/hold-1", respond: () => { lifted = true; return refuse(504, {}); } },
      ],
    });
    await liftWithReason(await screen.findByRole("button", { name: LIFT }));
    expect(await screen.findByText(HOLD_LIFTED)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /^Book Court 1 at 17:00/ })).toBeInTheDocument();
  });

  it("a lift that did not land says the hold is still there, and draws it", async () => {
    openBookings({
      isAdmin: true,
      routes: [
        { path: "/api/v1/schedule", body: HELD },
        { method: "DELETE", path: "/api/v1/admin/blocks/hold-1", respond: () => refuse(503, {}) },
      ],
    });
    await liftWithReason(await screen.findByRole("button", { name: LIFT }));
    expect(await screen.findByText(HOLD_LIFT_UNANSWERED)).toBeInTheDocument();
    expect(await screen.findByRole("gridcell", { name: "Court 1 at 17:00 — held by the club for League night" })).toBeInTheDocument();
  });

  it("when the day cannot be read either, it says it cannot tell and keeps the hold drawn", async () => {
    let down = false;
    openBookings({
      isAdmin: true,
      routes: [
        { path: "/api/v1/schedule", respond: () => (down ? refuse(503, {}) : HELD) },
        { method: "DELETE", path: "/api/v1/admin/blocks/hold-1", respond: () => { down = true; return refuse(504, {}); } },
      ],
    });
    await liftWithReason(await screen.findByRole("button", { name: LIFT }));
    expect(await screen.findByText(HOLD_LIFT_UNKNOWN)).toBeInTheDocument();
    expect(screen.getByRole("gridcell", { name: "Court 1 at 17:00 — held by the club for League night" })).toBeInTheDocument();
  });

  it("offline, nothing is sent and the hold stays", async () => {
    const stub = openBookings({ isAdmin: true, day: HELD });
    const lift = await screen.findByRole("button", { name: LIFT });
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    await liftWithReason(lift);
    expect(await screen.findByText(HOLD_LIFT_OFFLINE)).toBeInTheDocument();
    await waitFor(() => expect(stub.calls.some((c) => c.method === "DELETE")).toBe(false));
    vi.restoreAllMocks();
  });
});

describe("R3 M-3 — the card says what the game has cost, not the share it would be", () => {
  it("an organiser whose partner never accepted has paid the whole price", async () => {
    openBookings({ routes: [upcoming([game({ players: [{ name: "Dean Martin", photo_url: null, status: "accepted" }, INVITED_SAM], my_share_credits: 25, my_paid_credits: 50, my_owing_credits: 0 })])] });
    const region = await screen.findByRole("region", { name: UPCOMING.title });
    const card = within(region).getByRole("link", { name: /^Court 1/ });
    expect(card).toHaveTextContent(UPCOMING.paid(50));
    expect(card).not.toHaveTextContent(UPCOMING.share(25));
  });

  it("a partner who has not paid yet is told what they owe", async () => {
    openBookings({ routes: [upcoming([game({ role: "partner", my_share_credits: 25, my_paid_credits: 0, my_owing_credits: 25, needs_action: true })])] });
    const region = await screen.findByRole("region", { name: UPCOMING.title });
    expect(within(region).getByRole("link", { name: /^Court 1/ })).toHaveTextContent(UPCOMING.owe(25));
  });

  it("a server without the figures still gets the share line", async () => {
    openBookings({ routes: [upcoming([game({ my_share_credits: 40 })])] });
    const region = await screen.findByRole("region", { name: UPCOMING.title });
    expect(within(region).getByRole("link", { name: /^Court 1/ })).toHaveTextContent(UPCOMING.share(40));
  });
});
