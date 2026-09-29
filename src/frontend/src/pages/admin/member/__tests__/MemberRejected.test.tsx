import { beforeEach, describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { signOut } from "@/test/harness";
import { MEMBER_COPY, OVERVIEW_COPY } from "@/lib/memberDetailCopy";
import { baseRoutes, detailFixture, renderMember, serve } from "./memberKit";

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

  it("still offers Top up to an active member", async () => {
    serve(baseRoutes(detailFixture()));
    renderMember();
    expect(await screen.findByRole("button", { name: MEMBER_COPY.topUp })).toBeInTheDocument();
  });
});
