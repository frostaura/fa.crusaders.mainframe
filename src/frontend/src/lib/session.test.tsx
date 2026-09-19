import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, ApiError, setUnauthorizedHandler, TOKEN_KEY, tokenStore } from "./api";
import { AuthProvider, useAuth } from "./auth";
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
      { method: "GET", path: "/api/v1/wallet", body: { balance_credits: 450, entries: [], total_entries: 0, offset: 0, limit: 100 } },
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
      { method: "GET", path: "/api/v1/wallet", body: { balance_credits: 450, entries: [], total_entries: 0, offset: 0, limit: 100 } },
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
