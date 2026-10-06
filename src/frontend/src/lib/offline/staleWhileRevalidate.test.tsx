import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { RequireAuth } from "@/components/shell/RequireAuth";
import { resetUnread } from "@/components/inbox/useUnreadCount";
import type { MemberNotification } from "@/lib/playersApi";
import { INBOX_COPY } from "@/lib/playersCopy";
import { useAuth } from "@/lib/useAuth";
import { ledgerRowFixture, refuse, renderPage, signIn, signOut, stubFetch, type StubRoute } from "@/test/harness";
import InboxPage from "@/pages/Inbox";
import WalletPage from "@/pages/Wallet";
import { memberReads } from "./memberReads";
import { OFFLINE_COPY, asOfLabel } from "./offlineCopy";
import { getDataOwner, peekQuery, primeQuery, setDataOwner } from "./queryCache";

/**
 * R4 wave B — the member pages drawn from `lib/offline`: what the club last said is on screen at
 * once and stays there, said with its time, when a refresh fails (a 429 included — the
 * form-factor reviewer's capture found a single rate-limited read replacing a whole screen) or the
 * club cannot be reached at all; and none of it survives a sign-out or belongs to anybody else.
 */

const ANA = "44444444-4444-4444-4444-444444444444";
const BEN = "55555555-5555-5555-5555-555555555555";
const LAST_IDENTITY_KEY = "crusaders.mainframe.last-identity";
const NOW = new Date().toISOString();

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  signOut();
  resetUnread();
  localStorage.clear();
});

function notice(id: string, headline: string): MemberNotification {
  return { id, kind: "players.reminder", headline, link: null, booking_id: null, created_at: NOW, read_at: null };
}

const ANAS = { items: [notice("n1", "Your share for Friday is still open")], unread_count: 1, next_cursor: null };

function memberRoutes(list: StubRoute, whoami: unknown): StubRoute[] {
  return [
    list,
    { path: "/api/v1/whoami", body: whoami },
    { path: "/api/v1/wallet", body: { balance_minutes: 100, entries: [], total_entries: 0, offset: 0, limit: 100 } },
    { method: "POST", path: "/api/v1/wallet/stream-ticket", status: 503, body: { error: "stream_unavailable" } },
    { path: "/api/v1/me/notifications/unread-count", body: { unread_count: 1 } },
  ];
}

const inboxList = () => screen.findByRole("list", { name: INBOX_COPY.listLabel }, { timeout: 3000 });

describe("a refresh that fails keeps what is on screen", () => {
  it("a 429 on Refresh leaves the inbox up, with 'couldn't refresh' and the time it was read", async () => {
    let refusing = false;
    stubFetch(memberRoutes({
      path: "/api/v1/me/notifications",
      respond: () => (refusing ? refuse(429, { error: "rate_limited", retry_after_seconds: 60 }) : ANAS),
    }, signIn({ isAdmin: false })));
    renderPage(<InboxPage />, { initialEntries: ["/inbox"] });
    expect(within(await inboxList()).getByText(ANAS.items[0].headline)).toBeInTheDocument();
    const readAt = Date.now();

    refusing = true;
    fireEvent.click(screen.getByRole("button", { name: INBOX_COPY.refresh }));

    const note = await screen.findByText(OFFLINE_COPY.refreshFailedTitle);
    expect(note.closest("[data-stale-notice]")).toHaveTextContent(OFFLINE_COPY.refreshFailedLine(readAt));
    // The list is still there — never the full-screen "busy" failure in its place.
    expect(within(await inboxList()).getByText(ANAS.items[0].headline)).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(INBOX_COPY.readCaveat))).toBeNull();
  });

  it("a 429 on the wallet's refresh keeps the balance and the ledger, said as last known", async () => {
    // Reduced motion: the card snaps to its figure (see Wallet.test's note on jsdom's frame clock).
    vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
      matches: query.includes("reduce"), media: query, onchange: null,
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList);
    let refusing = false;
    const wallet = { balance_minutes: 412, total_entries: 1, offset: 0, limit: 100, entries: [ledgerRowFixture()] };
    stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
      { path: "/api/v1/wallet", respond: () => (refusing ? refuse(429, { error: "rate_limited" }) : wallet) },
      { method: "POST", path: "/api/v1/wallet/stream-ticket", status: 503, body: { error: "stream_unavailable" } },
      { path: "/api/v1/me/notifications/unread-count", body: { unread_count: 0 } },
    ]);
    renderPage(<WalletPage />, { initialEntries: ["/wallet"] });
    expect(await screen.findByText("6 h 52 min", { exact: false })).toBeInTheDocument();
    refusing = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText(OFFLINE_COPY.refreshFailedTitle)).toBeInTheDocument();
    expect(screen.getByText("6 h 52 min", { exact: false })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Wallet ledger" })).toBeInTheDocument();
  });
});

