import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { resetUnread } from "@/components/inbox/useUnreadCount";
import type { MemberNotification } from "@/lib/playersApi";
import { INBOX_COPY, inboxUnreadLine } from "@/lib/playersCopy";
import { renderPage, signIn, signOut, stubFetch } from "@/test/harness";
import InboxPage from "@/pages/Inbox";
import { resetHeldMarksForTests } from "../heldMarks";

/**
 * A notice tapped on a phone opens its target, so the inbox UNMOUNTS with the mark still on the
 * wire. Coming back draws `lib/offline`'s copy of the list — read before the tap, and reused
 * outright when it is under `JOIN_MS` old — so a mark kept only in the page's own state came back
 * unread (e2e players-inbox, mobile, under parallel workers: the bell said 2, the list showed 3).
 * The mark outlives the page until a read taken after it settled says what the club holds.
 */

afterEach(() => { vi.unstubAllGlobals(); signOut(); resetUnread(); resetHeldMarksForTests(); localStorage.clear(); });

const NOW = new Date().toISOString();
const INVITE: MemberNotification = {
  id: "n1", kind: "players.invited", headline: "Sam asked you to play — Court 1", link: "/invites/p1",
  booking_id: "b1", created_at: NOW, read_at: null,
};
const SHARE: MemberNotification = {
  id: "n2", kind: "players.share_moved", headline: "Alex paid their share", link: "/bookings/b1",
  booking_id: "b1", created_at: NOW, read_at: null,
};

type Post = { status: number } | Promise<{ status: number }>;

/** A small club: the list re-read agrees with the marks that landed. */
function club(post: () => Post) {
  const items = [{ ...INVITE }, { ...SHARE }];
  const unread = () => items.filter((n) => n.read_at === null).length;
  const stub = stubFetch([
    { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
    { path: "/api/v1/wallet", body: { balance_minutes: 100, entries: [], total_entries: 0, offset: 0, limit: 100 } },
    { method: "POST", path: "/api/v1/wallet/stream-ticket", status: 503, body: { error: "stream_unavailable" } },
    { path: "/api/v1/me/notifications/unread-count", respond: () => ({ unread_count: unread() }) },
    { path: "/api/v1/me/notifications", respond: () => ({ items: items.map((n) => ({ ...n })), unread_count: unread(), next_cursor: null }) },
    { method: "POST", path: "/api/v1/me/notifications/n1/read", respond: () => {
      items[0].read_at = new Date().toISOString();
      return { id: "n1", read: true };
    } },
  ]);
  // The mark's reply, held or refused as the case asks; the club's own state moves only on success.
  const stubbed = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET").toUpperCase() !== "POST" || !String(input).includes("/notifications/n1/read")) return stubbed(input, init);
    const { status } = await post();
    if (status === 200) return stubbed(input, init);
    stub.calls.push({ method: "POST", path: String(input), body: undefined, raw: undefined, headers: {} });
    const body = JSON.stringify({ error: "not_found" });
    return { ok: false, status, headers: { get: () => null }, text: async () => body, json: async () => JSON.parse(body) } as unknown as Response;
  }));
  return stub;
}

const list = () => screen.findByRole("list", { name: INBOX_COPY.listLabel }, { timeout: 3000 });
const unreadRows = () => document.querySelectorAll("li[data-unread]").length;
const listReads = (stub: ReturnType<typeof stubFetch>) => stub.calls.filter((c) => c.method === "GET" && /\/me\/notifications(\?|$)/.test(c.path)).length;

async function tapInviteThenLeave() {
  const first = renderPage(<InboxPage />, { initialEntries: ["/inbox"] });
  fireEvent.click(within(await list()).getByRole("link", { name: INVITE.headline }));
  return first;
}

describe("a tapped notice stays read when the member comes back", () => {
  it("back at once — the list drawn from the cache, not re-read — the tapped notice is read", async () => {
    const stub = club(() => ({ status: 200 }));
    const first = await tapInviteThenLeave();
    await waitFor(() => expect(stub.calls.some((c) => c.method === "POST" && c.path.includes("/n1/read"))).toBe(true));
    const reads = listReads(stub);
    first.unmount();

    renderPage(<InboxPage />, { initialEntries: ["/inbox"] });
    await list();
    expect(listReads(stub)).toBe(reads); // the cached first page, reused (JOIN_MS)
    expect(unreadRows()).toBe(1);
    // ...and the count the bell reads agrees with the rows, not with the early list's figure.
    await waitFor(() => expect(document.querySelector("[data-unread-line]")).toHaveTextContent(inboxUnreadLine(1)));
  });

  it("back while the mark is still on the wire, it is read — and stays read once it lands", async () => {
    let land: (v: { status: number }) => void = () => undefined;
    club(() => new Promise((resolve) => { land = resolve; }));
    const first = await tapInviteThenLeave();
    first.unmount();

    renderPage(<InboxPage />, { initialEntries: ["/inbox"] });
    await list();
    expect(unreadRows()).toBe(1);
    land({ status: 200 });
    await waitFor(() => expect(unreadRows()).toBe(1));
  });

  it("a mark the club refused comes back unread", async () => {
    club(() => ({ status: 404 }));
    const first = await tapInviteThenLeave();
    await waitFor(() => expect(unreadRows()).toBe(2));
    first.unmount();

    renderPage(<InboxPage />, { initialEntries: ["/inbox"] });
    await list();
    expect(unreadRows()).toBe(2);
  });
});
