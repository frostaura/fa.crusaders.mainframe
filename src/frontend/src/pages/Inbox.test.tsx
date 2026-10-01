import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router-dom";
import { resetUnread } from "@/components/inbox/useUnreadCount";
import { NotificationBell } from "@/components/shell/NotificationBell";
import type { MemberNotification } from "@/lib/playersApi";
import { INBOX_COPY } from "@/lib/playersCopy";
import { refuse, renderPage, signIn, signOut, stubFetch, type FetchStub, type StubRoute } from "@/test/harness";
import InboxPage from "./Inbox";

/**
 * `/inbox`: the list newest first, older pages by cursor, a tap that opens a notice marks it
 * read, "Mark all read" is optimistic and rolls back — and the three states a read can be in
 * (reading, failed, answered-empty) are three different screens.
 */

afterEach(() => { vi.unstubAllGlobals(); signOut(); resetUnread(); });

const NOW = new Date().toISOString();

function notice(overrides: Partial<MemberNotification> = {}): MemberNotification {
  return {
    id: "n1", kind: "players.invited", headline: "Sam asked you to play — Court 1, Wed 30 Sep, 18:00",
    link: "/invites/p3", booking_id: "b1", created_at: NOW, read_at: null, ...overrides,
  };
}

const FIRST = [
  notice(),
  notice({ id: "n2", kind: "players.share_moved", headline: "Alex paid their 25 min share", link: "/bookings/b1", read_at: NOW }),
  notice({ id: "n3", kind: "players.reminder", headline: "Your share for Friday is still open", link: null }),
];

type Setup = { items?: MemberNotification[]; next?: string | null; unread?: number; extra?: StubRoute[]; list?: StubRoute };

function setup(options: Setup = {}): FetchStub {
  const whoami = signIn({ isAdmin: false });
  const unread = options.unread ?? 2;
  return stubFetch([
    // A test's own routes first: among equal prefixes the first declared answers.
    ...(options.extra ?? []),
    { path: "/api/v1/whoami", body: whoami },
    { path: "/api/v1/wallet", body: { balance_minutes: 100, entries: [], total_entries: 0, offset: 0, limit: 100 } },
    { method: "POST", path: "/api/v1/wallet/stream-ticket", status: 503, body: { error: "stream_unavailable" } },
    { path: "/api/v1/me/notifications/unread-count", body: { unread_count: unread } },
    options.list ?? {
      path: "/api/v1/me/notifications",
      body: { items: options.items ?? FIRST, unread_count: unread, next_cursor: options.next ?? null },
    },
  ]);
}

function At() {
  const { pathname } = useLocation();
  return <output data-testid="at">{pathname}</output>;
}

function renderInbox() {
  return renderPage(
    <>
      <NotificationBell />
      <Routes>
        <Route path="/inbox" element={<InboxPage />} />
        <Route path="*" element={<p>elsewhere</p>} />
      </Routes>
      <At />
    </>,
    { initialEntries: ["/inbox"], reactStrictMode: true },
  );
}

/** First renders wait out the auth probe and the first read — slower when the whole suite runs. */
const SLOW = { timeout: 3000 };

const list = () => screen.findByRole("list", { name: INBOX_COPY.listLabel }, SLOW);

