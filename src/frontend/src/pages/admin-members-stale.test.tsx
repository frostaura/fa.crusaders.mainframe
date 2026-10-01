import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import AdminMembersPage from "./AdminMembers";
import { memberFixture, refuse, renderPage, stubFetch } from "../test/harness";
import { MEMBERS_PAGE } from "../lib/membersCopy";
import { OFFLINE_COPY } from "../lib/offline/offlineCopy";

/**
 * R4 (integrator, after lane D): a re-read that fails over a club already read whole keeps the
 * rows on screen under "Couldn't refresh — showing what we had at …". It used to swap the whole
 * list for the failure panel — the admin lost the members they were looking at to a 503.
 */
afterEach(() => vi.unstubAllGlobals());

const ADA = memberFixture();
const GRACE = memberFixture({
  membership_id: "m2", user_id: "u2", full_name: "Grace Hopper", email: "grace@example.com",
  membership_number: "CR-0002", status: "PendingApproval",
});

describe("the members list after a failed refresh", () => {
  it("keeps the members it had, and says the refresh failed and when the list is from", async () => {
    let failing = false;
    stubFetch([
      { path: "/api/v1/admin/members/", respond: () => (failing ? refuse(503, { error: "busy" }) : [ADA, GRACE]) },
      { path: "/api/v1/admin/biometric/enrollments", body: [] },
    ]);
    renderPage(<AdminMembersPage />, { initialEntries: ["/admin/members"] });
    expect(await screen.findByRole("link", { name: "Grace Hopper" })).toBeInTheDocument();

    failing = true;
    fireEvent.click(screen.getByRole("button", { name: MEMBERS_PAGE.refresh }));

    expect(await screen.findByText(OFFLINE_COPY.refreshFailedTitle)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Grace Hopper" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ada Lovelace" })).toBeInTheDocument();
    expect(screen.queryByText(MEMBERS_PAGE.loadCaveat, { exact: false })).not.toBeInTheDocument();
  });

  it("still puts the failure in place of the list when the club was never read", async () => {
    stubFetch([
      { path: "/api/v1/admin/members/", status: 503, body: { error: "busy" } },
      { path: "/api/v1/admin/biometric/enrollments", body: [] },
    ]);
    renderPage(<AdminMembersPage />, { initialEntries: ["/admin/members"] });
    await waitFor(() => expect(screen.getByText(MEMBERS_PAGE.loadCaveat, { exact: false })).toBeInTheDocument());
    expect(screen.queryByText(OFFLINE_COPY.refreshFailedTitle)).not.toBeInTheDocument();
  });
});
