import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderPage, signIn, signOut, stubFetch } from "@/test/harness";
import { CANCEL_SHEET } from "@/lib/bookingsCopy";
import { ADMIN_CANCEL } from "@/lib/adminCancelCopy";
import { BOOKING, DETAIL_PATH, adminView, detail } from "@/components/players/__tests__/detailKit";
import { AdminCancelPanel } from "./AdminCancelPanel";

/**
 * R15 J15-2 — the club cancels a booking from its page, a started session included: the grid's
 * cancel sheet on the admin route, the outcome named before the press, a reason required.
 */
beforeEach(() => { signOut(); });
afterEach(() => { vi.unstubAllGlobals(); });

const STARTED_NOW = () => new Date("2026-09-30T16:20:00Z").getTime(); // 20 minutes into the session
const BEFORE = () => new Date("2026-09-29T08:00:00Z").getTime();

function quote(over: Record<string, unknown> = {}) {
  return {
    bookingId: BOOKING, amountChargedMinutes: 100, refundMinutes: 0, penaltyMinutes: 0, penaltyPct: 50,
    penaltyWindowMinutes: 120, insidePenaltyWindow: true, checkedIn: true, alreadyStarted: false, ...over,
  };
}

function serveAdmin(q: unknown, record?: unknown) {
  signIn({ isAdmin: true });
  return stubFetch([
    { path: `${DETAIL_PATH}/cancellation-quote`, body: q },
    // R19 J19-3 — the sheet reads the record of a checked-in booking for who scanned.
    ...(record ? [{ path: DETAIL_PATH, body: record }] : []),
    { method: "POST", path: `/api/v1/admin/bookings/${BOOKING}/cancel`, body: { refunded_minutes: 0, penalty_minutes: 0 } },
  ]);
}

describe("R15 J15-2 — Cancel booking on the admin's booking page", () => {
  it("cancels a started, checked-in session through the admin route, naming that nothing is refunded", async () => {
    const reload = vi.fn();
    // R19 J19-3 — Sam's own scan lit the court: his seat is stamped at the booking's instant.
    const started = adminView({
      players: adminView().players.map((p) => (p.user_id === adminView().organiser.user_id ? { ...p, checked_in_at: "2026-09-30T15:58:00Z" } : p)),
      attendance: { ...adminView().attendance, checked_in_at: "2026-09-30T15:58:00Z", players_checked_in: 2 },
    });
    const fetches = serveAdmin(quote(), started);
    renderPage(<AdminCancelPanel detail={started} reload={reload} now={STARTED_NOW} />);

    expect(screen.getByText(ADMIN_CANCEL.started("Sam Petersen"))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: ADMIN_CANCEL.open }));
    const sheet = await screen.findByRole("dialog");
    // The outcome, named before the press, from the server's quote.
    expect(await within(sheet).findByText(CANCEL_SHEET.checkedIn("Sam"))).toBeInTheDocument();

    // A reason is required: the press without one sends nothing.
    fireEvent.click(within(sheet).getByRole("button", { name: CANCEL_SHEET.confirm(1) }));
    expect(await within(sheet).findByText(CANCEL_SHEET.reasonMissing)).toBeInTheDocument();
    expect(fetches.calls.filter((c) => c.method === "POST")).toEqual([]);

    fireEvent.change(within(sheet).getByRole("textbox", { name: new RegExp(`^${CANCEL_SHEET.reasonLabel}`) }), { target: { value: "Floodlight fault on court 1" } });
    fireEvent.click(within(sheet).getByRole("button", { name: CANCEL_SHEET.confirm(1) }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
    const posts = fetches.calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => c.path)).toEqual([`/api/v1/admin/bookings/${BOOKING}/cancel`]);
    expect(posts[0].body).toMatchObject({ reason: "Floodlight fault on court 1", waivePenalty: false });
  });

  it("uses the admin route on the admin's OWN started booking too (the member route refuses it)", async () => {
    const reload = vi.fn();
    const fetches = serveAdmin(quote({ checkedIn: false, refundMinutes: 50, penaltyMinutes: 50 }));
    const own = detail({ attendance: { ...detail().attendance, checked_in_at: null }, permissions: { ...detail().permissions, can_cancel: false } });
    renderPage(<AdminCancelPanel detail={own} reload={reload} now={STARTED_NOW} />);
    fireEvent.click(screen.getByRole("button", { name: ADMIN_CANCEL.open }));
    const sheet = await screen.findByRole("dialog");
    await within(sheet).findByText(CANCEL_SHEET.late(50));
    fireEvent.change(within(sheet).getByRole("textbox", { name: new RegExp(`^${CANCEL_SHEET.reasonLabel}`) }), { target: { value: "Booked in error" } });
    fireEvent.click(within(sheet).getByRole("button", { name: CANCEL_SHEET.confirm(1) }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(fetches.calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual([`/api/v1/admin/bookings/${BOOKING}/cancel`]);
  });

  it("says what an upcoming cancel does, and is not offered beside the organiser's own Cancel", () => {
    serveAdmin(quote());
    const { unmount } = renderPage(<AdminCancelPanel detail={adminView()} reload={() => undefined} now={BEFORE} />);
    expect(screen.getByText(ADMIN_CANCEL.upcoming("Sam Petersen"))).toBeInTheDocument();
    unmount();
    // The admin is the organiser of a future booking: the member panel's Cancel is the one.
    renderPage(<AdminCancelPanel detail={detail()} reload={() => undefined} now={BEFORE} />);
    expect(screen.queryByRole("button", { name: ADMIN_CANCEL.open })).toBeNull();
  });

  it.each(["cancelled", "completed", "no_show"] as const)("is not offered on a %s booking", (status) => {
    serveAdmin(quote());
    renderPage(<AdminCancelPanel detail={adminView({ status })} reload={() => undefined} now={STARTED_NOW} />);
    expect(screen.queryByRole("button", { name: ADMIN_CANCEL.open })).toBeNull();
  });
});
