import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { resetUnread } from "@/components/inbox/useUnreadCount";
import type { MemberNotification } from "@/lib/playersApi";
import { INBOX_COPY, INVITES_COPY } from "@/lib/playersCopy";
import { refuse, renderPage, signIn, signOut, stubFetch, type StubRoute } from "@/test/harness";
import InboxPage from "./Inbox";

/**
 * Go-live member pass, the inbox pane beside the list:
 * - FM-3: a failed read of the invites is said as a failure (or offline) with a retry, and the
 *   notice's own link stays — never a skeleton for ever.
 * - BM-09: when the live wallet moves under an open invite, the invite (and its balance figures)
 *   is read again.
 */
vi.setConfig({ testTimeout: 20_000 });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); signOut(); resetUnread(); localStorage.clear(); });

const BOOKING = "b0000000-0000-0000-0000-000000000001";
const SEAT = "p0000000-0000-0000-0000-000000000003";
const NOW = new Date().toISOString();
const at = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

const NOTICE: MemberNotification = {
  id: "n1", kind: "players.invited", headline: "Sam asked you to play — Court 1", link: `/invites/${SEAT}`,
  booking_id: BOOKING, created_at: NOW, read_at: null,
};

function invite(balance: number) {
  return {
    participant_id: SEAT, booking_id: BOOKING, status: "invited", seat: 3, team: "B", open_link: false,
    court_name: "Court 1", starts_at: at(24), ends_at: at(24.75),
    organiser: { user_id: "55555555-5555-5555-5555-555555555555", name: "Sam Petersen", photo_url: null },
    players: 4, share_minutes: 20, to_pay_minutes: 20, needs_consent: false,
    balance_minutes: balance, spendable_minutes: balance, held_minutes: 0, balance_after_minutes: balance - 20, short_by_minutes: 0,
    share_deadline: at(26.75), cap: null,
  };
}

function splitBox() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const width = this.hasAttribute("data-split-view") ? 1200 : 0;
    return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: 0, width, height: 0, toJSON: () => ({}) } as DOMRect;
  });
}

function open(invites: StubRoute, wallet: () => number = () => 90) {
  const stub = stubFetch([
    { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
    { path: "/api/v1/wallet", respond: () => ({ balance_minutes: wallet(), held_minutes: 0, spendable_minutes: wallet(), entries: [], total_entries: 0, offset: 0, limit: 10 }) },
    { method: "POST", path: "/api/v1/wallet/stream-ticket", status: 503, body: { error: "stream_unavailable" } },
    { path: "/api/v1/me/notifications/unread-count", body: { unread_count: 1 } },
    { method: "POST", path: "/api/v1/me/notifications/n1/read", body: { id: "n1", read: true } },
    { path: "/api/v1/me/notifications", body: { items: [NOTICE], unread_count: 1, next_cursor: null } },
    invites,
  ]);
  renderPage(<InboxPage />, { initialEntries: ["/inbox"] });
  return stub;
}

async function pick() {
  const list = await screen.findByRole("list", { name: INBOX_COPY.listLabel }, { timeout: 3000 });
  fireEvent.click(within(list).getByRole("link", { name: NOTICE.headline }));
}

describe("the inbox invite pane when the invites cannot be read (FM-3)", () => {
  it.each([500, 503])("a %i says it failed, offers a retry, and keeps the notice's link", async (status) => {
    splitBox();
    open({ path: "/api/v1/me/invites", status, body: { error: "unavailable" } });
    await pick();
    const failed = await waitFor(() => {
      const el = document.querySelector("[data-invite-read-failed]");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    }, { timeout: 4000 });
    expect(within(failed).getByRole("button", { name: /try again/i })).toBeInTheDocument();
    expect(within(failed).getByRole("link", { name: INBOX_COPY.openTarget })).toBeInTheDocument();
  });

  it("the retry reads again and, answered, draws the invite", async () => {
    splitBox();
    let fail = true;
    const stub = open({ path: "/api/v1/me/invites", respond: () => (fail ? refuse(500, { error: "unavailable" }) : { items: [invite(90)], count: 1 }) });
    await pick();
    const retry = await screen.findByRole("button", { name: /try again/i }, { timeout: 4000 });
    fail = false;
    fireEvent.click(retry);
    expect(await screen.findByRole("region", { name: new RegExp(INVITES_COPY.sheetTitle) }, { timeout: 4000 })).toBeInTheDocument();
    expect(stub.calls.filter((c) => c.path === "/api/v1/me/invites").length).toBeGreaterThan(1);
  });
});

describe("the inbox invite pane follows the live wallet (BM-09)", () => {
  it("re-reads the invite when the wallet moves, so 'Balance now' matches the chip", async () => {
    splitBox();
    let balance = 90;
    const stub = open({ path: "/api/v1/me/invites", respond: () => ({ items: [invite(balance)], count: 1 }) }, () => balance);
    await pick();
    const pane = await screen.findByRole("region", { name: new RegExp(INVITES_COPY.sheetTitle) }, { timeout: 4000 });
    await waitFor(() => expect(pane).toHaveTextContent(/1 hour 30 minutes|1 h 30 min/));
    const before = stub.calls.filter((c) => c.path === "/api/v1/me/invites").length;
    balance = 10;
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(stub.calls.filter((c) => c.path === "/api/v1/me/invites").length).toBeGreaterThan(before), { timeout: 4000 });
    await waitFor(() => expect(pane).not.toHaveTextContent(/1 hour 30 minutes|1 h 30 min/), { timeout: 4000 });
  });

  it("an unchanged wallet re-read does not read the invite again", async () => {
    splitBox();
    const stub = open({ path: "/api/v1/me/invites", body: { items: [invite(90)], count: 1 } });
    await pick();
    await screen.findByRole("region", { name: new RegExp(INVITES_COPY.sheetTitle) }, { timeout: 4000 });
    await new Promise((r) => setTimeout(r, 100));
    const before = stub.calls.filter((c) => c.path === "/api/v1/me/invites").length;
    const wallets = stub.calls.filter((c) => c.path.split("?")[0] === "/api/v1/wallet").length;
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(stub.calls.filter((c) => c.path.split("?")[0] === "/api/v1/wallet").length).toBeGreaterThan(wallets));
    await new Promise((r) => setTimeout(r, 100));
    expect(stub.calls.filter((c) => c.path === "/api/v1/me/invites").length).toBe(before);
  });
});
