import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Layout from "../components/shell/AppShell";
import AdminMembersPage from "./AdminMembers";
import { AuthProvider } from "../lib/auth";
import { BalanceProvider } from "../lib/balance";
import { ProfileProvider } from "../lib/profile";
import { ToastProvider } from "../components/Toast";
import { memberFixture, signIn, signOut } from "../test/harness";
import { OUTCOMES } from "../lib/membersCopy";

/**
 * Two numbers counting the same thing, on the same screen, disagreeing.
 *
 * <p>
 * The chrome's <b>Members N</b> badge re-read itself on navigation only, and Approve and
 * Reject are pressed <em>on</em> <code>/admin/members</code> — so the pathname never
 * changed, the badge never re-read, and it went on counting an applicant the admin had
 * just dealt with beside that same screen's own "N pending" line. It held for the full
 * eight seconds the finder waited, and cleared only by navigating away and back.
 * </p>
 *
 * <p>
 * This renders the chrome and the console <b>together</b>, in a router, under
 * <code>StrictMode</code>, and presses the real button — because none of the three
 * separately can see it. StrictMode in particular: this codebase has already shipped two
 * defects that only exist under mount → cleanup → mount, and a badge whose correctness
 * depends on an effect's dependency list is exactly that shape. The fetch mock is
 * hand-rolled and <b>stateful</b> for the same reason — a fixture that answers the nth call
 * from a fixed list cannot survive an effect that legitimately runs twice, and would fail
 * or pass for reasons that have nothing to do with the badge.
 * </p>
 */

const PROFILE = {
  user_id: "u1", email: "admin@club.test", is_admin: true, tenant_slug: "crusaders",
  full_name: "Club Desk", membership_number: "M-1", photo_url: null, status: "active",
};

const WALLET = { balance_minutes: 0, entries: [], total_entries: 0, offset: 0, limit: 100 };

type MemberRow = ReturnType<typeof memberFixture>;

function applicant(n: number): MemberRow {
  return memberFixture({
    membership_id: `mem-${n}`,
    user_id: `usr-${n}`,
    email: `applicant${n}@sample.local`,
    full_name: `Applicant ${n}`,
    membership_number: `CR-000${n}`,
    status: "PendingApproval",
    email_verified: true,
  });
}

/** The club, as the server would answer it — and as an approval changes it. */
/**
 * @param commitButFail answers the approve POST with 500 AFTER applying it — the shape an
 *   SMTP outage produced for real: the row is committed and the caller is told it was not.
 */
function stubClub(members: MemberRow[], commitButFail = false) {
  const state = { members: [...members] };

  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const ok = (body: unknown) => Promise.resolve({
      ok: true, status: 200,
      headers: { get: () => null },
      text: () => Promise.resolve(JSON.stringify(body)),
      json: () => Promise.resolve(body),
    } as unknown as Response);

    const approve = /\/api\/v1\/admin\/members\/([^/]+)\/approve$/.exec(path);
    if (method === "POST" && approve) {
      state.members = state.members.map((m) =>
        m.membership_id === approve[1] ? { ...m, status: "Active" } : m);
      if (commitButFail) {
        return Promise.resolve({
          ok: false, status: 500,
          headers: { get: () => null },
          text: () => Promise.resolve('{"error":"smtp"}'),
          json: () => Promise.resolve({ error: "smtp" }),
        } as unknown as Response);
      }
      return ok({ approved: true, member_notified: true });
    }
    if (path.startsWith("/api/v1/whoami")) return ok({ ...signIn({ isAdmin: true }), user_id: "u1" });
    if (path.startsWith("/api/v1/me/profile")) return ok(PROFILE);
    if (path.startsWith("/api/v1/wallet/stream-ticket")) return ok({ ticket: "t", expires_in_seconds: 60 });
    if (path.startsWith("/api/v1/wallet")) return ok(WALLET);
    if (path.startsWith("/api/v1/admin/biometric/enrollments")) return ok([]);
    const one = /^\/api\/v1\/admin\/members\/([^/?]+)$/.exec(path);
    if (method === "GET" && one) {
      // F3-3: after a lost reply the console reads the member it acted on.
      const m = state.members.find((row) => row.user_id === one[1]);
      return m ? ok(m) : Promise.reject(new Error(`No member ${one[1]}`));
    }
    if (path.startsWith("/api/v1/admin/members/")) {
      // The chrome asks for the pending set; the console asks for everything.
      return ok(path.includes("status=PendingApproval")
        ? state.members.filter((m) => m.status === "PendingApproval")
        : state.members);
    }
    return Promise.reject(new Error(`No stub for ${method} ${path}`));
  }));

  return state;
}

