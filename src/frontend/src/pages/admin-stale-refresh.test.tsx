import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import AdminCourtsPage from "./admin/AdminCourts";
import { refuse, renderPage, signIn, signOut, stubFetch } from "../test/harness";
import { adminCourt } from "../test/adminResponseFixtures";
import { COURTS_COPY } from "../lib/courtsCopy";
import { OFFLINE_COPY } from "../lib/offline/offlineCopy";

/**
 * R4 (integrator, after lane D): an admin page whose refresh fails keeps what it had on screen,
 * under "Couldn't refresh — showing what we had at …", instead of swapping it for a failure.
 * Members and Transactions have their own suites; this is the pattern on the Courts page.
 */
describe("Courts after a failed refresh", () => {
  afterEach(() => { vi.unstubAllGlobals(); signOut(); });

  it("keeps the courts it had and says when they are from", async () => {
    let failing = false;
    const court = adminCourt();
    stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: true }) },
      { path: "/api/v1/admin/courts/", respond: () => (failing ? refuse(503, { error: "busy" }) : [court]) },
    ]);
    renderPage(<AdminCourtsPage />);
    expect(await screen.findByText(court.name)).toBeInTheDocument();

    failing = true;
    fireEvent.click(screen.getByRole("button", { name: COURTS_COPY.refresh }));

    expect(await screen.findByText(OFFLINE_COPY.refreshFailedTitle)).toBeInTheDocument();
    expect(screen.getByText(court.name)).toBeInTheDocument();
  });
});
