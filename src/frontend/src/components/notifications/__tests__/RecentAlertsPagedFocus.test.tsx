import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { RecentAlerts } from "@/components/notifications/RecentAlerts";
import { useRecentAlerts } from "@/components/notifications/useRecentAlerts";
import { noticeFixture } from "@/components/notifications/fixtures";
import { RECENT_ALERTS_COPY as COPY } from "@/lib/notificationsCopy";
import { renderPage, signIn, signOut, stubFetch } from "@/test/harness";

/**
 * R13 X13-1 — the Overview's last "Show older alerts" takes its button away; focus must land on the
 * first alert that page brought (its link, or the row itself when it opens nowhere), never `<body>`.
 */

afterEach(() => { vi.unstubAllGlobals(); signOut(); });

function Feed() {
  const feed = useRecentAlerts();
  return <RecentAlerts feed={feed} />;
}

describe("Recent alerts — the last Show older alerts", () => {
  it.each([
    ["an alert that opens somewhere (its link)", { link: "/admin/members" }, "A"],
    ["an alert with nowhere to open (the row)", { link: null }, "DIV"],
  ])("focuses %s", async (_name, older, tag) => {
    signIn({ isAdmin: true });
    const first = [noticeFixture({ headline: "Newest alert" }), noticeFixture({ headline: "Second alert" })];
    stubFetch([
      {
        path: "/api/v1/admin/notifications",
        respond: ({ path }) => path.includes("cursor=")
          ? { items: [noticeFixture({ headline: "An older alert", ...older })], next_cursor: null }
          : { items: first, next_cursor: "CUR1" },
      },
    ]);
    renderPage(<Feed />);
    const button = await screen.findByRole("button", { name: COPY.loadMore }, { timeout: 3000 });
    button.focus();
    fireEvent.click(button);
    await screen.findByText("An older alert");
    await waitFor(() => expect(screen.queryByRole("button", { name: COPY.loadMore })).toBeNull());
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    const rows = within(screen.getByRole("list", { name: COPY.listLabel })).getAllByRole("listitem");
    expect(document.activeElement?.tagName).toBe(tag);
    expect(rows[2].contains(document.activeElement)).toBe(true);
  }, 30_000);
});
