import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import AdminReportsPage from "./AdminReports";
import { renderPage, signIn, signOut, stubFetch } from "../../test/harness";
import { CLUB_REPORT_COPY } from "../../lib/reportsCopy";

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

describe("Club reports — minutes the club gave are never sold (R13 J13-2)", () => {
  afterEach(() => { vi.unstubAllGlobals(); signOut(); });

  function withGiven(given: number | undefined) {
    return routes().map((r) => r.path === "/api/v1/admin/reports/revenue"
      ? { ...r, body: { from: "", to: "", gross_topups_zar: 120, reversals_zar: 0, net_zar: 120, gross_topups_minutes: 60, reversals_minutes: 0, net_minutes: 60, zar_per_minute_sold: 2, ...(given === undefined ? {} : { given_minutes: given }) } }
      : r);
  }

  it("says how many minutes were given, apart from the minutes sold", async () => {
    stubFetch(withGiven(60));
    renderPage(<AdminReportsPage />, { initialEntries: ["/admin/reports"] });
    const sales = within(await screen.findByRole("region", { name: CLUB_REPORT_COPY.sales.title }));
    expect(sales.getByText(CLUB_REPORT_COPY.sales.givenNote("1 h"))).toBeInTheDocument();
  });

  it("says nothing about gifts when none were given, or the server is older", async () => {
    for (const given of [0, undefined]) {
      stubFetch(withGiven(given));
      const { unmount } = renderPage(<AdminReportsPage />, { initialEntries: ["/admin/reports"] });
      await screen.findByRole("region", { name: CLUB_REPORT_COPY.sales.title });
      expect(screen.queryByText(/given/i)).not.toBeInTheDocument();
      unmount(); vi.unstubAllGlobals();
    }
  });
});

describe("Club reports — Sold is paid minutes only, Given apart (R14 J14-2)", () => {
  afterEach(() => { vi.unstubAllGlobals(); signOut(); });

  const day = (date: string, topUps: number, given?: number) => ({
    date, top_ups_minutes: topUps, booking_charges_minutes: 0, refunds_minutes: 0, penalties_minutes: 0, adjustments_minutes: 0,
    reversals_minutes: 0, share_transfers_minutes: 0, net_movement_minutes: topUps, bookings: 0, no_shows: 0,
    ...(given === undefined ? {} : { given_minutes: given }),
  });

  function withDays(days: ReturnType<typeof day>[]) {
    return routes().map((r) => r.path === "/api/v1/admin/reports/daily" ? { ...r, body: days } : r);
  }

  const totals = async () => within(await screen.findByRole("region", { name: CLUB_REPORT_COPY.totals.title }));
  /** The figure under a totals label, as its words. */
  const figure = (card: ReturnType<typeof within>, label: string) => card.getByText(label, { selector: "dt" }).closest("dt")!.nextElementSibling;

  it("the totals card's Sold leaves out what the club gave, and Given says it", async () => {
    // 3 h of top-ups, 1 h 15 min of it given: 1 h 45 min sold.
    stubFetch(withDays([day("2026-09-01", 120, 45), day("2026-09-02", 60, 30)]));
    renderPage(<AdminReportsPage />, { initialEntries: ["/admin/reports"] });
    const card = await totals();
    expect(figure(card, CLUB_REPORT_COPY.totals.sold)).toHaveTextContent("1 hour 45 minutes");
    expect(figure(card, CLUB_REPORT_COPY.totals.given)).toHaveTextContent("1 hour 15 minutes");
    expect(card.getByText(CLUB_REPORT_COPY.totals.netTail(true), { exact: false })).toBeInTheDocument();

    const daily = within(await screen.findByRole("region", { name: CLUB_REPORT_COPY.daily.title }));
    expect(daily.getByRole("columnheader", { name: CLUB_REPORT_COPY.daily.given })).toBeInTheDocument();
    const row = daily.getByText("1 Sep", { exact: false }).closest("tr")!;
    expect(row).toHaveTextContent("1 hour 15 minutes"); // sold that day: 2 h − 45 min
    expect(row).toHaveTextContent("45 minutes");
  });

  it("with nothing given, Sold is every top-up and there is no Given at all", async () => {
    for (const given of [0, undefined]) {
      stubFetch(withDays([day("2026-09-01", 120, given), day("2026-09-02", 60, given)]));
      const { unmount } = renderPage(<AdminReportsPage />, { initialEntries: ["/admin/reports"] });
      const card = await totals();
      expect(figure(card, CLUB_REPORT_COPY.totals.sold)).toHaveTextContent("3 hours");
      expect(card.queryByText(CLUB_REPORT_COPY.totals.given, { selector: "dt" })).toBeNull();
      expect(card.getByText(CLUB_REPORT_COPY.totals.netTail(false), { exact: false })).toBeInTheDocument();
      expect(screen.queryByRole("columnheader", { name: CLUB_REPORT_COPY.daily.given })).toBeNull();
      unmount(); vi.unstubAllGlobals();
    }
  });
});
