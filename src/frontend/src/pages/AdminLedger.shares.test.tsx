import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import AdminLedgerPage from "./AdminLedger";
import { LEDGER_TYPE_LABEL } from "../lib/creditAdjustment";
import { ledgerRowFixture, renderPage, signIn, signOut, stubFetch } from "../test/harness";

/**
 * D11 — the club's book learns `ShareTransfer`: it is a type the filter lists by its name, the
 * filter asks the API for it, and its rows render as the pair they are (never grouped here —
 * grouping says "your share", and this is everybody's book).
 */
describe("Admin ledger — shares of a split booking", () => {
  afterEach(() => { vi.unstubAllGlobals(); signOut(); });

  const PAIR = [
    ledgerRowFixture({ id: "out", type: "ShareTransfer", comment: "Share of a split booking", signedAmountCredits: -25, amountCredits: 25, relatedBookingId: "b1" }),
    ledgerRowFixture({ id: "in", type: "ShareTransfer", comment: "Share of a split booking", signedAmountCredits: 25, amountCredits: 25, relatedBookingId: "b1" }),
  ];

  it("lists the type by its name and asks the API for it", async () => {
    const stub = stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: true }) },
      { path: "/api/v1/admin/ledger", body: PAIR },
    ]);
    renderPage(<AdminLedgerPage />, { initialEntries: ["/admin/ledger?from=2026-09-01&to=2026-09-30"] });
    await screen.findAllByText("Share of a split booking");

    fireEvent.pointerDown(screen.getByRole("combobox", { name: "Type" }), { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(screen.getByRole("option", { name: LEDGER_TYPE_LABEL.ShareTransfer }));
    expect(LEDGER_TYPE_LABEL.ShareTransfer).toBe("Share of a split booking");

    await waitFor(() => expect(stub.calls.some((c) => c.path.startsWith("/api/v1/admin/ledger") && c.path.includes("type=ShareTransfer"))).toBe(true));
    // Both legs, ungrouped: the pair nets to zero and the totals say so.
    expect(screen.getAllByText("Share of a split booking").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByRole("button", { name: /Shares for|Your share/ })).toBeNull();
    const net = [...document.querySelectorAll("[data-ledger-total]")].map((n) => n.textContent);
    expect(net).toEqual(["2", "+25.00 cr", "−25.00 cr", "0.00 cr"]);
  // The page renders two date pickers and a Radix select; under a loaded runner that is slow.
  }, 15_000);

  /**
   * Review round 2, F3-6 (C5): the pair read "Sam → Club treasury" and "Club treasury → Alice",
   * and the organiser's row said "Done by: The club's system". The server now names the other
   * member (`counterparty_name`, and in From/To); the partner who paid is who did it.
   */
  it("reads member to member, and names the partner who paid as who did it", async () => {
    const SAM = "5a5a5a5a-0000-0000-0000-000000000001";
    const ALICE = "a11ce000-0000-0000-0000-000000000002";
    const shared = { type: "ShareTransfer", comment: "Share of a split booking", amountCredits: 25, relatedBookingId: "b1", actorUserId: SAM, actorName: "Sam Partner", actor_name: null };
    stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: true }) },
      {
        path: "/api/v1/admin/ledger",
        body: [
          ledgerRowFixture({ ...shared, id: "out", from: "Sam Partner", to: "Alice Organiser", signedAmountCredits: -25, subjectUserId: SAM, subjectName: "Sam Partner", counterparty_name: "Alice Organiser", counterparty_user_id: ALICE }),
          ledgerRowFixture({ ...shared, id: "in", from: "Sam Partner", to: "Alice Organiser", signedAmountCredits: 25, subjectUserId: ALICE, subjectName: "Alice Organiser", counterparty_name: "Sam Partner", counterparty_user_id: SAM }),
        ],
      },
    ]);
    renderPage(<AdminLedgerPage />, { initialEntries: ["/admin/ledger?from=2026-09-01&to=2026-09-30"] });
    await screen.findAllByText("Share of a split booking");

    expect(screen.queryByText("Club treasury")).toBeNull();
    expect(screen.queryByText("The club's system")).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: /^Details — Share of a split booking/ })[1]);
    const sheet = await screen.findByRole("dialog");
    expect(sheet).toHaveTextContent("Sam Partner → Alice Organiser");
    expect(sheet).toHaveTextContent(/Done by\s*Sam Partner/);
  }, 15_000);

  /** F3-5: desk top-ups showed "AdminTopUp" and the Type filter had no entry for them. */
  it("names a desk top-up in words and can filter by it", async () => {
    const stub = stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: true }) },
      { path: "/api/v1/admin/ledger", body: [ledgerRowFixture({ id: "desk", type: "AdminTopUp", comment: "R200 cash", signedAmountCredits: 200, amountCredits: 200 })] },
    ]);
    renderPage(<AdminLedgerPage />, { initialEntries: ["/admin/ledger?from=2026-09-01&to=2026-09-30"] });
    await screen.findAllByText(LEDGER_TYPE_LABEL.AdminTopUp);
    expect(screen.queryByText("AdminTopUp")).toBeNull();

    fireEvent.pointerDown(screen.getByRole("combobox", { name: "Type" }), { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(screen.getByRole("option", { name: LEDGER_TYPE_LABEL.AdminTopUp }));
    await waitFor(() => expect(stub.calls.some((c) => c.path.startsWith("/api/v1/admin/ledger") && c.path.includes("type=AdminTopUp"))).toBe(true));
  }, 15_000);
});
