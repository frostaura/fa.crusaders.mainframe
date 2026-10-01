import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, ApiError, setUnauthorizedHandler, TOKEN_KEY, tokenStore } from "./api";
import { AuthProvider, readLastIdentity, useAuth } from "./auth";
import { forgetLastKnown, readLastKnown, rememberDoor } from "./lastKnown";
import { importHmacKey } from "./memberCode/hotp";
import { loadMemberCode, saveMemberCode } from "./memberCode/keyStore";
import { BalanceProvider } from "./balance";
import { stubFetch, type StubCall } from "../test/harness";

/**
 * What a session is allowed to carry, and where.
 *
 * <p>
 * Three defects share one root: the app treated the access token as something to keep in a
 * variable and hand around. Sign-out only deleted the client's copy, so the credential kept
 * working; the SSE stream captured the token once at sign-in and re-used it for every
 * reconnect for the life of the tab; and it put that token in a URL, where every proxy in
 * front of the API logs it verbatim.
 * </p>
 */

/** A minimal EventSource jsdom does not provide, recording every URL it was opened with. */
class FakeEventSource {
  static opened: string[] = [];
  static instances: FakeEventSource[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onopen: ((e: Event) => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeEventSource.opened.push(url);
    FakeEventSource.instances.push(this);
  }
  // The provider listens for the server's named `ping` keep-alive to tell a live stream
  // from one that has silently stopped delivering. A double without these throws where the
  // real EventSource would not, which reads as a broken provider.
  addEventListener() { /* nothing arrives in these tests */ }
  removeEventListener() { /* nothing to remove */ }
  close() { this.closed = true; }
  /** Drop the connection the way a WiFi handover does. */
  fail() { this.onerror?.(new Event("error")); }
}

afterEach(() => {
  vi.unstubAllGlobals();
  // D3 — the store is `localStorage` and survives a render, so a case that wrote one
  // would otherwise hand the next case a member's code it never asked for.
  forgetLastKnown();
  localStorage.clear();
  vi.useRealTimers();
  tokenStore.clear();
  FakeEventSource.opened = [];
  FakeEventSource.instances = [];
});

const WHOAMI = {
  tenant_slug: "crusaders", tenant_id: "00000000-0000-0000-0000-0000000000cc",
  user_id: "44444444-4444-4444-4444-444444444444", is_authenticated: true, is_admin: false,
};

function SignOutProbe() {
  const auth = useAuth();
  return (
    <div>
      <span data-testid="status">{auth.status}</span>
      <button onClick={() => { void auth.logout(); }}>Sign out</button>
    </div>
  );
}

describe("signing out revokes the credential, not just the copy in this browser", () => {
  it("posts to /api/v1/auth/logout with the token still attached", async () => {
    tokenStore.set("member.jwt.value");
    const stub = stubFetch([
      { method: "GET", path: "/api/v1/whoami", body: WHOAMI },
      { method: "POST", path: "/api/v1/auth/logout", status: 204, body: null },
    ]);

    render(<MemoryRouter><AuthProvider><SignOutProbe /></AuthProvider></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("authenticated"));

    screen.getByRole("button", { name: "Sign out" }).click();

    await waitFor(() => {
      const call = stub.calls.find((c: StubCall) => c.path === "/api/v1/auth/logout");
      expect(call).toBeDefined();
      // Sent BEFORE the local clear — a logout with no Authorization header revokes nothing.
      expect(call?.headers.authorization).toBe("Bearer member.jwt.value");
    });
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("anonymous"));
    expect(tokenStore.get()).toBeNull();
  });

  it("still signs out locally when the server call fails", async () => {
    tokenStore.set("member.jwt.value");
    stubFetch([
      { method: "GET", path: "/api/v1/whoami", body: WHOAMI },
      { method: "POST", path: "/api/v1/auth/logout", status: 500, body: { error: "boom" } },
    ]);

    render(<MemoryRouter><AuthProvider><SignOutProbe /></AuthProvider></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("authenticated"));
    screen.getByRole("button", { name: "Sign out" }).click();
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("anonymous"));
    expect(tokenStore.get()).toBeNull();
  });
});

