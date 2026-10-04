import { beforeEach, describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import { MemberNight } from "./MemberNight";
import { memberFixture, renderPage, signIn, stubFetch } from "../../test/harness";
import { NIGHT_COLLISION } from "../../lib/nightCopy";
import type { TraceEvent, TraceView } from "../../lib/adminApi";

/**
 * R12 E12-4 (contract C3) — a no-show reversed by a late scan, after the released tail was booked
 * and played by somebody else: the Night says the session overlapped that booking from the time
 * the other session started, that both paid for that time, and links to the other booking.
 */

const MEMBER = memberFixture({ user_id: "u1", full_name: "Thandi Mokoena", membership_number: "CR-0184" });

function reversal(detail: Record<string, unknown>): TraceEvent {
  return {
    at: "2026-09-22T16:20:00.000Z",
    strand: "booking", kind: "booking.no_show_reversed",
    headline: "The no-show was reversed — checked in at Court 2",
    actor: { kind: "system", name: null },
    subject: { user_id: "u1", name: "Thandi Mokoena" },
    detail,
  };
}

function view(events: TraceEvent[]): TraceView {
  return {
    member: { user_id: "u1", name: "Thandi Mokoena", membership_number: "CR-0184" },
    club_day: "2026-09-22",
    range: { from: "2026-09-22T00:00:00+02:00", to: "2026-09-23T00:00:00+02:00" },
    timezone: "Africa/Johannesburg",
    retention: { audit_days: 730, door_days: 90, door_horizon: "2026-06-24", door_rows_may_be_incomplete: false },
    events,
    total: events.length,
  };
}

function serve(events: TraceEvent[]) {
  stubFetch([
    { path: "/api/v1/whoami", body: signIn({ isAdmin: true }) },
    { path: "/api/v1/admin/members/u1/trace", body: view(events) },
    { path: "/api/v1/admin/members/", body: [MEMBER] },
  ]);
  renderPage(<MemberNight userId="u1" name="Thandi Mokoena" />, { initialEntries: ["/admin/members/u1/night"] });
}

const card = async () => (await screen.findByText("The no-show was reversed — checked in at Court 2", undefined, { timeout: 3000 }))
  .closest("[data-night-row]") as HTMLElement;

describe("the Night — a reversal that collided", () => {
  beforeEach(() => { signIn({ isAdmin: true }); });

  it("says the session overlapped another booking from its start, that both paid, and links to it", async () => {
    serve([reversal({ collision_booking_ids: ["b-other"], collision_from: "2026-09-22T16:30:00Z" })]);
    const row = await card();
    expect(row).toHaveTextContent(NIGHT_COLLISION.line(1, "18:30"));
    const link = within(row).getByRole("link", { name: NIGHT_COLLISION.openOne });
    expect(link).toHaveAttribute("href", "/bookings/b-other");
  }, 30_000);

  it("names each booking when more than one overlapped, and says no time when the server has none", async () => {
    serve([reversal({ collision_booking_ids: ["b1", "b2"], collision_from: null })]);
    const row = await card();
    expect(row).toHaveTextContent(NIGHT_COLLISION.line(2, null));
    expect(within(row).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(["/bookings/b1", "/bookings/b2"]);
  }, 30_000);

  it("says nothing when nothing overlapped (absent or empty)", async () => {
    serve([reversal({ collision_booking_ids: [] })]);
    const row = await card();
    expect(row.querySelector("[data-night-collision]")).toBeNull();
    expect(within(row).queryByRole("link")).toBeNull();
  }, 30_000);
});
