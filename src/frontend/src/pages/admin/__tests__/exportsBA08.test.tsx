import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import AdminReportsPage from "../AdminReports";
import { renderPage, signIn, signOut, stubFetch } from "@/test/harness";
import { CLUB_REPORT_COPY } from "@/lib/reportsCopy";
import { exportStatus, membersExportLabel } from "@/lib/membersCopy";
import { adminEndpoints } from "@/lib/adminApi";

/**
 * BA-08: the members and no-shows files are the server's, fetched WITH the session's token (FA-1),
 * cut to what is on screen — the members list's status, the report's range.
 */
afterEach(() => { vi.unstubAllGlobals(); signOut(); });

describe("the members file", () => {
  it("is cut to a membership status, and to every member for All and for Admins (not a membership status)", () => {
    expect(exportStatus("Suspended")).toBe("Suspended");
    expect(exportStatus("all")).toBeNull();
    expect(exportStatus("admins")).toBeNull();
    expect(adminEndpoints.membersCsvPath(exportStatus("PendingApproval"))).toBe("/api/v1/admin/exports/members.csv?status=PendingApproval");
    expect(adminEndpoints.membersCsvPath(exportStatus("admins"))).toBe("/api/v1/admin/exports/members.csv");
    expect(membersExportLabel("Active")).toBe("Export active members (CSV)");
    expect(membersExportLabel("admins")).toBe("Export all members (CSV)");
  });
});

describe("the no-shows file", () => {
  it("is on Reports, for the report's own range, fetched with the token", async () => {
    signIn({ isAdmin: true });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:x"), revokeObjectURL: vi.fn() }));
    const stub = stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: true }) },
      { path: "/api/v1/admin/reports/revenue", body: { from: "", to: "", gross_topups_zar: 0, reversals_zar: 0, net_zar: 0, gross_topups_minutes: 0, reversals_minutes: 0, net_minutes: 0, zar_per_minute_sold: 0 } },
      { path: "/api/v1/admin/reports/utilisation", body: { from: "", to: "", by_court: [] } },
      { path: "/api/v1/admin/reports/no-shows", body: { from: "", to: "", total: 0, no_show: 0, no_show_pct: 0 } },
      { path: "/api/v1/admin/reports/daily", body: [] },
      { path: "/api/v1/admin/exports/no-shows.csv", body: "date\r\n", headers: { "content-type": "text/csv" } },
    ]);
    renderPage(<AdminReportsPage />, { initialEntries: ["/admin/reports?from=2026-10-01&to=2026-10-31"] });
    fireEvent.click(await screen.findByRole("button", { name: CLUB_REPORT_COPY.noShowsCsv }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    const call = stub.calls.find((c) => c.path.startsWith("/api/v1/admin/exports/no-shows.csv"))!;
    expect(call.path).toBe("/api/v1/admin/exports/no-shows.csv?from=2026-10-01&to=2026-10-31");
    expect(call.headers.authorization).toBe("Bearer test.token.value");
    click.mockRestore();
  });
});
