import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import BookingDetailPage from "@/pages/BookingDetail";
import { refuse, renderPage, signOut } from "@/test/harness";
import type { MySeat } from "@/lib/playersApi";
import { DETAIL_COPY, DETAIL_GONE } from "@/lib/playersCopy";
import { BOOKING, DETAIL_PATH, PID, STARTS, serve } from "./detailKit";

vi.mock("@/components/players/PlayerPicker", () => ({ PlayerPicker: () => null, PlayerPickerDialog: () => null }));

/**
 * R14 J14-10 — an old link without `?seat=` (an invite, a "Share paid" mail, an older inbox line)
 * opened "Booking not found" for a member taken off the game. The 404 now carries the viewer's own
 * closed seat (`own_seat_id`, BE14b §6 — PlayersEndpoints.DetailAsync); the page reads it like `?seat=`.
 */

beforeEach(() => { signOut(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const seatOf = (status: MySeat["status"]): MySeat => ({
  participant_id: PID.alex, booking_id: BOOKING, status, lapsed: false, settled_outside: false,
  booking_status: "booked", court_name: "Court 4", starts_at: STARTS, ends_at: "2026-09-30T16:45:00Z",
  organiser_name: "Olga", share_minutes: 16, timezone: "Africa/Johannesburg",
});

function renderAt(url: string) {
  return renderPage(
    <Routes>
      <Route path="/bookings/:bookingId" element={<BookingDetailPage />} />
      <Route path="/bookings" element={<p>The bookings grid</p>} />
    </Routes>,
    { initialEntries: [url] },
  );
}

describe("R14 J14-10 — the 404's own_seat_id says what became of the member's seat", () => {
  it("removed, no ?seat=: 'You were taken off this game'", async () => {
    serve({
      detail: { path: DETAIL_PATH, respond: () => refuse(404, { error: "booking_not_found", own_seat_id: PID.alex }) },
      extra: [{ path: `/api/v1/me/invites/${PID.alex}`, body: seatOf("removed") }],
    });
    renderAt(`/bookings/${BOOKING}`);
    expect(await screen.findByText(DETAIL_GONE.removedTitle)).toBeInTheDocument();
    // R15 J15-1 — no removed_by on the wire: the removal names nobody, never the organiser.
    expect(screen.getByText(/^You were taken off Court 4, /)).toBeInTheDocument();
    expect(screen.queryByText(DETAIL_COPY.notFoundTitle)).toBeNull();
  });

  it("withdrawn, no ?seat=: the left-the-game words", async () => {
    serve({
      detail: { path: DETAIL_PATH, respond: () => refuse(404, { error: "booking_not_found", own_seat_id: PID.alex }) },
      extra: [{ path: `/api/v1/me/invites/${PID.alex}`, body: seatOf("withdrawn") }],
    });
    renderAt(`/bookings/${BOOKING}`);
    expect(await screen.findByText(DETAIL_GONE.leftTitle)).toBeInTheDocument();
  });

  it("own_seat_id null (a stranger): the general sentence, and no seat is read", async () => {
    const stub = serve({ detail: { path: DETAIL_PATH, respond: () => refuse(404, { error: "booking_not_found", own_seat_id: null }) } });
    renderAt(`/bookings/${BOOKING}`);
    expect(await screen.findByText(DETAIL_COPY.notFoundTitle)).toBeInTheDocument();
    expect(stub.calls.some((c) => c.path.startsWith("/api/v1/me/invites/"))).toBe(false);
  });
});
