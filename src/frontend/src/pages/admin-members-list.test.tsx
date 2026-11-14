import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useLocation } from "react-router-dom";
import AdminMembersPage from "./AdminMembers";
import { memberFixture, renderPage, stubFetch, type StubRoute } from "../test/harness";
import { ADMIN_BADGE, COLUMNS, GROUPS_COPY, MEMBERS_PAGE, ROW_ACTIONS } from "../lib/membersCopy";
import { ACTIONS_COPY } from "../lib/memberDetailCopy";
import { SELL_COPY } from "../lib/deskMinutesCopy";

/**
 * The members list as a way INTO a member (P5) — the founder's "a person's night should be
 * navigated from clicking member in grid" — and as the application queue the Admin overview
 * links to with `?status=PendingApproval`.
 */

afterEach(() => vi.unstubAllGlobals());

const POINTER = { button: 0, ctrlKey: false, pointerType: "mouse" } as const;

/** Where the router is, printed, so a test can read a navigation the page caused. */
function Where() {
  const at = useLocation();
  return <output data-testid="where">{`${at.pathname}${at.search}`}</output>;
}

const ADA = memberFixture();
const GRACE = memberFixture({
  membership_id: "m2", user_id: "u2", full_name: "Grace Hopper", email: "grace@example.com",
  membership_number: "CR-0002", status: "PendingApproval",
});
const ALAN = memberFixture({
  membership_id: "m3", user_id: "u3", full_name: "Alan Turing", email: "alan@example.com",
  membership_number: "CR-0003", status: "Suspended", balance_minutes: -30,
});

function render(opts: { members?: unknown[]; extra?: StubRoute[]; at?: string } = {}) {
  const stub = stubFetch([
    { path: "/api/v1/admin/members/", body: opts.members ?? [ADA, GRACE, ALAN] },
    { path: "/api/v1/admin/biometric/enrollments", body: [] },
    ...(opts.extra ?? []),
  ]);
  renderPage(<><AdminMembersPage /><Where /></>, { initialEntries: [opts.at ?? "/admin/members"] });
  return stub;
}

const where = () => screen.getByTestId("where").textContent;

