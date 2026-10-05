import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import BookingDetailPage from "@/pages/BookingDetail";
import { refuse, renderPage, signOut } from "@/test/harness";
import type { Invite, MySeat } from "@/lib/playersApi";
import { DETAIL_GONE, invitedLine } from "@/lib/playersCopy";
import { inviteHeading } from "../invites/inviteFacts";
import { BOOKING, DETAIL_PATH, PID, STARTS, serve } from "./detailKit";

vi.mock("@/components/players/PlayerPicker", () => ({ PlayerPicker: () => null, PlayerPickerDialog: () => null }));

/**
 * R15 J15-1 — the club's acts were credited to the organiser: an admin's removal read "Olga took
 * you off", and a seat the club added read "Olga invited you". BE15b's `removed_by` (the 404 and the
 * seat read) and `added_by_club` (the invite reads) say whose act it was.
 */

beforeEach(() => { signOut(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const seatOf = (over: Partial<MySeat> = {}): MySeat => ({
  participant_id: PID.alex, booking_id: BOOKING, status: "removed", lapsed: false, settled_outside: false,
  booking_status: "booked", court_name: "Court 4", starts_at: STARTS, ends_at: "2026-09-30T16:45:00Z",
  organiser_name: "Olga", share_minutes: 16, timezone: "Africa/Johannesburg", ...over,
});

function renderAt(url: string) {
  return renderPage(<Routes><Route path="/bookings/:bookingId" element={<BookingDetailPage />} /></Routes>, { initialEntries: [url] });
}

describe("R15 J15-1 — a removal is said as its actor's act", () => {
  it("the club took them off (seat says club): 'The club took you off …', never 'Olga took you off'", async () => {
    serve({
      detail: { path: DETAIL_PATH, respond: () => refuse(404, { error: "booking_not_found", own_seat_id: PID.alex, removed_by: "club" }) },
      extra: [{ path: `/api/v1/me/invites/${PID.alex}`, body: seatOf({ removed_by: "club" }) }],
    });
    renderAt(`/bookings/${BOOKING}`);
    expect(await screen.findByText(DETAIL_GONE.removedTitle)).toBeInTheDocument();
    expect(screen.getByText(/^The club took you off Court 4, /)).toBeInTheDocument();
    expect(screen.queryByText(/Olga took you off/)).toBeNull();
  });

  it("the seat read predates the field but the 404 says club: still the club", async () => {
    serve({
      detail: { path: DETAIL_PATH, respond: () => refuse(404, { error: "booking_not_found", own_seat_id: PID.alex, removed_by: "club" }) },
      extra: [{ path: `/api/v1/me/invites/${PID.alex}`, body: seatOf() }],
    });
    renderAt(`/bookings/${BOOKING}`);
    expect(await screen.findByText(/^The club took you off Court 4, /)).toBeInTheDocument();
  });

  it("the organiser took them off: 'Olga took you off …'", async () => {
    serve({
      detail: { path: DETAIL_PATH, respond: () => refuse(404, { error: "booking_not_found", own_seat_id: PID.alex, removed_by: "organiser" }) },
      extra: [{ path: `/api/v1/me/invites/${PID.alex}`, body: seatOf({ removed_by: "organiser" }) }],
    });
    renderAt(`/bookings/${BOOKING}`);
    expect(await screen.findByText(/^Olga took you off Court 4, /)).toBeInTheDocument();
  });

  it("removed_by null (no record, or a removal before R14): names nobody — never the organiser", async () => {
    serve({
      detail: { path: DETAIL_PATH, respond: () => refuse(404, { error: "booking_not_found", own_seat_id: PID.alex, removed_by: null }) },
      extra: [{ path: `/api/v1/me/invites/${PID.alex}`, body: seatOf({ removed_by: null }) }],
    });
    renderAt(`/bookings/${BOOKING}`);
    expect(await screen.findByText(/^You were taken off Court 4, /)).toBeInTheDocument();
    expect(screen.queryByText(/Olga took you off/)).toBeNull();
  });

  it("the words", () => {
    expect(DETAIL_GONE.removedBody("Olga", "Court 4, Wed 30 Sep, 18:00", "club"))
      .toBe("The club took you off Court 4, Wed 30 Sep, 18:00. Anything you'd paid for it is refunded — your wallet shows it.");
  });
});

const inviteOf = (over: Partial<Invite> = {}): Invite => ({
  participant_id: PID.alex, booking_id: BOOKING, status: "invited", seat: 3, team: "B", open_link: false,
  court_name: "Court 4", starts_at: STARTS, ends_at: "2026-09-30T16:45:00Z",
  organiser: { user_id: "o", name: "Owen Organiser", photo_url: null }, players: 4, share_minutes: 16, to_pay_minutes: 16,
  needs_consent: false, balance_minutes: 100, held_minutes: 0, balance_after_minutes: 84, short_by_minutes: 0,
  share_deadline: STARTS, cap: null, ...over,
});

describe("R15 J15-1 — a seat the club added is said as the club's act", () => {
  it("added by the club: 'The club added you to Owen's game', never 'Owen invited you'", () => {
    const line = inviteHeading(inviteOf({ added_by_club: true }), "Invited").line;
    expect(line).toBe(invitedLine("Owen", false, true));
    expect(line).toBe("The club added you to Owen's game");
  });

  it("invited by the organiser (or an older API): 'Owen invited you to play'", () => {
    expect(inviteHeading(inviteOf({ added_by_club: false }), "Invited").line).toBe("Owen invited you to play");
    expect(inviteHeading(inviteOf(), "Invited").line).toBe("Owen invited you to play");
  });
});
