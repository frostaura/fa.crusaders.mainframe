import { afterEach, describe, expect, it as vitestIt, vi } from "vitest";
import { settledIt } from "@/test/settled";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import AdminMembersPage from "./AdminMembers";
import { approveFromRow, memberFixture, renderPage, stubFetch, type StubRoute } from "../test/harness";
import { OUTCOMES } from "../lib/membersCopy";


// FM-7: every test here waits for the screen it drew to settle before it ends.
const it = settledIt(vitestIt);

/**
 * What the console says, and does, when a membership transition succeeds and the email
 * that goes with it does not.
 *
 * <p>
 * The approval commits before the welcome email is attempted. With SMTP refusing
 * connections the API used to throw <code>SmtpException</code> out of
 * <code>MemberApprovalService</code> <em>after</em> <code>SaveChangesAsync</code>, so the
 * caller got HTTP 500 for a member whose row already said Active — and this screen said
 * "Approval failed." about them. Worse, the reload and the badge notification sat inside
 * the same <code>try</code>, so neither the chrome's "Members N" badge nor this screen's own
 * "N pending" summary moved: the console froze on a club state the server had already left.
 * An admin who believes the sentence presses Approve again and gets a 404.
 * </p>
 *
 * <p>
 * Two separate repairs, and this file holds both. The API answers
 * <code>member_email_queued</code> so the console can say the true thing rather than choose
 * between two false ones; and the reload moved into <code>finally</code>, so what is on
 * screen after any transition is what the server says, whatever happened in between.
 * </p>
 */

const MEMBERSHIP = "33333333-3333-3333-3333-333333333333";
const USER = "44444444-4444-4444-4444-444444444444";
const APPLICANT = { status: "PendingApproval", full_name: "Ada Lovelace" };

function routes(extra: StubRoute[], listSequence?: unknown[]): StubRoute[] {
  return [
    listSequence
      ? { path: "/api/v1/admin/members/", body: null, sequence: listSequence }
      : { path: "/api/v1/admin/members/", body: [memberFixture(APPLICANT)] },
    { path: "/api/v1/admin/biometric/enrollments", body: [] },
    ...extra,
  ];
}

const approveRoute = (body: unknown, status?: number): StubRoute => ({
  method: "POST", path: `/api/v1/admin/members/${MEMBERSHIP}/approve`, status, body,
});

afterEach(() => vi.unstubAllGlobals());

describe("AdminMembers — approving when the mail server is down", () => {
  it("says the member is approved AND that nobody was told", async () => {
    stubFetch(routes([approveRoute({ approved: true, member_email_queued: false })]));
    renderPage(<AdminMembersPage />);

    await approveFromRow();

    // Both halves in one sentence, because both are true and an admin acts on the second.
    // "Ada Lovelace approved." on its own is how a club leaves an active member waiting for
    // a welcome link that was never sent.
    const toast = await screen.findByText(/Ada Lovelace is approved, but the welcome email couldn't be queued/i);
    expect(toast).toBeInTheDocument();
    expect(toast).toHaveTextContent(/Their membership is active/i);
    // And emphatically not the sentence that was on screen for an approved member.
    expect(screen.queryByText("Approval failed.")).not.toBeInTheDocument();
  });

  it("says only that the member is approved when the email did go", async () => {
    stubFetch(routes([approveRoute({ approved: true, member_email_queued: true })]));
    renderPage(<AdminMembersPage />);

    await approveFromRow();

    expect(await screen.findByText("Ada Lovelace approved.")).toBeInTheDocument();
    expect(screen.queryByText(/couldn't be queued/i)).not.toBeInTheDocument();
  });

  it("re-reads the club from the server even when the call failed", async () => {
    // The shape that bit an admin for real: the POST answers 500 while the server has
    // ALREADY committed the approval, so the second GET is the only thing on this screen
    // that knows the truth. With the reload inside the `try` it never happened, and the row
    // went on offering Approve for a member who was already Active.
    const stub = stubFetch(routes(
      [approveRoute({ error: "smtp" }, 500), { path: `/api/v1/admin/members/${USER}`, body: memberFixture({ status: "Active" }) }],
      [[memberFixture(APPLICANT)], [memberFixture({ status: "Active" })]],
    ));
    renderPage(<AdminMembersPage />);

    await approveFromRow();

    // Review round 2 (F3-3): the member is read again and the toast says what is TRUE.
    expect(await screen.findByText(OUTCOMES.approvedAfterLostReply("Ada Lovelace"))).toBeInTheDocument();
    expect(screen.queryByText(OUTCOMES.approveFailed)).not.toBeInTheDocument();
    // Two list reads: the one on mount and the one the failure did not cancel.
    await waitFor(() =>
      expect(stub.calls.filter((c) => c.method === "GET" && c.path.startsWith("/api/v1/admin/members/")).length)
        .toBeGreaterThanOrEqual(2));
    // And the screen now shows the server's club, not the console's memory of it.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument());
  });

  it("says it is not known — not that it failed — when the member cannot be read either", async () => {
    stubFetch(routes([
      approveRoute({ error: "gateway_timeout" }, 504),
      { path: `/api/v1/admin/members/${USER}`, status: 503, body: { error: "server_error" } },
    ]));
    renderPage(<AdminMembersPage />);

    await approveFromRow();

    expect(await screen.findByText(OUTCOMES.approveUnknown("Ada Lovelace"))).toBeInTheDocument();
    expect(screen.queryByText(OUTCOMES.approveFailed)).not.toBeInTheDocument();
  });

  it("still says it failed when the club read back shows them waiting", async () => {
    stubFetch(routes([
      approveRoute({ error: "server_error" }, 500),
      { path: `/api/v1/admin/members/${USER}`, body: memberFixture(APPLICANT) },
    ]));
    renderPage(<AdminMembersPage />);

    await approveFromRow();

    expect(await screen.findByText(OUTCOMES.approveFailed)).toBeInTheDocument();
  });

  it("tells the truth about a rejection nobody received", async () => {
    stubFetch(routes([
      { method: "POST", path: `/api/v1/admin/members/${MEMBERSHIP}/reject`, body: { rejected: true, member_email_queued: false } },
    ]));
    renderPage(<AdminMembersPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Reject" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(await screen.findByLabelText(/reason/i), { target: { value: "Membership number not on file." } });
    fireEvent.click(within(dialog).getByRole("button", { name: /^Reject/ }));

    // A rejected applicant who was never emailed is refused at sign-in with no explanation,
    // and the club is the only party that knows why.
    expect(await screen.findByText(/the email couldn't be queued/i)).toBeInTheDocument();
  });
});