describe("the row is the way into a member", () => {
  it("names the member with a real link, and opens them from anywhere on the row", async () => {
    render();
    const link = await screen.findByRole("link", { name: "Ada Lovelace" });
    expect(link).toHaveAttribute("href", `/admin/members/${ADA.user_id}`);

    // A click on the row's status badge — not a control — opens the member.
    const row = link.closest("tr")!;
    fireEvent.click(within(row).getByText("Active"));
    expect(where()).toBe(`/admin/members/${ADA.user_id}`);
  });

  it("leaves the row's own buttons alone — Sell package opens the sheet, it does not navigate", async () => {
    render();
    fireEvent.click(await screen.findByRole("button", { name: ROW_ACTIONS.sell }));
    expect(await screen.findByRole("dialog", { name: SELL_COPY.title("Ada Lovelace") })).toBeInTheDocument();
    expect(where()).toBe("/admin/members");
  });

  it("offers the member's record, a booking made for them, and their night as LINKS", async () => {
    render();
    fireEvent.pointerDown(await screen.findByRole("button", { name: ROW_ACTIONS.more("Ada Lovelace") }), POINTER);
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: ROW_ACTIONS.view })).toHaveAttribute("href", `/admin/members/${ADA.user_id}`);
    expect(within(menu).getByRole("menuitem", { name: ROW_ACTIONS.book })).toHaveAttribute("href", `/bookings?as=${ADA.user_id}`);
    expect(within(menu).getByRole("menuitem", { name: ROW_ACTIONS.night })).toHaveAttribute("href", `/admin/members/${ADA.user_id}/night`);
  });

  it("D8 — resets a member's code from the row ⋯, with the member page's own dialog", async () => {
    const stub = render({ extra: [{
      method: "POST", path: `/api/v1/admin/members/${ADA.membership_id}/code/reset`,
      body: { rotated: true, generation: 2, passkeys_revoked: true, passkeys_removed: 1 },
    }] });
    fireEvent.pointerDown(await screen.findByRole("button", { name: ROW_ACTIONS.more("Ada Lovelace") }), POINTER);
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: ACTIONS_COPY.resetCode }));
    const dialog = await screen.findByRole("dialog", { name: ACTIONS_COPY.resetCodeTitle("Ada Lovelace") });
    expect(within(dialog).getByText(ACTIONS_COPY.resetCodeBody)).toBeInTheDocument();
    expect(within(dialog).getByRole("switch", { name: ACTIONS_COPY.revokePasskeys })).toHaveAttribute("aria-checked", "true");
    fireEvent.change(within(dialog).getByRole("textbox", { name: ACTIONS_COPY.resetCodeReason }), { target: { value: "Lost phone" } });
    fireEvent.click(within(dialog).getByRole("button", { name: ACTIONS_COPY.resetCodeConfirm }));
    await waitFor(() => expect(stub.calls.find((c) => c.path.endsWith("/code/reset"))?.body).toEqual({ revoke_passkeys: true, reason: "Lost phone" }));
    expect(await screen.findByText(ACTIONS_COPY.codeReset("Ada Lovelace", true, 1))).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: ACTIONS_COPY.resetCodeTitle("Ada Lovelace") })).toBeNull());
  });

  it("keeps the keyboard in the queue after an approval: the next Approve, never <body> (F3.20)", async () => {
    const HEDY = memberFixture({
      membership_id: "m8", user_id: "u8", full_name: "Hedy Lamarr", email: "hedy@example.com",
      membership_number: "CR-0008", status: "PendingApproval",
    });
    stubFetch([
      { path: "/api/v1/admin/members/", body: null, sequence: [[GRACE, HEDY], [HEDY], [HEDY]] },
      { path: "/api/v1/admin/biometric/enrollments", body: [] },
      { method: "POST", path: `/api/v1/admin/members/${GRACE.membership_id}/approve`, body: { approved: true, member_email_queued: true } },
    ]);
    renderPage(<AdminMembersPage />, { initialEntries: ["/admin/members?status=PendingApproval"] });
    const first = (await screen.findAllByRole("button", { name: ROW_ACTIONS.approve }))
      .find((b) => b.closest("[data-approve-row]")?.getAttribute("data-approve-row") === GRACE.user_id)!;
    first.focus();
    fireEvent.click(first);
    fireEvent.click(document.querySelector<HTMLButtonElement>("[data-confirm='go']")!);

    await waitFor(() => expect(document.activeElement?.closest("[data-approve-row]")).toHaveAttribute("data-approve-row", HEDY.user_id));
  });

  it("never approves the next applicant with the second click of a double-click (BA-02)", async () => {
    const GRACE2 = memberFixture({ membership_id: "m9", user_id: "u9", full_name: "Grace Two", status: "PendingApproval" });
    const stub = stubFetch([
      { path: "/api/v1/admin/members/", body: [GRACE2] },
      { path: "/api/v1/admin/biometric/enrollments", body: [] },
      { method: "POST", path: "/api/v1/admin/members/", body: { approved: true, member_email_queued: true } },
    ]);
    renderPage(<AdminMembersPage />, { initialEntries: ["/admin/members?status=PendingApproval"] });
    const approve = (await screen.findAllByRole("button", { name: ROW_ACTIONS.approve }))[0];
    // One press arms it and says who; nothing is sent until the armed control is pressed.
    fireEvent.click(approve, { detail: 1 });
    fireEvent.click(document.querySelector<HTMLButtonElement>("[data-confirm='go']")!, { detail: 2 });
    expect(stub.calls.some((c) => c.method === "POST")).toBe(false);
    expect(screen.getAllByText(/Approve Grace Two\? They are emailed a welcome/).length).toBeGreaterThan(0);
  });

  it("gives an armed Approve the whole row so its sentence never runs under Reject (V-1)", async () => {
    const GRACE3 = memberFixture({ membership_id: "m9", user_id: "u9", full_name: "Grace Three", status: "PendingApproval" });
    stubFetch([
      { path: "/api/v1/admin/members/", body: [GRACE3] },
      { path: "/api/v1/admin/biometric/enrollments", body: [] },
    ]);
    renderPage(<AdminMembersPage />, { initialEntries: ["/admin/members?status=PendingApproval"] });
    const approve = (await screen.findAllByRole("button", { name: ROW_ACTIONS.approve }))[0];
    const row = approve.closest<HTMLElement>("[data-row-actions]")!;
    expect(row.className.split(/\s+/)).toContain("has-[[data-confirm-pair]]:flex-wrap");
    expect(row.className).toContain("[&_[data-confirm-group]:has([data-confirm-pair])]:basis-full");
    fireEvent.click(approve, { detail: 1 });
    expect(row.querySelector("[data-confirm-group] [data-confirm-pair]")).not.toBeNull();
  });

  it("offers a turned-down applicant's approval from the row ⋯ (F3.23)", async () => {
    const REJECTED = memberFixture({
      membership_id: "m9", user_id: "u9", full_name: "Rita Rejected", email: "rita@example.com",
      membership_number: "CR-0009", status: "Rejected",
    });
    const stub = render({ members: [REJECTED], extra: [{ method: "POST", path: "/api/v1/admin/members/m9/approve", body: {} }] });
    fireEvent.pointerDown(await screen.findByRole("button", { name: ROW_ACTIONS.more("Rita Rejected") }), POINTER);
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: ACTIONS_COPY.approve }));
    await waitFor(() => expect(stub.calls.some((c) => c.method === "POST" && c.path.includes("/approve"))).toBe(true));
  });

  it("does not offer to book for an applicant, who cannot hold a court yet", async () => {
    render();
    fireEvent.pointerDown(await screen.findByRole("button", { name: ROW_ACTIONS.more("Grace Hopper") }), POINTER);
    const menu = await screen.findByRole("menu");
    expect(within(menu).queryByRole("menuitem", { name: ROW_ACTIONS.book })).not.toBeInTheDocument();
  });
});

