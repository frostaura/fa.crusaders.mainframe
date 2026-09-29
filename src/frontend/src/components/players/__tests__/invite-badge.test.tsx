import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { InvitesBadgeLink } from "../invites/InvitesBadgeLink";
import { renderPage, signIn, signOut, stubFetch, type FetchStub } from "../../../test/harness";
import { invitesWaitingLabel } from "../../../lib/playersCopy";

/**
 * The Bookings page's "N invites waiting": shown at one or more only, named by its count, a link
 * to Invites — and read again when the member comes back to the window.
 */
vi.setConfig({ testTimeout: 20_000 });
afterEach(() => { vi.unstubAllGlobals(); signOut(); });

function row(id: string) {
  return { participant_id: id, booking_id: "b1", status: "invited", open_link: false, share_credits: 25, to_pay_credits: 25 };
}

function openBadge(answer: () => unknown, status?: number): FetchStub {
  const stub = stubFetch([
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
