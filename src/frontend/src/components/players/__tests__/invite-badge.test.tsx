import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { InvitesBadgeLink } from "../invites/InvitesBadgeLink";
import { renderPage, signIn, signOut, stubFetch, type FetchStub } from "../../../test/harness";
import { invitesWaitingLabel } from "../../../lib/playersCopy";
import { pendingInvite, savePendingInvite } from "../../../lib/playersPending";

/**
 * The Bookings page's "N invites waiting": shown at one or more only, named by its count, a link
 * to Invites — and read again when the member comes back to the window.
 */
vi.setConfig({ testTimeout: 20_000 });
afterEach(() => { vi.unstubAllGlobals(); signOut(); window.localStorage.clear(); });

const ME = "44444444-4444-4444-4444-444444444444";

function row(id: string) {
  return { participant_id: id, booking_id: "b1", status: "invited", open_link: false, share_credits: 25, to_pay_credits: 25 };
}

function openBadge(answer: () => unknown, status?: number, extra: Parameters<typeof stubFetch>[0] = []): FetchStub {
  const stub = stubFetch([
    ...extra,
    { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
    { path: "/api/v1/wallet", body: { balance_credits: 100, entries: [], total_entries: 0, offset: 0, limit: 10 } },
    { method: "POST", path: "/api/v1/wallet/stream-ticket", status: 503, body: { error: "stream_unavailable" } },
    { path: "/api/v1/me/invites", status, respond: answer },
  ]);
  renderPage(<InvitesBadgeLink />, { reactStrictMode: true });
  return stub;
}

describe("the invites badge", () => {
  it("names the count and links to Invites", async () => {
    openBadge(() => ({ items: [row("a"), row("b")], count: 2 }));
    const link = await screen.findByRole("link", { name: invitesWaitingLabel(2) });
    expect(link).toHaveAttribute("href", "/bookings/invites");
    expect(invitesWaitingLabel(1)).toBe("1 invite waiting");
  });

  it("is absent at zero", async () => {
    const stub = openBadge(() => ({ items: [], count: 0 }));
    await waitFor(() => expect(stub.calls.some((c) => c.path === "/api/v1/me/invites")).toBe(true));
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("is absent when the read fails — a badge is a cue, not a claim", async () => {
    const stub = openBadge(() => ({ error: "boom" }), 500);
    await waitFor(() => expect(stub.calls.some((c) => c.path === "/api/v1/me/invites")).toBe(true));
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("reads again when the window regains focus", async () => {
    let items = [row("a")];
    openBadge(() => ({ items, count: items.length }));
    await screen.findByRole("link", { name: invitesWaitingLabel(1) });
    items = [row("a"), row("b"), row("c")];
    act(() => { window.dispatchEvent(new Event("focus")); });
    expect(await screen.findByRole("link", { name: invitesWaitingLabel(3) })).toBeInTheDocument();
  });
});

describe("R1 F2.3 / F2.5 — a link opened and not answered", () => {
  it("counts on the badge, so a member back from topping up (or newly approved) finds it", async () => {
    savePendingInvite("tok", null);
    openBadge(() => ({ items: [], count: 0 }), undefined, [
      { path: "/api/v1/invites/tok", body: { ...row("p-open"), open_link: true, organiser: { name: "Sam Petersen" } } },
    ]);
    expect(await screen.findByRole("link", { name: invitesWaitingLabel(1) })).toBeInTheDocument();
  });

  it("is forgotten when the club says it is gone", async () => {
    savePendingInvite("tok", ME);
    const stub = openBadge(() => ({ items: [], count: 0 }), undefined, [
      { path: "/api/v1/invites/tok", status: 409, body: { error: "invite_closed" } },
    ]);
    await waitFor(() => expect(stub.calls.some((c) => c.path === "/api/v1/invites/tok")).toBe(true));
    await waitFor(() => expect(pendingInvite(ME)).toBeNull());
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("is not counted twice when it is also on the member's own list", async () => {
    savePendingInvite("tok", ME);
    openBadge(() => ({ items: [row("p-same")], count: 1 }), undefined, [
      { path: "/api/v1/invites/tok", body: { ...row("p-same"), organiser: { name: "Sam Petersen" } } },
    ]);
    expect(await screen.findByRole("link", { name: invitesWaitingLabel(1) })).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("link", { name: invitesWaitingLabel(2) })).toBeNull();
  });
});