describe("the status filter and the search", () => {
  it("honours ?status=PendingApproval — the link the Admin overview sends admins down", async () => {
    render({ at: "/admin/members?status=PendingApproval" });
    expect(await screen.findByText("Grace Hopper")).toBeInTheDocument();
    expect(screen.queryByText("Ada Lovelace")).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^Pending/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("1 shown · 3 in total")).toBeInTheDocument();
  });

  it("writes the filter to the URL, so coming back from a member lands where the admin left", async () => {
    render();
    await screen.findByText("Ada Lovelace");
    fireEvent.click(screen.getByRole("radio", { name: /^Suspended/ }));
    expect(where()).toBe("/admin/members?status=Suspended");
    expect(screen.queryByText("Ada Lovelace")).not.toBeInTheDocument();
    expect(screen.getByText("Alan Turing")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: /^All/ }));
    expect(where()).toBe("/admin/members");
  });

  it("counts every status on its chip, and the queue as a sentence", async () => {
    render();
    await screen.findByText("Ada Lovelace");
    expect(screen.getByRole("radio", { name: /^All/ })).toHaveTextContent("3");
    expect(screen.getByRole("radio", { name: "Pending, 1 application waiting" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^Suspended/ })).toHaveTextContent("1");
    expect(screen.getByText("3 members in total")).toBeInTheDocument();
  });

  it("searches name, email and membership number, and keeps the search in the URL", async () => {
    render();
    await screen.findByText("Ada Lovelace");
    fireEvent.change(screen.getByRole("searchbox", { name: MEMBERS_PAGE.searchLabel }), { target: { value: "cr-0003" } });
    expect(screen.getByText("Alan Turing")).toBeInTheDocument();
    expect(screen.queryByText("Ada Lovelace")).not.toBeInTheDocument();
    // R15 L15-2: the URL follows once typing pauses (lib/useUrlText), not on every key.
    await waitFor(() => expect(where()).toBe("/admin/members?q=cr-0003"));
  });

  it("says nothing matched — and offers the way back — rather than calling the club empty", async () => {
    render({ at: "/admin/members?q=nobody-here" });
    expect(await screen.findByText(MEMBERS_PAGE.noMatchTitle)).toBeInTheDocument();
    expect(screen.queryByText(MEMBERS_PAGE.emptyTitle)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: MEMBERS_PAGE.clearFilters }));
    expect(await screen.findByText("Ada Lovelace")).toBeInTheDocument();
  });
});

