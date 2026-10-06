import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { resetUnread } from "@/components/inbox/useUnreadCount";
import { renderPage, signIn, signOut, stubFetch } from "@/test/harness";
import { NotificationBell } from "./NotificationBell";

/**
 * R19 L19-8 — at 200 % text the "9+" badge was 46px wide and hung 31px over the minutes chip (15px
 * over the avatar where the chip folds away): it grew with the text and hung off the glyph's corner
 * past the bell's own 44px box. Its type, padding and height are now capped in pixels and its right
 * edge is the bell's own edge, whatever the glyph's size — so the count never reaches a neighbour's
 * tap area. Measured in Chromium by `e2e/member-r19-fe19m.spec.ts`; here, the box it is drawn with.
 */

afterEach(() => { vi.unstubAllGlobals(); signOut(); resetUnread(); });

describe("the bell's badge stays inside the bell (R19 L19-8)", () => {
  it("is anchored to the bell's 44px edge, with pixel-capped type, padding and height", async () => {
    const whoami = signIn({ isAdmin: false });
    stubFetch([
      { path: "/api/v1/whoami", body: whoami },
      { path: "/api/v1/wallet", body: { balance_minutes: 100, entries: [], total_entries: 0, offset: 0, limit: 100 } },
      { method: "POST", path: "/api/v1/wallet/stream-ticket", status: 503, body: { error: "stream_unavailable" } },
      { path: "/api/v1/me/notifications/unread-count", body: { unread_count: 12 } },
    ]);
    renderPage(<NotificationBell />);
    await screen.findByRole("link", { name: "Notifications, 12 unread" }, { timeout: 10_000 });
    const badge = await screen.findByText("9+", {}, { timeout: 10_000 });
    const style = badge.style;
    // Right edge: the bell's own box (44px), measured from the glyph it hangs off.
    expect(style.right).toMatch(/^calc\(.*100% - 44px.*\)$/);
    expect(style.left).toBe("");
    expect(badge.className).not.toMatch(/left-2\/3/);
    // No rem type or padding class that would grow with the text past its pixel ceiling (jsdom drops
    // `min()` font sizes, so the ceilings themselves are measured in Chromium).
    expect(badge.className).not.toMatch(/\btext-xs\b|\bpx-1\b/);
  });
});
