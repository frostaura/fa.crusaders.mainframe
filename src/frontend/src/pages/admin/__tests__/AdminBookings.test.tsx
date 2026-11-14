import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import AdminBookingsPage from "../AdminBookings";
import { renderPage, stubFetch } from "@/test/harness";
import { CANCEL_SHEET } from "@/lib/bookingsCopy";
import { UNSETTLED_COPY as COPY } from "@/lib/unsettledCopy";
import type { UnsettledBooking } from "@/lib/adminApi";

/**
 * BM-11, pass 2: the booking.unsettled notice links to /admin/bookings, which had no page. Its
 * "Never settled" filter is the server's own list, decided row by row with the desk's cancel.
 */
afterEach(() => vi.unstubAllGlobals());

const LIST = "/api/v1/admin/bookings/unsettled";

function row(overrides: Partial<UnsettledBooking> = {}): UnsettledBooking {
  return {
    booking_id: "bk-1", court_id: "c1", court_name: "Court 2", starts_at: "2026-10-05T16:00:00Z", ends_at: "2026-10-05T16:45:00Z",
    charged_minutes: 45, member: { user_id: "u-1", name: "Thandi Mokoena", photo_url: null }, payer: null, ...overrides,
  };
}

const page = (items: UnsettledBooking[], extra: Record<string, unknown> = {}) =>
  ({ total: items.length, lookback_days: 7, timezone: "Africa/Johannesburg", items, next_cursor: null, ...extra });

describe("/admin/bookings — never settled", () => {
  it("lists each booking with its member, court, time and charge, and says what deciding means", async () => {
    stubFetch([{ path: LIST, body: page([row(), row({ booking_id: "bk-2", court_name: null, charged_minutes: 30,
      member: { user_id: "u-2", name: "Sipho Dube", photo_url: null }, payer: { user_id: "u-3", name: "Lerato Khumalo", photo_url: null } })]) }]);
    renderPage(<AdminBookingsPage />);
    const list = await screen.findByRole("list");
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Thandi Mokoena");
    expect(items[0]).toHaveTextContent("Court 2 · Mon 5 Oct, 18:00");
    expect(items[0]).toHaveTextContent(COPY.charged(45));
    expect(items[1]).toHaveTextContent(COPY.unknownCourt);
    expect(items[1]).toHaveTextContent(COPY.paidBy("Lerato Khumalo"));
    expect(screen.getByText(COPY.explain(7))).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Never settled/ })).toHaveTextContent("2");
    expect(within(items[0]).getByRole("link", { name: COPY.openMember })).toHaveAttribute("href", "/admin/members/u-1/bookings?when=past");
  });

  it("opens the desk's cancel for a row, and a cancelled row leaves the list", async () => {
    const stub = stubFetch([
      { path: LIST, sequence: [page([row()]), page([])] },
      { path: "/api/v1/bookings/bk-1/cancellation-quote", body: {
        bookingId: "bk-1", amountChargedMinutes: 45, refundMinutes: 31, penaltyMinutes: 14, penaltyPct: 30,
        penaltyWindowMinutes: 120, insidePenaltyWindow: true, checkedIn: false, alreadyStarted: true,
      } },
      { method: "POST", path: "/api/v1/admin/bookings/bk-1/cancel", body: { refunded_minutes: 31, penalty_minutes: 14 } },
    ]);
    renderPage(<AdminBookingsPage />);
    fireEvent.click(await screen.findByRole("button", { name: COPY.cancelFor("Court 2", "Mon 5 Oct, 18:00") }));
    await screen.findByRole("dialog");
    fireEvent.change(await screen.findByLabelText(CANCEL_SHEET.reasonLabel), { target: { value: "Nobody played; outage night" } });
    fireEvent.click(screen.getByRole("button", { name: CANCEL_SHEET.confirm(1) }));
    await waitFor(() => expect(stub.calls.filter((c) => c.method === "POST")).toHaveLength(1));
    expect(await screen.findByText(COPY.emptyTitle)).toBeInTheDocument();
    expect(stub.calls.filter((c) => c.path === LIST).length).toBeGreaterThanOrEqual(2);
  });

  it("says plainly when every past booking is settled, and names a failed read", async () => {
    stubFetch([{ path: LIST, body: page([]) }]);
    renderPage(<AdminBookingsPage />);
    expect(await screen.findByText(COPY.emptyTitle)).toBeInTheDocument();
  });

  it("pages with Show more and keeps the list above when the next page cannot be read", async () => {
    let n = 0;
    stubFetch([{ path: LIST, respond: () => {
      n += 1;
      if (n === 1) return page([row()], { total: 2, next_cursor: "c2" });
      throw new TypeError("Failed to fetch");
    } }]);
    renderPage(<AdminBookingsPage />);
    fireEvent.click(await screen.findByRole("button", { name: COPY.more }));
    expect(await screen.findByText(COPY.moreFailed)).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });
});
