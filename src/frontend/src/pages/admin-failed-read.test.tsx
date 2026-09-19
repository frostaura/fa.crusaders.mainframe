import { describe, expect, it, vi, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import AdminMembersPage from "./AdminMembers";
import AdminWebhooksPage from "./AdminWebhooks";
import { memberFixture, renderPage, stubFetch, type StubRoute } from "../test/harness";

/**
 * A read that failed must not be shown as a club that is empty.
 *
 * <p>
 * Both of these screens rendered their "nothing here yet" state when their list request
 * errored, because an empty array is both the initial value and a legitimate answer and
 * nothing distinguished them. The result is a screen that is not merely unhelpful but
 * actively false, and that invites the admin to act on it:
 * </p>
 *
 * <ul>
 * <li><b>Members.</b> "0 total · 0 pending" above "No members yet." A club of two hundred with
 * applications waiting, rendered as a club with neither. The only signal was a toast, and a
 * toast fades — after three seconds there was nothing on the screen that was true.</li>
 * <li><b>Webhooks.</b> Worse: the loader was <code>load().catch(() =&gt; {})</code>, so there
 * was not even a toast. The screen said "No webhook endpoints yet. Create one above to start
 * firing events." An admin who follows that instruction adds a second endpoint beside the one
 * they could not see, and every booking from then on fires the club's lights cue twice.</li>
 * </ul>
 */
describe("a list that could not be read", () => {
  afterEach(() => vi.unstubAllGlobals());

  const MEMBER_ROUTES = (status: number): StubRoute[] => [
    { path: "/api/v1/admin/members", status, body: status === 200 ? [memberFixture()] : { error: "upstream_unavailable" } },
    { path: "/api/v1/admin/biometrics/enrollments", body: [] },
  ];

  it("does not tell an admin the club has no members", async () => {
    stubFetch(MEMBER_ROUTES(503));
    renderPage(<AdminMembersPage />);

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());

    expect(screen.queryByText("No members yet.")).not.toBeInTheDocument();
    expect(screen.getByText(/could not be read/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("does not report zero pending applications when it does not know", async () => {
    // The most costly of the numbers: an admin reading "0 pending" stops looking for
    // applications to approve, and an applicant waits indefinitely.
    stubFetch(MEMBER_ROUTES(503));
    renderPage(<AdminMembersPage />);

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.queryByText(/pending$/)).not.toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("still shows the real counts and the real empty state when the read succeeds", async () => {
    // The guard against fixing the above by never showing an empty state again.
    stubFetch([
      { path: "/api/v1/admin/members", body: [] },
      { path: "/api/v1/admin/biometrics/enrollments", body: [] },
    ]);
    renderPage(<AdminMembersPage />);

    await waitFor(() => expect(screen.getByText("No members yet.")).toBeInTheDocument());
    expect(screen.getByText("total")).toBeInTheDocument();
    expect(screen.queryByText(/could not be read/i)).not.toBeInTheDocument();
  });

  it("does not invite an admin to create a webhook endpoint it could not list", async () => {
    stubFetch([{ path: "/api/v1/admin/webhooks", status: 503, body: { error: "upstream_unavailable" } }]);
    renderPage(<AdminWebhooksPage />);

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());

    expect(screen.queryByText(/No webhook endpoints yet/i)).not.toBeInTheDocument();
    // The consequence, named on the screen, because "couldn't load" does not tell an admin
    // why they should not just go ahead and create one.
    expect(screen.getByText(/firing every event twice/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("still shows the webhook empty state when the club genuinely has none", async () => {
    stubFetch([{ path: "/api/v1/admin/webhooks", body: [] }]);
    renderPage(<AdminWebhooksPage />);

    await waitFor(() => expect(screen.getByText(/No webhook endpoints yet/i)).toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
