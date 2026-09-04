import { describe, expect, it, vi, afterEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import AdminMembersPage from "./AdminMembers";
import { ledgerRowFixture, memberFixture, renderPage, stubFetch } from "../test/harness";

/**
 * The members screen — the credit-adjustment form specifically.
 *
 * <p>
 * An admin adjustment can name the booking it compensates for (`relatedBookingId` on
 * `AdjustRequest`). That is not decoration: when the court box later uploads proof the
 * member did attend, the no-show reversal looks for a positive AdminAdjustment naming
 * the booking and, finding one, audits it as manual compensation instead of refunding
 * a second time. An adjustment that should have named the booking and did not is a
 * double refund waiting for an upload. So these tests hold the wire shape both ways:
 * the id goes when picked, and no key goes when it is not.
 * </p>
 */
describe("AdminMembers — adjust credit", () => {
  afterEach(() => vi.unstubAllGlobals());

  const USER = "44444444-4444-4444-4444-444444444444";
  const BOOKING = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

  const routes = () => [
    { path: "/api/v1/admin/members/", body: [memberFixture()] },
    { path: "/api/v1/admin/biometric/enrollments", body: [] },
    {
      path: "/api/v1/admin/ledger/",
      // Three rows, two bookings' worth: the penalty and the charge are the same booking,
      // and a top-up is not a booking at all. One option, then.
      body: [
        ledgerRowFixture({ id: "1", type: "NoShowPenalty", amountCredits: 7.2, signedAmountCredits: -7.2, relatedBookingId: BOOKING, at: "2026-09-02T18:00:00Z" }),
        ledgerRowFixture({ id: "2", type: "BookingCharge", amountCredits: 24, signedAmountCredits: -24, relatedBookingId: BOOKING, at: "2026-09-01T10:00:00Z" }),
        ledgerRowFixture({ id: "3", type: "TopUp", amountCredits: 160, signedAmountCredits: 160, relatedBookingId: null }),
      ],
    },
    { method: "POST", path: `/api/v1/admin/credit/${USER}/adjust`, body: { entry_id: "9", amount_credits: 24, balance_after_credits: 144 } },
  ];

  async function openAdjustAndFill(amount: string, reason: string) {
    fireEvent.click(await screen.findByRole("button", { name: "Adjust credit" }));
    fireEvent.change(await screen.findByLabelText(/Amount \(credits/), { target: { value: amount } });
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: reason } });
  }

  it("offers the member's recent bookings from the ledger and sends the picked one as relatedBookingId", async () => {
    const stub = stubFetch(routes());
    renderPage(<AdminMembersPage />);

    await openAdjustAndFill("24", "Box was offline; no-show was wrong");

    // No admin endpoint lists a member's bookings; the ledger filtered to them is the
    // list of bookings money has moved on, which is what an adjustment could be for.
    const option = await screen.findByRole("option", { name: /No-show penalty 7\.20 cr · aaaaaaaa/ });
    expect(option).toHaveValue(BOOKING);
    // One option per booking — the charge row for the same booking does not repeat it.
    expect(screen.queryByRole("option", { name: /Booking charge/ })).not.toBeInTheDocument();
    const ledgerCall = stub.calls.find((c) => c.path.startsWith("/api/v1/admin/ledger/"));
    expect(ledgerCall?.path).toContain(`userId=${USER}`);

    fireEvent.change(screen.getByLabelText("For booking (optional)"), { target: { value: BOOKING } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => {
      const post = stub.calls.find((c) => c.method === "POST");
      expect(post?.path).toBe(`/api/v1/admin/credit/${USER}/adjust`);
      expect(post?.body).toEqual({ amountCredits: 24, reason: "Box was offline; no-show was wrong", relatedBookingId: BOOKING });
    });
    // The row's balance follows the API's answer, and the toast names the booking.
    expect(await screen.findByText(/Credited Ada Lovelace 24\.00 cr for booking aaaaaaaa/)).toBeInTheDocument();
    expect(screen.getByText("144.00 cr")).toBeInTheDocument();
  });

  it("sends no relatedBookingId key at all when the adjustment is not for a booking", async () => {
    const stub = stubFetch(routes());
    renderPage(<AdminMembersPage />);

    await openAdjustAndFill("-10", "Bar tab");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => {
      const post = stub.calls.find((c) => c.method === "POST");
      expect(post?.body).toEqual({ amountCredits: -10, reason: "Bar tab" });
      // Absent, not null: plain money, invisible to the no-show reversal by design.
      expect(post?.raw).not.toContain("relatedBookingId");
    });
  });

  it("takes a booking ID the ledger has not seen, and refuses one that is not a GUID", async () => {
    const stub = stubFetch(routes());
    renderPage(<AdminMembersPage />);

    await openAdjustAndFill("24", "Compensation");
    await screen.findByRole("option", { name: /No-show penalty/ });
    fireEvent.change(screen.getByLabelText("For booking (optional)"), { target: { value: "other" } });

    // The API binds it as a Guid? and answers a bare 400 otherwise; the check is here,
    // where the admin can fix it.
    fireEvent.change(screen.getByLabelText("Booking ID"), { target: { value: "last tuesday" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByText(/That booking ID is not one/)).toBeInTheDocument();
    expect(stub.calls.some((c) => c.method === "POST")).toBe(false);

    const other = "12345678-1234-4123-8123-123456789abc";
    fireEvent.change(screen.getByLabelText("Booking ID"), { target: { value: other } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => {
      expect(stub.calls.find((c) => c.method === "POST")?.body).toEqual({ amountCredits: 24, reason: "Compensation", relatedBookingId: other });
    });
  });
});
