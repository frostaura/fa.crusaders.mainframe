import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { signOut } from "@/test/harness";
import { ACTIONS_COPY, MEMBER_COPY, OVERVIEW_COPY } from "@/lib/memberDetailCopy";
import { BASE, baseRoutes, bookingRow, detailFixture, renderMember, serve } from "./memberKit";

/**
 * Review round 1, F3.10: a turned-down applicant's page read "Rejected" in the header beside
 * "Account: active" below, never said why, and offered Top up (now Sell package). One state, said once.
 */
describe("member detail — a turned-down application", () => {
  beforeEach(() => { signOut(); });

  it("says it was turned down and why, with no contradicting account line and nothing to sell or adjust", async () => {
    serve(baseRoutes(detailFixture({ status: "Rejected", account_status: "active", rejection_reason: "Not a club member" })));
    renderMember();
    await screen.findByTestId("member-balance");

    expect(screen.getByText(OVERVIEW_COPY.turnedDownBecause("Not a club member"))).toBeInTheDocument();
    expect(screen.queryByText(OVERVIEW_COPY.accountStatus, { selector: "dt" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: MEMBER_COPY.sell })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: MEMBER_COPY.adjust })).not.toBeInTheDocument();
    expect(screen.getByText(MEMBER_COPY.noSell.Rejected)).toBeInTheDocument();
  });

  it("puts no block element inside a paragraph on the overview (F3.23)", async () => {
    serve(baseRoutes(detailFixture({ next_bookings: [bookingRow()] })));
    renderMember();
    await screen.findByTestId("member-balance");
    expect(document.querySelectorAll("p div")).toHaveLength(0);
  });

  it("still offers Sell package and Adjust minutes to an active member", async () => {
    serve(baseRoutes(detailFixture()));
    renderMember();
    expect(await screen.findByRole("button", { name: MEMBER_COPY.sell })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: MEMBER_COPY.adjust })).toBeInTheDocument();
  });
});

/** Review round 2, F3-12: an applicant's page claimed a membership and an active account. */
describe("member detail — an applicant is not a member yet", () => {
  beforeEach(() => { signOut(); });

  it.each(["PendingApproval", "Rejected"] as const)("says when %s applied, never 'Member since'", async (status) => {
    serve(baseRoutes(detailFixture({ status, account_status: "active" })));
    renderMember();
    await screen.findByTestId("member-balance");
    expect(screen.getByText(OVERVIEW_COPY.appliedOn, { selector: "dt" })).toBeInTheDocument();
    expect(screen.queryByText(OVERVIEW_COPY.memberSince, { selector: "dt" })).toBeNull();
    expect(screen.queryByText(OVERVIEW_COPY.accountStatus, { selector: "dt" })).toBeNull();
  });

  it("still says 'Member since' and the account for a member", async () => {
    serve(baseRoutes(detailFixture()));
    renderMember();
    await screen.findByTestId("member-balance");
    expect(screen.getByText(OVERVIEW_COPY.memberSince, { selector: "dt" })).toBeInTheDocument();
    expect(screen.getByText(OVERVIEW_COPY.accountStatus, { selector: "dt" })).toBeInTheDocument();
  });
});

/**
 * Review round 3, A-2: the page offered "Approve application" to a turned-down applicant and
 * the server answered 404; lane B now allows Rejected → Active. The UI path, end to end.
 */
describe("member detail — approving a turned-down application (R3 A-2)", () => {
  beforeEach(() => { signOut(); });

  it("approves through the membership id and shows the member active", async () => {
    const approve = "/api/v1/admin/members/22222222-2222-2222-2222-222222222222/approve";
    const stub = serve([
      ...baseRoutes().filter((r) => r.path !== BASE),
      {
        path: BASE,
        sequence: [detailFixture({ status: "Rejected", rejection_reason: "Not a club member" }), detailFixture({ status: "Active" })],
        body: null,
      },
      { method: "POST", path: approve, body: { approved: true, member_notified: true } },
    ]);
    renderMember();
    await screen.findByText(OVERVIEW_COPY.turnedDownBecause("Not a club member"));

    // R4 form factor: on the header, beside the name — no longer behind the ⋯.
    fireEvent.click(screen.getByRole("button", { name: ACTIONS_COPY.approve }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: ACTIONS_COPY.approveConfirm }));

    await waitFor(() => expect(stub.calls.some((c) => c.method === "POST" && c.path === approve)).toBe(true));
    expect(await screen.findByText(ACTIONS_COPY.approved("Thandi Mokoena"))).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: MEMBER_COPY.sell })).toBeInTheDocument();
  });
});
