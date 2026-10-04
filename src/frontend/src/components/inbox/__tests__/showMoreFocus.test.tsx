import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { resetUnread } from "@/components/inbox/useUnreadCount";
import type { MemberNotification } from "@/lib/playersApi";
import { INBOX_COPY } from "@/lib/playersCopy";
import { renderPage, signIn, signOut, stubFetch } from "@/test/harness";
import InboxPage from "@/pages/Inbox";

/**
 * R12 X12-2 — the inbox's last "Show more" takes its button away; focus must land on the first
 * notice that page brought, never fall to `<body>`.
 */

afterEach(() => { vi.unstubAllGlobals(); signOut(); resetUnread(); });

const NOW = new Date().toISOString();

function notice(overrides: Partial<MemberNotification>): MemberNotification {
  return {
    id: "n1", kind: "players.reminder", headline: "A notice", link: null, booking_id: null,
    created_at: NOW, read_at: NOW, ...overrides,
  };
}

const FIRST = [notice({ id: "n1", headline: "First" }), notice({ id: "n2", headline: "Second", link: "/bookings/b1" })];

describe("the inbox's last Show more", () => {
  it.each([
    ["a notice that opens somewhere (its link)", notice({ id: "n9", headline: "An older one", link: "/bookings/b9" }), "A"],
    ["a notice with nowhere to open (the row)", notice({ id: "n9", headline: "An older one" }), "LI"],
  ])("focuses %s", async (_name, older, tag) => {
    const whoami = signIn({ isAdmin: false });
    stubFetch([
      { path: "/api/v1/whoami", body: whoami },
      { path: "/api/v1/wallet", body: { balance_minutes: 100, entries: [], total_entries: 0, offset: 0, limit: 100 } },
      { method: "POST", path: "/api/v1/wallet/stream-ticket", status: 503, body: { error: "stream_unavailable" } },
      { path: "/api/v1/me/notifications/unread-count", body: { unread_count: 0 } },
      {
        path: "/api/v1/me/notifications",
        respond: ({ path }) => path.includes("cursor=")
          ? { items: [older], unread_count: 0, next_cursor: null }
          : { items: FIRST, unread_count: 0, next_cursor: "CUR1" },
      },
    ]);
    renderPage(<Routes><Route path="/inbox" element={<InboxPage />} /></Routes>, { initialEntries: ["/inbox"] });
    const button = await screen.findByRole("button", { name: INBOX_COPY.showMore }, { timeout: 3000 });
    button.focus();
    fireEvent.click(button);
    await screen.findByText("An older one");
    await waitFor(() => expect(screen.queryByRole("button", { name: INBOX_COPY.showMore })).toBeNull());
    const rows = within(screen.getByRole("list", { name: INBOX_COPY.listLabel })).getAllByRole("listitem");
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    expect(document.activeElement?.tagName).toBe(tag);
    expect(rows[2].contains(document.activeElement)).toBe(true);
  }, 15_000);
});