describe("a revisit is instant", () => {
  it("draws the last list at once while the club is asked again", async () => {
    let visit = 1;
    const fresher = { ...ANAS, items: [notice("n2", "Sam accepted — Court 2")] };
    stubFetch(memberRoutes({
      path: "/api/v1/me/notifications",
      respond: () => (visit === 1 ? ANAS : fresher),
    }, signIn({ isAdmin: false })));
    const first = renderPage(<InboxPage />, { initialEntries: ["/inbox"] });
    await inboxList();
    first.unmount();

    visit = 2;
    // Come back a minute later (a read under JOIN_MS old is the one a link press just started).
    const later = Date.now() + 60_000;
    vi.spyOn(Date, "now").mockImplementation(() => later);
    renderPage(<InboxPage />, { initialEntries: ["/inbox"] });
    // The first paint — before any answer — is the last list, never a skeleton.
    expect(screen.getByText(ANAS.items[0].headline)).toBeInTheDocument();
    expect(document.querySelector("[data-inbox-skeleton]")).toBeNull();
    // ...and the club's newer answer replaces it.
    expect(await screen.findByText("Sam accepted — Court 2")).toBeInTheDocument();
  });
});

describe("with no signal", () => {
  function renderOffline(path: string) {
    return renderPage(
      <Routes>
        <Route path="/inbox" element={<RequireAuth><InboxPage /></RequireAuth>} />
      </Routes>,
      { initialEntries: [path] },
    );
  }

  it("the inbox opens from the phone for the member it confirmed, said as offline with its time", async () => {
    signIn({ isAdmin: false });
    localStorage.setItem(LAST_IDENTITY_KEY, ANA);
    setDataOwner(ANA);
    primeQuery(ANA, memberReads.inbox.key, ANAS);
    const keptAt = peekQuery(ANA, memberReads.inbox.key)!.at;
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));

    renderOffline("/inbox");

    expect(within(await inboxList()).getByText(ANAS.items[0].headline)).toBeInTheDocument();
    const note = (await screen.findByText(OFFLINE_COPY.staleTitle)).closest("[data-stale-notice]");
    expect(note).toHaveTextContent(`showing what we had at ${asOfLabel(keptAt)}`);
    expect(screen.queryByText(/Can't reach the club/i)).toBeNull();
  });

  it("R5 V5-2: a club that ANSWERS with a failure (503, online) is 'Couldn't refresh', never 'You're offline'", async () => {
    signIn({ isAdmin: false });
    localStorage.setItem(LAST_IDENTITY_KEY, ANA);
    setDataOwner(ANA);
    primeQuery(ANA, memberReads.inbox.key, ANAS);
    const keptAt = peekQuery(ANA, memberReads.inbox.key)!.at;
    stubFetch([
      { path: "/api/v1/whoami", status: 503, body: { error: "unavailable" } },
      { path: "/api/v1/me/notifications", status: 503, body: { error: "unavailable" } },
      { path: "/api/v1/me/notifications/unread-count", status: 503, body: { error: "unavailable" } },
    ]);

    renderOffline("/inbox");

    expect(within(await inboxList()).getByText(ANAS.items[0].headline)).toBeInTheDocument();
    const note = (await screen.findByText(OFFLINE_COPY.refreshFailedTitle)).closest("[data-stale-notice]");
    expect(note).toHaveTextContent(OFFLINE_COPY.refreshFailedLine(keptAt));
    expect(screen.queryByText(OFFLINE_COPY.staleTitle)).toBeNull();
  });

  it("R5 M5-5: Mark all read with the club unreachable is refused before sending — 'needs a connection… Nothing was sent'", async () => {
    signIn({ isAdmin: false });
    localStorage.setItem(LAST_IDENTITY_KEY, ANA);
    setDataOwner(ANA);
    primeQuery(ANA, memberReads.inbox.key, ANAS);
    // The phone believes it has signal (LiE-Fi): only the failed session check says otherwise.
    const sent = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      void input; void init;
      return Promise.reject(new TypeError("Failed to fetch"));
    });
    vi.stubGlobal("fetch", sent);

    renderOffline("/inbox");
    expect(within(await inboxList()).getByText(ANAS.items[0].headline)).toBeInTheDocument();
    // R15 X15-3 — the phone says it has signal, so the club is unreachable, not the phone offline.
    await screen.findByText(OFFLINE_COPY.unreachableTitle);
    fireEvent.click(screen.getByRole("button", { name: INBOX_COPY.markAll }));

    expect(await screen.findByText(new RegExp(OFFLINE_COPY.writeCause.slice(0, 40)))).toBeInTheDocument();
    expect(screen.queryByText(INBOX_COPY.markUnknown)).toBeNull();
    expect(sent.mock.calls.some(([, init]) => (init?.method ?? "GET").toUpperCase() === "POST" && true)).toBe(false);
    // Nothing was drawn as if it had been sent.
    expect(document.querySelectorAll("li[data-unread]").length).toBe(1);
  });

  it("with nothing on the phone it says it is offline and nothing is kept — never an empty inbox (R6 X6-4)", async () => {
    signIn({ isAdmin: false });
    localStorage.setItem(LAST_IDENTITY_KEY, ANA);
    setDataOwner(ANA);
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));

    renderOffline("/inbox");

    expect(await screen.findByText(OFFLINE_COPY.unreachableNothingKept(OFFLINE_COPY.nothingKept.inbox), { exact: false })).toBeInTheDocument();
    expect(screen.queryByText(INBOX_COPY.empty)).toBeNull();
  });
});

