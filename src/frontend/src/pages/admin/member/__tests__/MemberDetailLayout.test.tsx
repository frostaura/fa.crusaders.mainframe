import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { signOut, unreachable } from "@/test/harness";
import { ACTIONS_COPY, MEMBER_COPY, MEMBER_TABS, OVERVIEW_COPY, withPlayersLine } from "@/lib/memberDetailCopy";
import { BASE, MEMBER_ID, baseRoutes, detailFixture, renderMember, serve } from "./memberKit";
import { heldLine, owedBackQuoteLine } from "@/lib/playersCopy";

/**
 * The member page's frame: who the person is, what they hold, and the six tabs — each a route.
 *
 * Retired from `AdminMembers` (R17): the per-person views that used to be modals over the list
 * — spend, biometrics, the night — live here now, so the tests that pinned those modals moved
 * with them rather than being deleted.
 */
describe("member detail — header and tabs", () => {
  beforeEach(() => { signOut(); });

  it("says who the member is and what they hold", async () => {
    serve(baseRoutes(detailFixture({ is_admin: true, admin_source: "granted" })));
    renderMember();

    expect(await screen.findByRole("heading", { level: 1, name: "Thandi Mokoena" })).toBeInTheDocument();
    expect(screen.getByText("thandi@example.com · CR-0184")).toBeInTheDocument();
    const summary = screen.getByRole("region", { name: /Thandi Mokoena — summary/ });
    expect(within(summary).getByText("Active")).toBeInTheDocument();
    expect(within(summary).getByText(MEMBER_COPY.adminBadge)).toBeInTheDocument();
    expect(within(summary).getByRole("list", { name: MEMBER_COPY.groupsLabel })).toHaveTextContent("League");
    expect(within(summary).getByTestId("member-balance")).toHaveTextContent("120.00 cr");
  });

  it("says a config admin's rights come from the server, not from a grant", async () => {
    serve(baseRoutes(detailFixture({ is_admin: true, admin_source: "config" })));
    renderMember();
    expect(await screen.findByText(MEMBER_COPY.adminFromConfig)).toBeInTheDocument();
  });

  it("paints an overdrawn balance in the danger ink and says what it means", async () => {
    serve(baseRoutes(detailFixture({ balance_credits: -16 })));
    renderMember();
    const balance = await screen.findByTestId("member-balance");
    expect(balance).toHaveTextContent("-16.00 cr");
    expect(balance.className).toMatch(/text-danger-strong/);
    expect(screen.getByText(MEMBER_COPY.balanceOverdrawn)).toBeInTheDocument();
  });

  it("D9 — says under the balance what is held for partners and what is owed back", async () => {
    serve(baseRoutes(detailFixture({ balance_credits: 170, held_credits: 20, held_until: null, owed_back_credits: 5 })));
    renderMember();
    expect(await screen.findByTestId("member-balance")).toHaveTextContent("170.00 cr");
    expect(screen.getByText(heldLine(20, null))).toBeInTheDocument();
    expect(screen.getByText(owedBackQuoteLine(5, "Thandi Mokoena"))).toBeInTheDocument();
  });

  it("D9 — names the other players on a next booking", async () => {
    serve(baseRoutes(detailFixture(), [{ path: "/api/v1/bookings/b1", body: {
      booking_id: "b1", organiser: { user_id: MEMBER_ID, name: "Thandi Mokoena", photo_url: null },
      players: [
        { user_id: MEMBER_ID, name: "Thandi Mokoena" },
        { user_id: "sam", name: "Sam Petersen" },
        { user_id: null, name: null },
      ],
    } }]));
    renderMember();
    expect(await screen.findByText(withPlayersLine(["Sam"]))).toBeInTheDocument();
  });

  it("books for the member through a LINK to Bookings with the member chosen (R10: links navigate)", async () => {
    serve(baseRoutes());
    renderMember();
    const link = await screen.findByRole("link", { name: new RegExp(MEMBER_COPY.bookFor) });
    expect(link).toHaveAttribute("href", `/bookings?as=${MEMBER_ID}`);
  });

  it("does not offer to book for a member who cannot book", async () => {
    serve(baseRoutes(detailFixture({ status: "Suspended" })));
    renderMember();
    await screen.findByRole("heading", { level: 1, name: "Thandi Mokoena" });
    expect(screen.queryByRole("link", { name: new RegExp(MEMBER_COPY.bookFor) })).not.toBeInTheDocument();
  });

  it("draws every tab as a link, and marks the one showing with aria-current", async () => {
    serve(baseRoutes(detailFixture(), [
      { path: `${BASE}/bookings`, body: { when: "upcoming", items: [], next_cursor: null } },
    ]));
    renderMember(`/admin/members/${MEMBER_ID}/bookings`);

    const nav = await screen.findByRole("navigation", { name: MEMBER_COPY.tabsLabel });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(MEMBER_TABS.map((t) => t.label));
    expect(within(nav).getByRole("link", { name: "Bookings" })).toHaveAttribute("aria-current", "page");
    // The index tab is `end`, so it is not also "current" under a child route.
    expect(within(nav).getByRole("link", { name: "Overview" })).not.toHaveAttribute("aria-current");
  });

  /** An empty member on a failed read is not an answer — it is a different sentence. */
  it("shows a failed read with a retry, never an empty person", async () => {
    // Unreachable rather than a 5xx: StateBlock drops the retry for a deployment fault.
    serve([...baseRoutes(null).slice(0, 2), unreachable(BASE)]);
    renderMember();
    expect(await screen.findByRole("alert")).toHaveTextContent(/Couldn't read this member/);
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.queryByTestId("member-balance")).not.toBeInTheDocument();
  });

  it("says plainly when the club has no such member", async () => {
    serve([...baseRoutes(null).slice(0, 2), { path: BASE, status: 404, body: { error: "member_not_found" } }]);
    renderMember();
    expect(await screen.findAllByText(MEMBER_COPY.notFoundTitle)).not.toHaveLength(0);
    expect(screen.getByRole("link", { name: MEMBER_COPY.notFoundAction })).toHaveAttribute("href", "/admin/members");
  });

  it("keeps the last good read on screen when a refresh fails, and says so", async () => {
    serve([
      ...baseRoutes().slice(0, 2),
      { path: BASE, status: [200, 503], body: null, sequence: [detailFixture(), { error: "upstream" }] },
    ]);
    renderMember();
    await screen.findByTestId("member-balance");
    fireEvent.click(screen.getByRole("button", { name: MEMBER_COPY.refresh }));
    expect(await screen.findByText(MEMBER_COPY.refreshFailed)).toBeInTheDocument();
    expect(screen.getByTestId("member-balance")).toHaveTextContent("120.00 cr");
  });
});

