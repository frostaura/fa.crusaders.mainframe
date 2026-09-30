import { beforeEach, describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { signOut } from "@/test/harness";
import { MEMBER_COPY, OVERVIEW_COPY } from "@/lib/memberDetailCopy";
import { baseRoutes, bookingRow, detailFixture, renderMember, serve } from "./memberKit";

/**
 * Review round 1, F3.10: a turned-down applicant's page read "Rejected" in the header beside
 * "Account: active" below, never said why, and offered Top up. One state, said once.
 */
describe("member detail — a turned-down application", () => {
  beforeEach(() => { signOut(); });

  it("says it was turned down and why, with no contradicting account line and no Top up", async () => {
    serve(baseRoutes(detailFixture({ status: "Rejected", account_status: "active", rejection_reason: "Not a club member" })));
    renderMember();
    await screen.findByTestId("member-balance");

    expect(screen.getByText(OVERVIEW_COPY.turnedDownBecause("Not a club member"))).toBeInTheDocument();
    expect(screen.queryByText(OVERVIEW_COPY.accountStatus, { selector: "dt" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: MEMBER_COPY.topUp })).not.toBeInTheDocument();
    expect(screen.getByText(MEMBER_COPY.noTopUp.Rejected)).toBeInTheDocument();
  });

  it("puts no block element inside a paragraph on the overview (F3.23)", async () => {
    serve(baseRoutes(detailFixture({ next_bookings: [bookingRow()] })));
    renderMember();
    await screen.findByTestId("member-balance");
    expect(document.querySelectorAll("p div")).toHaveLength(0);
  });

  it("still offers Top up to an active member", async () => {
    serve(baseRoutes(detailFixture()));
    renderMember();
    expect(await screen.findByRole("button", { name: MEMBER_COPY.topUp })).toBeInTheDocument();
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