describe("whose reads they are", () => {
  it("a different member confirmed on the phone never sees the last member's inbox", async () => {
    localStorage.setItem(LAST_IDENTITY_KEY, BEN);
    setDataOwner(BEN);
    primeQuery(BEN, memberReads.inbox.key, { items: [notice("b1", "Ben's private notice")], unread_count: 1, next_cursor: null });
    // Ana signs in on Ben's phone: whoami confirms ANA (the token is hers).
    stubFetch(memberRoutes({ path: "/api/v1/me/notifications", body: ANAS }, signIn({ isAdmin: false })));

    renderPage(<InboxPage />, { initialEntries: ["/inbox"] });
    // Not even while the check is out: the phone's member is Ben, the token Ana's — drawn as Ben's
    // only because Ben is the member this phone confirmed, and gone the moment Ana is.
    await waitFor(() => expect(getDataOwner()).toBe(ANA));
    expect(peekQuery(BEN, memberReads.inbox.key)).toBeUndefined();
    expect(screen.queryByText("Ben's private notice")).toBeNull();
    expect(within(await inboxList()).getByText(ANAS.items[0].headline)).toBeInTheDocument();
    expect(screen.queryByText("Ben's private notice")).toBeNull();
  });

  function SignOut() {
    const auth = useAuth();
    return <button type="button" onClick={() => void auth.logout()}>sign out</button>;
  }

  it("signing out leaves nothing of the member's reads in the tab", async () => {
    stubFetch([
      ...memberRoutes({ path: "/api/v1/me/notifications", body: ANAS }, signIn({ isAdmin: false })),
      { method: "POST", path: "/api/v1/auth/logout", status: 204, body: null },
    ]);
    renderPage(<><InboxPage /><SignOut /></>, { initialEntries: ["/inbox"] });
    await inboxList();
    expect(peekQuery(ANA, memberReads.inbox.key)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "sign out" }));

    await waitFor(() => expect(getDataOwner()).toBeNull());
    expect(peekQuery(ANA, memberReads.inbox.key)).toBeUndefined();
  });
});