describe("member detail — overview", () => {
  beforeEach(() => { signOut(); });

  it("lists the next bookings, the 30-day counts and the account facts", async () => {
    serve(baseRoutes(detailFixture({ email_verified: false })));
    renderMember();

    expect(await screen.findByRole("heading", { name: OVERVIEW_COPY.nextTitle })).toBeInTheDocument();
    expect(screen.getByText(/Court 1/)).toBeInTheDocument();
    expect(screen.getByText(OVERVIEW_COPY.played).closest("div")).toHaveTextContent("5");
    expect(screen.getByText(OVERVIEW_COPY.unverified)).toBeInTheDocument();
  });

  it("says nothing is booked — and offers to book — rather than drawing an empty list", async () => {
    serve(baseRoutes(detailFixture({ next_bookings: [] })));
    renderMember();
    expect(await screen.findByText(OVERVIEW_COPY.nextEmpty)).toBeInTheDocument();
  });
});

describe("member detail — the ⋯ menu", () => {
  beforeEach(() => { signOut(); });

  it("suspends only with a reason, through the MEMBERSHIP id, and re-reads the member", async () => {
    const stub = serve([
      ...baseRoutes(detailFixture()),
      { method: "POST", path: "/api/v1/admin/members/22222222-2222-2222-2222-222222222222/suspend", body: { suspended: true, member_notified: true } },
    ]);
    renderMember();
    await screen.findByTestId("member-balance");

    fireEvent.pointerDown(screen.getByRole("button", { name: MEMBER_COPY.moreActions("Thandi Mokoena") }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: ACTIONS_COPY.suspend }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: ACTIONS_COPY.suspendConfirm });
    expect(confirm).toBeDisabled();

    fireEvent.change(within(dialog).getByRole("textbox", { name: ACTIONS_COPY.reason }), { target: { value: "Subs unpaid" } });
    fireEvent.click(confirm);

    await waitFor(() => expect(stub.calls.some((c) => c.method === "POST" && c.path.endsWith("/suspend"))).toBe(true));
    expect(stub.calls.find((c) => c.path.endsWith("/suspend"))?.body).toEqual({ reason: "Subs unpaid" });
    await waitFor(() => expect(stub.calls.filter((c) => c.path === BASE).length).toBeGreaterThanOrEqual(2));
  });

  // The member-code reset, live since P7, is pinned in MemberResetCode.test.tsx.
});
