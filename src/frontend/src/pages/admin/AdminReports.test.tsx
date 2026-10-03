import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import AdminReportsPage from "./AdminReports";
import { renderPage, signIn, signOut, stubFetch } from "../../test/harness";

/**
 * Review round 7 (lane FC2): every standalone minutes figure on the club's Reports carries its
 * spoken twin (X7-6 — the per-court Booked column was `formatMinutes` alone, heard as "3 h"), and
 * a figure that may wrap in a totals card is drawn as whole groups (X5-4 / L7-7).
 */

function routes() {
  return [
    { path: "/api/v1/whoami", body: signIn({ isAdmin: true }) },
    { path: "/api/v1/admin/reports/revenue", body: { from: "", to: "", gross_topups_zar: 2025, reversals_zar: 0, net_zar: 2025, gross_topups_minutes: 15630, reversals_minutes: 0, net_minutes: 15630, zar_per_minute_sold: 0.13 } },
    {
      path: "/api/v1/admin/reports/utilisation",
      body: { from: "", to: "", by_court: [{ court_id: "c1", court_number: 1, court_name: "Court 1", slices: 1, booked_minutes: 180, bookings: 2, kept_minutes: 90, sold_minutes: 90 }] },
    },
    { path: "/api/v1/admin/reports/no-shows", body: { from: "", to: "", total: 2, no_show: 0, no_show_pct: 0 } },
    { path: "/api/v1/admin/reports/daily", body: [] },
  ];
}

describe("Club reports — figures a screen reader hears in words (R7)", () => {
  afterEach(() => { vi.unstubAllGlobals(); signOut(); });

  it("X7-6: the per-court Booked figure carries its spoken twin", async () => {
    stubFetch(routes());
    renderPage(<AdminReportsPage />, { initialEntries: ["/admin/reports"] });
    const card = within(await screen.findByRole("region", { name: "Utilisation by court" }));
    const cell = card.getByText("3 h").closest("td")!;
    expect(cell).toHaveTextContent("3 hours");
    expect(card.getByText("3 h")).toHaveAttribute("aria-hidden", "true");
  });

  it("X5-4: a totals figure keeps each number with its unit and may wrap only between groups, said in words", async () => {
    stubFetch(routes());
    renderPage(<AdminReportsPage />, { initialEntries: ["/admin/reports"] });
    const shown = await screen.findAllByText("10 d 20 h 30 min");
    // A no-break space inside each group, an ordinary space between groups.
    expect(shown.some((el) => el.textContent === "10\u00A0d 20\u00A0h 30\u00A0min")).toBe(true);
    expect(screen.getAllByText("10 days 20 hours 30 minutes").length).toBeGreaterThan(0);
  });
});
