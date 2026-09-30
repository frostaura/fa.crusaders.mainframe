import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { resetUnread } from "@/components/inbox/useUnreadCount";
import { PLAY_KIND_WORD } from "@/lib/playCopy";
import type { MemberNotification } from "@/lib/playersApi";
import { INBOX_COPY } from "@/lib/playersCopy";
import { renderPage, signIn, signOut, stubFetch } from "@/test/harness";
import InboxPage from "@/pages/Inbox";

/**
 * R2 F2-5 — a "result to confirm" line whose result was withdrawn (or confirmed, disputed,
 * voided) asks nothing any more: it says so, and is never still tagged "Result to confirm".
 */
afterEach(() => { vi.unstubAllGlobals(); signOut(); resetUnread(); });

const NOW = new Date().toISOString();
const ASKED: MemberNotification = {
  id: "n1", kind: "play.result_to_confirm", headline: "Sam recorded a 3–0 win over you. Is it right?",
  link: "/bookings/b1?result=confirm", booking_id: "b1", created_at: NOW, read_at: NOW,
};

function open(items: MemberNotification[]) {
  stubFetch([
    { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
    { path: "/api/v1/wallet", body: { balance_credits: 100, entries: [], total_entries: 0, offset: 0, limit: 100 } },
    { method: "POST", path: "/api/v1/wallet/stream-ticket", status: 503, body: { error: "stream_unavailable" } },
    { path: "/api/v1/me/notifications/unread-count", body: { unread_count: 0 } },
    { path: "/api/v1/me/notifications", body: { items, unread_count: 0, next_cursor: null } },
  ]);
  renderPage(<InboxPage />, { initialEntries: ["/inbox"] });
}

describe("a resolved question in the inbox", () => {
  it("says it needs nothing now — never 'Result to confirm'", async () => {
    open([{ ...ASKED, resolved_at: NOW }]);
    expect(await screen.findByText(INBOX_COPY.resolvedHint)).toBeInTheDocument();
    expect(screen.getByText(INBOX_COPY.resolved)).toBeInTheDocument();
    expect(screen.queryByText(PLAY_KIND_WORD["play.result_to_confirm"])).toBeNull();
  });

  it("an open question still reads 'Result to confirm'", async () => {
    open([{ ...ASKED, read_at: null }]);
    expect(await screen.findByText(PLAY_KIND_WORD["play.result_to_confirm"])).toBeInTheDocument();
    expect(screen.queryByText(INBOX_COPY.resolvedHint)).toBeNull();
  });
});