describe("what a row says about the member", () => {
  it("shows a negative balance in the danger ink, whole", async () => {
    render();
    // Whole minutes (P13): the figure wears the danger ink, and its cell's title says it whole.
    const minutes = (await screen.findByText("−30 min")).parentElement!;
    expect(minutes.className).toContain("text-danger-strong");
    expect(minutes.parentElement).toHaveAttribute("title", "−30 min");
    expect(minutes).toHaveTextContent("minus 30 minutes");
  });

  it("marks an admin, and says when the role comes from the server's configuration", async () => {
    render({ members: [memberFixture({ is_admin: true, admin_source: "config" }), { ...GRACE, is_admin: false, admin_source: null }] });
    const row = (await screen.findByRole("link", { name: "Ada Lovelace" })).closest("tr")!;
    const badge = within(row).getByText(ADMIN_BADGE.label);
    // Said to a screen reader in the badge itself — a tooltip alone reaches neither touch nor AT.
    expect(badge.closest("[data-slot='badge']")).toHaveTextContent(ADMIN_BADGE.config);
    const other = screen.getByRole("link", { name: "Grace Hopper" }).closest("tr")!;
    expect(within(other).queryByText(ADMIN_BADGE.label)).not.toBeInTheDocument();
  });

  it("draws each member's groups from the groups' own member lists", async () => {
    render({
      extra: [
        { path: "/api/v1/admin/member-groups", body: { groups: [{ id: "g1", name: "League" }, { id: "g2", name: "Juniors", status: "archived" }] } },
        { path: "/api/v1/admin/member-groups/g1/members", body: { members: [{ user_id: ADA.user_id, name: "Ada Lovelace" }], cursor: null } },
      ],
    });
    const row = (await screen.findByRole("link", { name: "Ada Lovelace" })).closest("tr")!;
    expect(await within(row).findByText("League")).toBeInTheDocument();
    // An archived group rules nothing, so it is not shown as if it did.
    expect(screen.queryByText("Juniors")).not.toBeInTheDocument();
    const grace = screen.getByRole("link", { name: "Grace Hopper" }).closest("tr")!;
    expect(within(grace).getByText(GROUPS_COPY.none)).toBeInTheDocument();
  });

  it("hides the Groups column and says why when group memberships cannot be read", async () => {
    render({ extra: [{ path: "/api/v1/admin/member-groups", status: 503, body: { error: "upstream_unavailable" } }] });
    expect(await screen.findByText(GROUPS_COPY.failed)).toBeInTheDocument();
    // Not drawn blank: a blank Groups cell reads as "in no group", which the screen cannot know.
    expect(screen.queryByRole("columnheader", { name: COLUMNS.groups })).not.toBeInTheDocument();
    expect(screen.queryByText(GROUPS_COPY.none)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: GROUPS_COPY.retry })).toBeInTheDocument();
  });

  it("shows when a member was last seen once the list says so", async () => {
    render({ members: [memberFixture({ last_login_at: null })] });
    expect(await screen.findByRole("columnheader", { name: new RegExp(`^${COLUMNS.lastSeen}`) })).toBeInTheDocument();
    expect(screen.getByTitle("Has never signed in")).toHaveTextContent("Never");
  });
});

describe("the application queue", () => {
  it("approves once on a double-click, and re-reads the club afterwards", async () => {
    const stub = render({
      extra: [{ method: "POST", path: `/api/v1/admin/members/${GRACE.membership_id}/approve`, body: { approved: true, member_email_queued: true } }],
    });
    const approve = await screen.findByRole("button", { name: ROW_ACTIONS.approve });
    fireEvent.click(approve);
    // BA-02: armed — the go is pressed twice, and the club is still asked once.
    const go = document.querySelector<HTMLButtonElement>("[data-confirm='go']")!;
    fireEvent.click(go);
    fireEvent.click(go);
    expect(await screen.findByText("Grace Hopper approved.")).toBeInTheDocument();
    expect(stub.calls.filter((c) => c.path.endsWith("/approve"))).toHaveLength(1);
    await waitFor(() => expect(stub.calls.filter((c) => c.method === "GET" && c.path.startsWith("/api/v1/admin/members/")).length).toBe(2));
  });
});

/** R4 carry-over (perf): the club is read a page at a time, each photo a link. */
describe("the members list, page by page", () => {
  it("reads every page, asks for photos as links, and counts the whole club", async () => {
    const stub = stubFetch([
      {
        path: "/api/v1/admin/members/",
        respond: (req) => (req.path.includes("cursor=p2")
          ? { items: [ALAN], next_cursor: null, total: 3 }
          : { items: [ADA, GRACE], next_cursor: "p2", total: 3 }),
      },
      { path: "/api/v1/admin/biometric/enrollments", body: [] },
    ]);
    renderPage(<AdminMembersPage />, { initialEntries: ["/admin/members"] });

    expect(await screen.findByRole("link", { name: ALAN.full_name })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ada Lovelace" })).toBeInTheDocument();
    const calls = stub.calls.filter((c) => c.path.startsWith("/api/v1/admin/members/"));
    expect(calls[0].path).toContain("photos=url");
    expect(calls[0].path).toContain("cursor=");
    expect(calls.some((c) => c.path.includes("cursor=p2"))).toBe(true);
    await waitFor(() => expect(screen.queryByText(/Reading the rest/)).not.toBeInTheDocument());
  });

  it("says the rest is still being read while it is", () => {
    expect(MEMBERS_PAGE.readingRest(200, 612)).toBe("Reading the rest of the club's members — 200 of 612 so far. Counts cover those.");
  });
});