/** Both halves of what a member sees after a session ends: where they are, and whether they were told. */
function SessionProbe() {
  const auth = useAuth();
  return (
    <div>
      <span data-testid="status">{auth.status}</span>
      <span data-testid="expired">{auth.sessionExpired ? "told" : "silent"}</span>
    </div>
  );
}

/** What a sign-out in ANOTHER tab does to the `localStorage` this tab shares with it. */
function signOutInAnotherTab(oldValue = "member.jwt.value") {
  act(() => {
    localStorage.removeItem(TOKEN_KEY);
    window.dispatchEvent(new StorageEvent("storage", { key: TOKEN_KEY, oldValue, newValue: null }));
  });
}

describe("a session that ended in another tab", () => {
  it("ends here too, and says so", async () => {
    tokenStore.set("member.jwt.value");
    stubFetch([{ method: "GET", path: "/api/v1/whoami", body: WHOAMI }]);

    render(<MemoryRouter><AuthProvider><SessionProbe /></AuthProvider></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("authenticated"));

    signOutInAnotherTab();

    // Without the `storage` listener this tab kept the whole signed-in chrome and its
    // last-rendered balance, and every request it made from then on came back refused.
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("anonymous"));
    expect(screen.getByTestId("expired")).toHaveTextContent("told");
  });

  it("keeps running when the other tab merely rotated the token", async () => {
    tokenStore.set("member.jwt.value");
    stubFetch([{ method: "GET", path: "/api/v1/whoami", body: WHOAMI }]);

    render(<MemoryRouter><AuthProvider><SessionProbe /></AuthProvider></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("authenticated"));

    // A background refresh in whichever tab got there first. The credential changed; the
    // session did not, and signing the member out over it would be a new bug for an old one.
    act(() => {
      localStorage.setItem(TOKEN_KEY, "member.jwt.rotated");
      window.dispatchEvent(new StorageEvent("storage", {
        key: TOKEN_KEY, oldValue: "member.jwt.value", newValue: "member.jwt.rotated",
      }));
    });

    expect(screen.getByTestId("status")).toHaveTextContent("authenticated");
    expect(screen.getByTestId("expired")).toHaveTextContent("silent");
  });
});

describe("a request that goes out with no token, because another tab took it", () => {
  afterEach(() => setUnauthorizedHandler(null));

  it("is read as the end of the session, not as a connection fault", async () => {
    const ended: string[] = [];
    setUnauthorizedHandler(() => ended.push("ended"));
    tokenStore.clear();
    // What the API actually answers a credential-less request: it cannot resolve a tenant, so
    // this is a 400, not a 401 — and a client branching on 401 alone reported it to the member
    // as "Check your connection and press Refresh", forever.
    stubFetch([{
      method: "GET", path: "/api/v1/schedule", status: 400,
      body: { error: "tenant_unresolved", message: "No tenant could be resolved from this request." },
    }]);

    await expect(api.get("/api/v1/schedule?date=2026-09-05")).rejects.toBeInstanceOf(ApiError);
    expect(ended).toEqual(["ended"]);
  });

  it("leaves an ordinary 400 alone", async () => {
    const ended: string[] = [];
    setUnauthorizedHandler(() => ended.push("ended"));
    tokenStore.clear();
    stubFetch([{ method: "POST", path: "/api/v1/bookings", status: 400, body: { error: "past_time" } }]);

    await expect(api.post("/api/v1/bookings", {})).rejects.toBeInstanceOf(ApiError);
    expect(ended).toEqual([]);
  });
});

function renderBalance() {
  return render(
    <MemoryRouter>
      <AuthProvider><BalanceProvider><span data-testid="ok" /></BalanceProvider></AuthProvider>
    </MemoryRouter>,
  );
}

