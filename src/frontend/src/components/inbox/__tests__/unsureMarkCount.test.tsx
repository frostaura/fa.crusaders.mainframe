import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { resetUnread } from "@/components/inbox/useUnreadCount";
import type { MemberNotification } from "@/lib/playersApi";
import { INBOX_COPY, inboxUnreadLine } from "@/lib/playersCopy";
import { refuse, renderPage, signIn, signOut, stubFetch } from "@/test/harness";
import InboxPage from "@/pages/Inbox";

/**
 * R5 I5-4 — a tapped notice whose mark AND read-back both failed stays drawn read (its outcome is
 * unknown, `heldMarks`); the unread count re-read right after must not count it again, or the
 * bell and "1 unread" disagree with the rows.
 */

afterEach(() => { vi.unstubAllGlobals(); signOut(); resetUnread(); localStorage.clear(); });

const NOW = new Date().toISOString();
const notice = (id: string, headline: string): MemberNotification => ({
  id, kind: "players.share_moved", headline, link: "/bookings/b1", booking_id: "b1", created_at: NOW, read_at: null,
});
const A = notice("n1", "Alex paid their share");
const B = notice("n2", "Sam paid their share");

describe("an unsure mark and the unread count", () => {
  it("the count read after a mark whose write and read-back both failed agrees with the rows", async () => {
    let listDown = false;
    const stub = stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
      { path: "/api/v1/wallet", body: { balance_minutes: 100, entries: [], total_entries: 0, offset: 0, limit: 100 } },
      { method: "POST", path: "/api/v1/wallet/stream-ticket", status: 503, body: { error: "stream_unavailable" } },
      // The club never recorded the mark: it still counts both.
      { path: "/api/v1/me/notifications/unread-count", body: { unread_count: 2 } },
      {
        path: "/api/v1/me/notifications",
        respond: () => (listDown ? refuse(503, { error: "unavailable" }) : { items: [{ ...A }, { ...B }], unread_count: 2, next_cursor: null }),
      },
      { method: "POST", path: "/api/v1/me/notifications/n1/read", status: 503, body: { error: "unavailable" } },
    ]);
    renderPage(<InboxPage />, { initialEntries: ["/inbox"] });
    const list = await screen.findByRole("list", { name: INBOX_COPY.listLabel }, { timeout: 3000 });
    await waitFor(() => expect(document.querySelector("[data-unread-line]")).toHaveTextContent(inboxUnreadLine(2)));

    const counts = () => stub.calls.filter((c) => c.path.endsWith("/unread-count")).length;
    const before = counts();
    listDown = true;
    fireEvent.click(within(list).getByRole("link", { name: A.headline }));

    // The read-back failed, then the count was asked again.
    await waitFor(() => expect(counts()).toBeGreaterThan(before));
    await new Promise((r) => setTimeout(r, 50));
    expect(document.querySelectorAll("li[data-unread]").length).toBe(1);
    expect(document.querySelector("[data-unread-line]")).toHaveTextContent(inboxUnreadLine(1));
  });
});
