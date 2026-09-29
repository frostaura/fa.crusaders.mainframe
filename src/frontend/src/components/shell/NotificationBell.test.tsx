import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { resetUnread } from "@/components/inbox/useUnreadCount";
import { INBOX_COPY, bellBadge, bellLabel } from "@/lib/playersCopy";
import { renderPage, signIn, signOut, stubFetch, type StubRoute } from "@/test/harness";
import { NotificationBell } from "./NotificationBell";

/**
 * The bell in the top bar: a link to the inbox, named with the count in words, badged 1–9 then
 * "9+", and SILENT when its read fails — every older shell test leaves that read unstubbed.
 */

afterEach(() => { vi.unstubAllGlobals(); signOut(); resetUnread(); });

function routes(unread: StubRoute | null): StubRoute[] {
  const whoami = signIn({ isAdmin: false });
  return [
    { path: "/api/v1/whoami", body: whoami },
    { path: "/api/v1/wallet", body: { balance_credits: 100, entries: [], total_entries: 0, offset: 0, limit: 100 } },
    { method: "POST", path: "/api/v1/wallet/stream-ticket", status: 503, body: { error: "stream_unavailable" } },
    ...(unread ? [unread] : []),
  ];
}

function renderBell(unread: StubRoute | null) {
  stubFetch(routes(unread));
  return renderPage(
    <>
      <NotificationBell />
      <Routes>
        <Route path="/" element={<p>home</p>} />
        <Route path="/inbox" element={<h1>inbox page</h1>} />
      </Routes>
    </>,
    { reactStrictMode: true },
  );
}

/** First renders wait out the auth probe and the first read — slower when the whole suite runs. */
const SLOW = { timeout: 3000 };

const count = (n: number): StubRoute => ({ path: "/api/v1/me/notifications/unread-count", body: { unread_count: n } });

describe("the wording", () => {
  it("names the count in words, and says nothing of a zero or an unknown", () => {
    expect(bellLabel(3)).toBe("Notifications, 3 unread");
    expect(bellLabel(0)).toBe(INBOX_COPY.title);
    expect(bellLabel(null)).toBe(INBOX_COPY.title);
  });

  it("badges 1–9, then 9+", () => {
    expect(bellBadge(null)).toBeNull();
    expect(bellBadge(0)).toBeNull();
    expect(bellBadge(1)).toBe("1");
    expect(bellBadge(9)).toBe("9");
    expect(bellBadge(10)).toBe("9+");
    expect(bellBadge(250)).toBe("9+");
  });
});

describe("NotificationBell", () => {
  it("is a link to the inbox, named with the unread count", async () => {
    renderBell(count(3));
    const bell = await screen.findByRole("link", { name: "Notifications, 3 unread" }, SLOW);
    expect(bell).toHaveAttribute("href", "/inbox");
    expect(bell.querySelector("[data-unread-badge]")).toHaveTextContent("3");
  });

  it("shows 9+ past nine", async () => {
    renderBell(count(12));
    const bell = await screen.findByRole("link", { name: "Notifications, 12 unread" }, SLOW);
    expect(bell.querySelector("[data-unread-badge]")).toHaveTextContent("9+");
  });

  it("shows no badge at zero", async () => {
    const view = renderBell(count(0));
    await waitFor(() => expect(view.container.querySelector("[data-notification-bell]")).not.toBeNull(), SLOW);
    expect(screen.getByRole("link", { name: "Notifications" }).querySelector("[data-unread-badge]")).toBeNull();
  });

  it("fails silently: an unanswered read is a plain bell and no error", async () => {
    const view = renderBell(null);
    const bell = await screen.findByRole("link", { name: "Notifications" }, SLOW);
    // Give the failed read time to land.
    await new Promise((r) => setTimeout(r, 20));
    expect(bell.querySelector("[data-unread-badge]")).toBeNull();
    expect(view.container.querySelector("[role=alert]")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("navigates to the inbox and says it is there", async () => {
    renderBell(count(2));
    const bell = await screen.findByRole("link", { name: "Notifications, 2 unread" }, SLOW);
    bell.click();
    expect(await screen.findByRole("heading", { name: "inbox page" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Notifications, 2 unread" })).toHaveAttribute("aria-current", "page");
  });
});