describe("the wallet stream", () => {
  it("never puts the access token in the URL", async () => {
    tokenStore.set("member.jwt.value");
    vi.stubGlobal("EventSource", FakeEventSource);
    stubFetch([
      { method: "GET", path: "/api/v1/whoami", body: WHOAMI },
      { method: "GET", path: "/api/v1/wallet", body: { balance_minutes: 450, entries: [], total_entries: 0, offset: 0, limit: 100 } },
      { method: "POST", path: "/api/v1/wallet/stream-ticket", body: { ticket: "ticket-one", expires_in_seconds: 60 } },
    ]);

    renderBalance();

    await waitFor(() => expect(FakeEventSource.opened).toHaveLength(1));
    const url = FakeEventSource.opened[0];
    expect(url).toContain("ticket=ticket-one");
    expect(url).not.toContain("access_token");
    expect(url).not.toContain("member.jwt.value");
  });

  it("mints a fresh ticket on every reconnect, so a rotated session keeps streaming", async () => {
    tokenStore.set("member.jwt.value");
    vi.stubGlobal("EventSource", FakeEventSource);
    stubFetch([
      { method: "GET", path: "/api/v1/whoami", body: WHOAMI },
      { method: "GET", path: "/api/v1/wallet", body: { balance_minutes: 450, entries: [], total_entries: 0, offset: 0, limit: 100 } },
      {
        method: "POST", path: "/api/v1/wallet/stream-ticket", body: null,
        sequence: [
          { ticket: "ticket-one", expires_in_seconds: 60 },
          { ticket: "ticket-two", expires_in_seconds: 60 },
        ],
      },
    ]);

    renderBalance();
    await waitFor(() => expect(FakeEventSource.opened).toHaveLength(1));

    // The token rotates (a background refresh), then the connection drops (a WiFi handover).
    tokenStore.set("member.jwt.rotated");
    FakeEventSource.instances[0].fail();

    // The reconnect must go and get a NEW ticket rather than replay the one captured at
    // sign-in — that replay is what froze the header pill for the life of the tab.
    await waitFor(() => expect(FakeEventSource.opened).toHaveLength(2), { timeout: 4000 });
    expect(FakeEventSource.opened[1]).toContain("ticket=ticket-two");
  });
});

/**
 * D3 — what the member code page's last-known store is allowed to outlive.
 *
 * <p>
 * <b>Why this is a session test rather than a member-page one.</b> `lib/lastKnown` keeps a
 * member's last code, their court, their door times and the club's number in `localStorage`,
 * because the service worker is forbidden to cache a byte of member data. Until D3 nothing
 * rendered it while the club could not be reached, so nothing ever had to clear it — and
 * nothing did: `clearOfflineCache()` purges the Cache API, which `localStorage` is not part of,
 * and `forgetLastKnown()` had no caller anywhere in the app.
 * </p>
 *
 * <p>
 * Letting `/my-code` render from that store with no signal is what turns a dormant leak into a
 * live one, so the clearing is part of the same change rather than a follow-up. Both endings
 * are covered because they are different code paths and only one of them involves a member
 * pressing anything — on a shared club phone the common ending is nobody pressing anything at
 * all.
 * </p>
 */
