import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import AdminLedgerPage from "./AdminLedger";
import { ledgerRowFixture, renderPage, signIn, signOut, stubFetch } from "../test/harness";

/**
 * FA-7 / BA-08: Transactions had no export, though the reporting spec requires one and the
 * treasurer reconciles the ledger outside the app. Export CSV reads every movement the filters
 * select, every page, and saves them in the API's CSV conventions.
 */
describe("Transactions › Export CSV", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); signOut(); });

  it("reads every page of the filtered book and saves it, header first", async () => {
    const saved: Blob[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    Object.assign(URL, { createObjectURL: vi.fn((b: Blob) => { saved.push(b); return "blob:x"; }), revokeObjectURL: vi.fn() });
    const first = [ledgerRowFixture({ id: "r1", comment: "Booking charge", signedAmountMinutes: -24, amountMinutes: 24 })];
    const second = [ledgerRowFixture({ id: "r2", comment: "Desk goodwill", type: "AdminAdjustment", signedAmountMinutes: 40, amountMinutes: 40 })];
    const stub = stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: true }) },
      {
        path: "/api/v1/admin/ledger",
        respond: (req) => (req.path.includes("cursor=p2")
          ? { items: second, next_cursor: null }
          : { items: first, next_cursor: "p2", totals: { count: 2, in_minutes: 40, out_minutes: 24, net_minutes: 16 } }),
      },
    ]);
    renderPage(<AdminLedgerPage />);
    await screen.findAllByText("Booking charge");
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(await screen.findByText("2 movements downloaded.")).toBeInTheDocument();
    await waitFor(() => expect(saved).toHaveLength(1));
    const text = await saved[0].text();
    expect(text.replace(/^﻿/, "").split("\r\n")[0]).toBe("When (UTC),Type,Minutes,Member,By,Reason,From,To,Booking,Movement id");
    expect(text).toContain(",-24,");
    expect(text).toContain(",40,");
    // The second page was read for the file — the screen alone held only the first.
    expect(stub.calls.some((c) => c.path.includes("cursor=p2"))).toBe(true);
  });

  it("saves nothing and says so when the book cannot be read", async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    let reads = 0;
    stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: true }) },
      {
        path: "/api/v1/admin/ledger",
        respond: () => (++reads === 1
          ? { items: [ledgerRowFixture({ id: "r1", comment: "Booking charge" })], next_cursor: null, totals: { count: 1, in_minutes: 0, out_minutes: 24, net_minutes: -24 } }
          : { error: "down" }),
        status: [200, 503],
      },
    ]);
    renderPage(<AdminLedgerPage />);
    await screen.findAllByText("Booking charge");
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(await screen.findByText(/Nothing was downloaded\./)).toBeInTheDocument();
    expect(click).not.toHaveBeenCalled();
  });
});