describe("the inbox", () => {
  it("lists notices newest first, with unread ones marked in words as well as looks", async () => {
    setup();
    renderInbox();
    const rows = within(await list()).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveAttribute("data-unread");
    expect(rows[0]).toHaveTextContent(INBOX_COPY.unread);
    expect(rows[1]).not.toHaveAttribute("data-unread");
    expect(rows[1]).not.toHaveTextContent(INBOX_COPY.unread);
    // A notice that opens somewhere is ONE link, named by its headline.
    const invite = within(rows[0]).getByRole("link", { name: FIRST[0].headline });
    expect(invite).toHaveAttribute("href", "/invites/p3");
    // One without a link offers "Mark read" instead.
    expect(within(rows[2]).queryByRole("link")).toBeNull();
    expect(within(rows[2]).getByRole("button", { name: INBOX_COPY.markOne })).toBeInTheDocument();
    expect(rows[0]).toHaveTextContent(`${INBOX_COPY.today}, `);
  });

  it("shows a skeleton while reading, never 'Loading…'", async () => {
    setup({ list: { path: "/api/v1/me/notifications", respond: () => new Promise(() => {}) } });
    const view = renderInbox();
    expect(view.container.querySelector("[data-inbox-skeleton]")).not.toBeNull();
    expect(screen.queryByText(/Loading/)).toBeNull();
  });

  it("says nothing has arrived only when the read ANSWERED with nothing", async () => {
    setup({ items: [], unread: 0 });
    renderInbox();
    expect(await screen.findByText(INBOX_COPY.empty)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: INBOX_COPY.markAll })).toBeNull();
  });

  // A 5xx is a deployment fault, which StateBlock deliberately offers no retry for.
  it("turns a failed read into a failure with a retry — not an empty inbox", async () => {
    // Refused until Try again is pressed — however many first reads StrictMode makes.
    let refusing = true;
    setup({
      list: {
        path: "/api/v1/me/notifications",
        respond: () => (refusing ? refuse(429, { error: "rate_limited" }) : { items: FIRST, unread_count: 2, next_cursor: null }),
      },
    });
    renderInbox();
    expect(await screen.findByText(new RegExp(INBOX_COPY.readCaveat))).toBeInTheDocument();
    expect(screen.queryByText(INBOX_COPY.empty)).toBeNull();
    refusing = false;
    screen.getByRole("button", { name: "Try again" }).click();
    expect(await list()).toBeInTheDocument();
  });

  it("pages older notices with Show more", async () => {
    const stub = setup({
      list: {
        path: "/api/v1/me/notifications",
        respond: ({ path }) => path.includes("cursor=")
          ? { items: [notice({ id: "n9", headline: "An older one", link: null, read_at: NOW })], unread_count: 2, next_cursor: null }
          : { items: FIRST, unread_count: 2, next_cursor: "CUR1" },
      },
    });
    renderInbox();
    await list();
    screen.getByRole("button", { name: INBOX_COPY.showMore }).click();
    expect(await screen.findByText("An older one")).toBeInTheDocument();
    expect(within(await list()).getAllByRole("listitem")).toHaveLength(4);
    expect(screen.queryByRole("button", { name: INBOX_COPY.showMore })).toBeNull();
    expect(stub.calls.some((c) => c.path.includes("cursor=CUR1") && c.path.includes("limit=20"))).toBe(true);
  });

  it("marks a notice read when it is opened, and the bell drops at once", async () => {
    const stub = setup({ extra: [{ method: "POST", path: "/api/v1/me/notifications/n1/read", body: { id: "n1", read: true } }] });
    renderInbox();
    await screen.findByRole("link", { name: "Notifications, 2 unread" }, SLOW);
    const rows = within(await list()).getAllByRole("listitem");
    within(rows[0]).getByRole("link", { name: FIRST[0].headline }).click();
    await waitFor(() => expect(screen.getByTestId("at")).toHaveTextContent("/invites/p3"));
    expect(await screen.findByRole("link", { name: "Notifications, 1 unread" })).toBeInTheDocument();
    await waitFor(() => expect(stub.calls.some((c) => c.method === "POST" && c.path.endsWith("/n1/read"))).toBe(true));
  });

  it("marks one without a link read with its button", async () => {
    const stub = setup({ extra: [{ method: "POST", path: "/api/v1/me/notifications/n3/read", body: { id: "n3", read: true } }] });
    renderInbox();
    // The bell's own first read has landed (the stub's figure is static, so it must not land late).
    await screen.findByRole("link", { name: "Notifications, 2 unread" }, SLOW);
    const rows = within(await list()).getAllByRole("listitem");
    within(rows[2]).getByRole("button", { name: INBOX_COPY.markOne }).click();
    await waitFor(() => expect(rows[2]).not.toHaveAttribute("data-unread"));
    expect(await screen.findByRole("link", { name: "Notifications, 1 unread" })).toBeInTheDocument();
    expect(stub.calls.some((c) => c.method === "POST" && c.path.endsWith("/n3/read"))).toBe(true);
  });

  it("marks all read optimistically", async () => {
    setup({ extra: [{ method: "POST", path: "/api/v1/me/notifications/read-all", body: { marked: 2 } }] });
    renderInbox();
    await screen.findByRole("link", { name: "Notifications, 2 unread" }, SLOW);
    await list();
    (await screen.findByRole("button", { name: INBOX_COPY.markAll })).click();
    await waitFor(() => expect(document.querySelectorAll("[data-unread]")).toHaveLength(0));
    expect(await screen.findByRole("link", { name: "Notifications" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: INBOX_COPY.markAll })).toBeNull();
  });

  it("R5 X5-12: Mark all read is a full 44px target, not a 36px one", async () => {
    setup({});
    renderInbox();
    await list();
    const button = await screen.findByRole("button", { name: INBOX_COPY.markAll });
    expect(button.className.split(" ")).toContain("min-h-touch");
    expect(button.className.split(" ")).not.toContain("min-h-9");
  });

  it("R4 X4-5: Mark all read puts focus on the list, never <body>, and says \"All read\"", async () => {
    setup({ extra: [{ method: "POST", path: "/api/v1/me/notifications/read-all", body: { marked: 2 } }] });
    renderInbox();
    await screen.findByRole("link", { name: "Notifications, 2 unread" }, SLOW);
    const ol = await list();
    const button = await screen.findByRole("button", { name: INBOX_COPY.markAll });
    button.focus();
    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByRole("button", { name: INBOX_COPY.markAll })).toBeNull());
    expect(document.activeElement).toBe(ol);
    await waitFor(() => expect(document.querySelector("[data-inbox-said]")).toHaveTextContent(INBOX_COPY.allRead));
    expect(document.querySelector("[data-inbox-said]")).toHaveAttribute("role", "status");
  });

  it("rolls mark-all back when the server refuses, and says so", async () => {
    setup({ extra: [{ method: "POST", path: "/api/v1/me/notifications/read-all", status: 500, body: { error: "boom" } }] });
    renderInbox();
    await screen.findByRole("link", { name: "Notifications, 2 unread" }, SLOW);
    await list();
    (await screen.findByRole("button", { name: INBOX_COPY.markAll })).click();
    expect(await screen.findByText(new RegExp(`Couldn't ${INBOX_COPY.markAllAction}`))).toBeInTheDocument();
    await waitFor(() => expect(document.querySelectorAll("[data-unread]")).toHaveLength(2));
    expect(await screen.findByRole("link", { name: "Notifications, 2 unread" }, SLOW)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: INBOX_COPY.markAll })).toBeInTheDocument();
  });

  it("R3 lost-reply audit: a mark-all that landed behind a 504 stays read — no rollback, no failure", async () => {
    let unread = 2;
    setup({ extra: [
      { method: "POST", path: "/api/v1/me/notifications/read-all", respond: () => { unread = 0; return refuse(504, { error: "gateway_timeout" }); } },
      { path: "/api/v1/me/notifications/unread-count", respond: () => ({ unread_count: unread }) },
    ] });
    renderInbox();
    await screen.findByRole("link", { name: "Notifications, 2 unread" }, SLOW);
    await list();
    (await screen.findByRole("button", { name: INBOX_COPY.markAll })).click();
    await waitFor(() => expect(unread).toBe(0));
    await new Promise((r) => { setTimeout(r, 200); });
    expect(document.querySelectorAll("[data-unread]")).toHaveLength(0);
    expect(screen.queryByText(new RegExp(`Couldn't ${INBOX_COPY.markAllAction}`))).toBeNull();
  });
});