/**
 * The console's own pending count: since P5 it is the Pending filter chip's badge, read as one
 * accessible name — "Pending, 2 applications waiting".
 */
function summaryLine(count: number) {
  return screen.getByRole("radio", { name: `Pending, ${count} ${count === 1 ? "application" : "applications"} waiting` });
}

beforeEach(() => {
  vi.stubGlobal("EventSource", class { close() {} addEventListener() {} } as unknown as typeof EventSource);
});

afterEach(() => { vi.unstubAllGlobals(); signOut(); });

function renderConsole() {
  return render(
    <StrictMode>
      <MemoryRouter initialEntries={["/admin/members"]}>
        <AuthProvider>
          <ProfileProvider>
            <BalanceProvider>
              <ToastProvider>
              <Routes>
                <Route element={<Layout />}>
                  <Route path="/admin/members" element={<AdminMembersPage />} />
                </Route>
              </Routes>
              </ToastProvider>
            </BalanceProvider>
          </ProfileProvider>
        </AuthProvider>
      </MemoryRouter>
    </StrictMode>,
  );
}

describe("the pending-applications badge, after an approval on the same screen", () => {
  it("agrees with the counter beside it once an application is approved", async () => {
    signIn({ isAdmin: true });
    stubClub([applicant(1), applicant(2)]);

    renderConsole();

    // Both navs carry the badge, so the count is asserted through its accessible name.
    await waitFor(() => expect(screen.getAllByLabelText("2 membership applications awaiting review").length).toBeGreaterThan(0));
    expect(summaryLine(2)).toBeInTheDocument();

    const approveButtons = await screen.findAllByRole("button", { name: "Approve" });
    await userEvent.click(approveButtons[0]);

    // The screen's own summary line, and the chrome, now say the same thing.
    await waitFor(() => expect(summaryLine(1)).toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getAllByLabelText("1 membership application awaiting review").length).toBeGreaterThan(0));
    expect(screen.queryByLabelText("2 membership applications awaiting review")).not.toBeInTheDocument();
  });

  /**
   * The same two numbers, on the path that actually broke them.
   *
   * <p>
   * An SMTP outage made <code>POST /approve</code> commit the approval and then answer 500.
   * The console's reload and its badge notification both sat inside the <code>try</code>, so
   * on that path neither ran: the row went on offering Approve, the summary went on saying
   * "2 pending", and the chrome's badge went on counting an applicant who was already a
   * member — the exact symptom this file was written for, restored in full by a failure mode
   * nobody had tried. The repair is that the reload happens in <code>finally</code> and the
   * badge is notified by the loader, so the two numbers move together with the server's
   * answer rather than with the console's optimism.
   * </p>
   */
  it("agrees with the counter beside it even when the approval reports failure", async () => {
    signIn({ isAdmin: true });
    stubClub([applicant(1), applicant(2)], true);

    renderConsole();

    await waitFor(() => expect(screen.getAllByLabelText("2 membership applications awaiting review").length).toBeGreaterThan(0));

    await userEvent.click((await screen.findAllByRole("button", { name: "Approve" }))[0]);

    // The approval committed and the reply was lost: the console asks, and says the truth
    // (review round 2, F3-3) — never "Approval failed." about a member who is Active...
    expect(await screen.findByText(OUTCOMES.approvedAfterLostReply("Applicant 1"))).toBeInTheDocument();
    expect(screen.queryByText(OUTCOMES.approveFailed)).not.toBeInTheDocument();
    // ...and both numbers still tell them what is actually true of the club.
    await waitFor(() => expect(summaryLine(1)).toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getAllByLabelText("1 membership application awaiting review").length).toBeGreaterThan(0));
    expect(screen.queryByLabelText("2 membership applications awaiting review")).not.toBeInTheDocument();
  });

  it("clears the badge entirely when the last application is dealt with", async () => {
    signIn({ isAdmin: true });
    stubClub([applicant(1)]);

    renderConsole();

    await waitFor(() => expect(screen.getAllByLabelText("1 membership application awaiting review").length).toBeGreaterThan(0));

    await userEvent.click((await screen.findAllByRole("button", { name: "Approve" }))[0]);

    // Not "0" — the badge is a cue and renders nothing when there is nothing to cue.
    await waitFor(() => expect(screen.queryByLabelText(/awaiting review/)).not.toBeInTheDocument());
  });
});