describe("a session that ends takes the member's code key and last-known facts with it", () => {
  /**
   * What My Code leaves on a phone, written the way it writes it: the member code's key record
   * (D1 — a non-extractable key; spec §10 "logout wipes the phone's key") and the door facts.
   * `ref` stands in for "whose code" — a REF is per member.
   */
  async function storeACodeFor(ref: string, userId: string = WHOAMI.user_id) {
    await saveMemberCode({
      key: await importHmacKey(new Uint8Array(32).fill(7)),
      ref, generation: 1, tz: "Africa/Johannesburg", offsetMs: 0, userId, enrolledAt: 0,
    });
    rememberDoor({
      doors: true, doors_shut: "none", timezone: "Africa/Johannesburg", policy: "booking_window",
      membership: "active", membership_detail: "active", is_club_admin: false, next_booking: null,
      early_entry_minutes: 30, roster_max_entries: 48, contact: { phone: "021 555 0134", email: null },
      door_log_retention_days: 90, last_decision: null,
    } as Parameters<typeof rememberDoor>[0]);
    expect((await loadMemberCode())?.ref, "the fixture stored nothing").toBe(ref);
  }
  const heldRef = async () => (await loadMemberCode())?.ref ?? null;

  it("clears it when the member signs out on purpose", async () => {
    tokenStore.set("member.jwt.value");
    stubFetch([
      { method: "GET", path: "/api/v1/whoami", body: WHOAMI },
      { method: "POST", path: "/api/v1/auth/logout", status: 204, body: null },
    ]);

    render(<MemoryRouter><AuthProvider><SignOutProbe /></AuthProvider></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("authenticated"));
    await storeACodeFor("18Y9");

    screen.getByRole("button", { name: "Sign out" }).click();
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("anonymous"));

    await waitFor(async () => expect(await heldRef(), "the next person on this phone inherits a working code").toBeNull());
    expect(readLastKnown().door).toBeNull();
    expect(readLastIdentity()).toBeNull();
  });

  /**
   * F4.1 — REVERSED from D3 by the P7 decision: only an explicit sign-out wipes the key. When
   * nobody pressed anything (the token lapsed and the refresh cookie could not rescue it) the
   * member is still the member, and My Code goes on making their code from the key. It used to
   * wipe here, which turned "signed out after a while" into "locked out at the door". A
   * different member signing in on this phone still wipes it (below).
   */
  it("keeps it when the session is taken away rather than given up", async () => {
    tokenStore.set("member.jwt.value");
    stubFetch([
      { method: "GET", path: "/api/v1/whoami", status: 401, body: { error: "expired" } },
      { method: "POST", path: "/api/v1/auth/refresh", status: 401, body: { error: "session_ended" } },
    ]);
    localStorage.setItem("crusaders.mainframe.last-identity", WHOAMI.user_id);

    // Stored BEFORE the provider mounts: the 401 lands on its first probe.
    await storeACodeFor("BWDJ");
    render(<MemoryRouter><AuthProvider><SessionProbe /></AuthProvider></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("anonymous"));

    expect(tokenStore.get(), "the credential goes").toBeNull();
    await new Promise((r) => setTimeout(r, 30));
    expect(await heldRef(), "the member's own key stays").toBe("BWDJ");
    expect(readLastKnown().door).not.toBeNull();
    expect(readLastIdentity()).toBe(WHOAMI.user_id);
  });

  /**
   * The case a clean sign-out cannot cover. A phone kills the tab, the member walks off, and
   * the next member signs in on the same device: nothing ran the clearing above, so the first
   * member's code is still sitting there when the second one's session is confirmed.
   *
   * <p>
   * This is the fixture varied rather than the code — the store is written by ONE member and
   * read after a DIFFERENT one is confirmed — which is the only way the defect shows itself at
   * all. A test that signed the same member in twice passes against a version with no identity
   * check in it.
   * </p>
   */
  it("clears it when a different member is confirmed on the same device", async () => {
    tokenStore.set("first.member.jwt");
    stubFetch([{ method: "GET", path: "/api/v1/whoami", body: WHOAMI }]);
    const { unmount } = render(<MemoryRouter><AuthProvider><SessionProbe /></AuthProvider></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("authenticated"));
    await storeACodeFor("18Y9");
    expect(readLastIdentity()).toBe(WHOAMI.user_id);
    // No sign-out: the tab simply goes away, which is what a phone does to a backgrounded PWA.
    unmount();

    vi.unstubAllGlobals();
    tokenStore.set("second.member.jwt");
    stubFetch([{
      method: "GET", path: "/api/v1/whoami",
      body: { ...WHOAMI, user_id: "55555555-5555-5555-5555-555555555555" },
    }]);
    render(<MemoryRouter><AuthProvider><SessionProbe /></AuthProvider></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("authenticated"));

    await waitFor(async () => expect(await heldRef(), "the second member is holding the first member's code").toBeNull());
    expect(readLastKnown().door).toBeNull();
    expect(readLastIdentity()).toBe("55555555-5555-5555-5555-555555555555");
  });

  /** And the same member coming back keeps their own, which is the whole point of the store. */
  it("keeps it when the same member is confirmed again", async () => {
    tokenStore.set("member.jwt.value");
    stubFetch([{ method: "GET", path: "/api/v1/whoami", body: WHOAMI }]);
    const { unmount } = render(<MemoryRouter><AuthProvider><SessionProbe /></AuthProvider></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("authenticated"));
    await storeACodeFor("18Y9");
    unmount();

    vi.unstubAllGlobals();
    stubFetch([{ method: "GET", path: "/api/v1/whoami", body: WHOAMI }]);
    render(<MemoryRouter><AuthProvider><SessionProbe /></AuthProvider></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("authenticated"));

    // Given a moment in which a wipe would have landed, the key is still there.
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(await heldRef()).toBe("18Y9");
    expect(readLastKnown().door).not.toBeNull();
  });
});
