import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { resetUnread } from "@/components/inbox/useUnreadCount";
import type { MemberNotification } from "@/lib/playersApi";
import { DETAIL_GONE, INBOX_COPY, INVITES_COPY, acceptLabel } from "@/lib/playersCopy";
import { refuse, renderPage, signIn, signOut, stubFetch } from "@/test/harness";
import InboxPage from "./Inbox";

/**
 * R5, the Inbox's pane beside the list (split: the split view's BOX ≥ 56rem — stubbed here, as
 * jsdom has no layout):
 * - M5-4: "Accept and pay" answered in the pane says "You're in — 25.00 cr paid to Sam" and keeps
 *   saying it after the re-read drops the seat from the open invites (it collapsed to the bare
 *   notice and "Open it").
 * - X5-7: the picked row carries an edge (a border, which forced colours keep), not a tint alone.
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

const INVITE = {
  participant_id: SEAT, booking_id: BOOKING, status: "invited", seat: 3, team: "B", open_link: false,
  court_name: "Court 1", starts_at: at(24), ends_at: at(24.75),
  organiser: { user_id: "55555555-5555-5555-5555-555555555555", name: "Sam Petersen", photo_url: null },
  players: 4, share_minutes: 25, to_pay_minutes: 25, needs_consent: false,
  balance_minutes: 120, spendable_minutes: 100, held_minutes: 20, balance_after_minutes: 95, short_by_minutes: 0,
  share_deadline: at(26.75), cap: null,
};

/** The split view's box is 1200px: wide enough to split at 56rem (896px). */
function splitBox() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const width = this.hasAttribute("data-split-view") ? 1200 : 0;
    return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: 0, width, height: 0, toJSON: () => ({}) } as DOMRect;
  });
}

function open() {
  let accepted = false;
  const stub = stubFetch([
    { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
    { path: "/api/v1/wallet", body: { balance_minutes: 120, held_minutes: 20, spendable_minutes: 100, entries: [], total_entries: 0, offset: 0, limit: 10 } },
    { method: "POST", path: "/api/v1/wallet/stream-ticket", status: 503, body: { error: "stream_unavailable" } },
    { path: "/api/v1/me/notifications/unread-count", body: { unread_count: 1 } },
    { method: "POST", path: "/api/v1/me/notifications/n1/read", body: { id: "n1", read: true } },
    { path: "/api/v1/me/notifications", body: { items: [NOTICE], unread_count: 1, next_cursor: null } },
    { path: "/api/v1/me/invites", respond: () => (accepted ? { items: [], count: 0 } : { items: [INVITE], count: 1 }) },
    { method: "POST", path: `/api/v1/bookings/${BOOKING}/players/${SEAT}/accept`, respond: () => {
      accepted = true;
      return { participant_id: SEAT, booking_id: BOOKING, status: "accepted", share_minutes: 25, consented_minutes: 25, paid_minutes: 25, balance_minutes: 95 };
    } },
  ]);
  renderPage(<InboxPage />, { initialEntries: ["/inbox"] });
  return stub;
}

describe("the inbox pane beside the list (R5)", () => {
  it("M5-4: Accept and pay in the pane confirms \"You're in\" and keeps it after the seat leaves the list", async () => {
    splitBox();
    const stub = open();
    const list = await screen.findByRole("list", { name: INBOX_COPY.listLabel }, { timeout: 3000 });
    fireEvent.click(within(list).getByRole("link", { name: NOTICE.headline }));
    const pane = await screen.findByRole("region", { name: new RegExp(INVITES_COPY.sheetTitle) }, { timeout: 3000 });
    fireEvent.click(within(pane).getByRole("button", { name: acceptLabel(25) }));

    expect(await within(pane).findByText(INVITES_COPY.acceptedTitle)).toBeInTheDocument();
    expect(pane).toHaveTextContent("25 minutes paid to Sam");
    // The open invites are read again and no longer hold the seat — the confirmation stays.
    await waitFor(() => expect(stub.calls.filter((c) => c.path === "/api/v1/me/invites").length).toBeGreaterThan(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText(INVITES_COPY.acceptedTitle)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: INBOX_COPY.openTarget })).toBeNull();
  });

  it("X5-7: the picked row has an edge forced colours keep — a border, not only a tint", async () => {
    splitBox();
    open();
    const list = await screen.findByRole("list", { name: INBOX_COPY.listLabel }, { timeout: 3000 });
    const row = within(list).getByRole("link", { name: NOTICE.headline });
    fireEvent.click(row);
    await waitFor(() => expect(row).toHaveAttribute("aria-current", "true"));
    const classes = row.className.split(" ");
    expect(classes).toContain("border-l-4");
    expect(classes).toContain("border-accent-strong");
    // Only the picked row names a border: forced colours frame every link whose class does.
    const others = within(list).queryAllByRole("link").filter((l) => l !== row);
    for (const other of others) expect(other.className).not.toContain("border");
  });
  it("M5-8: a 'taken off' notice opens its game in the pane with the seat its path names — never 'Booking not found'", async () => {
    splitBox();
    const SEAT_GONE = "p0000000-0000-0000-0000-000000000009";
    const removed: MemberNotification = {
      id: "n9", kind: "players.game_changed", headline: "You were taken off Court 4", link: `/bookings/${BOOKING}?seat=${SEAT_GONE}`,
      booking_id: BOOKING, created_at: NOW, read_at: null,
    };
    const stub = stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
      { path: "/api/v1/wallet", body: { balance_minutes: 120, entries: [], total_entries: 0, offset: 0, limit: 10 } },
      { method: "POST", path: "/api/v1/wallet/stream-ticket", status: 503, body: { error: "stream_unavailable" } },
      { path: "/api/v1/me/notifications/unread-count", body: { unread_count: 1 } },
      { method: "POST", path: "/api/v1/me/notifications/n9/read", body: { id: "n9", read: true } },
      { path: "/api/v1/me/notifications", body: { items: [removed], unread_count: 1, next_cursor: null } },
      { path: `/api/v1/me/invites/${SEAT_GONE}`, body: {
        participant_id: SEAT_GONE, booking_id: BOOKING, status: "removed", lapsed: false, settled_outside: false, booking_status: "booked",
        court_name: "Court 4", starts_at: at(24), ends_at: at(24.75), organiser_name: "Olga", share_minutes: 16, timezone: "Africa/Johannesburg",
      } },
      { path: `/api/v1/bookings/${BOOKING}`, respond: () => refuse(404, { error: "not_found" }) },
    ]);
    renderPage(<InboxPage />, { initialEntries: ["/inbox"] });
    const list = await screen.findByRole("list", { name: INBOX_COPY.listLabel }, { timeout: 3000 });
    fireEvent.click(within(list).getByRole("link", { name: removed.headline }));
    expect(await screen.findByText(DETAIL_GONE.removedTitle, {}, { timeout: 3000 })).toBeInTheDocument();
    expect(stub.calls.some((c) => c.path === `/api/v1/me/invites/${SEAT_GONE}`)).toBe(true);
  });
});
