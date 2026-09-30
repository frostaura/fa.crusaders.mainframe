import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, ApiError, endpoints, NetworkError, REFRESH_PATH, REFRESH_TIMEOUT_MS, resetRefreshBackoff, setUnauthorizedHandler, tokenStore } from "./api";
import { AuthProvider, useAuth } from "./auth";
import { describeFailure } from "./errors";

/**
 * F4.1 — the refresh cookie (review round 1, contract §1).
 *
 * <p>
 * "Signed out after 15 idle minutes, even at the door": the access token lapsed and the first
 * 401 ended the session. The server now sets an httpOnly rotating refresh cookie at every
 * sign-in, and `POST /auth/refresh` with no bearer trades it for a new access token. The client
 * rules held here: ONE exchange per 401 and a single retry of the request; ONE exchange for any
 * number of concurrent 401s (the cookie rotates — two spends of one link revoke the whole
 * family); never for the refresh call itself or a token-less request; and a failed exchange ends
 * the session exactly as a 401 always did.
 * </p>
 */

type Call = { method: string; path: string; auth: string | null; credentials: RequestCredentials | undefined };

function json(status: number, body: unknown): Response {
  const text = body === undefined ? "" : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: () => Promise.resolve(text) } as unknown as Response;
}

/**
 * A tiny server: a request is authorised iff it carries `Bearer fresh`; the refresh endpoint
 * answers per `refresh` below. Everything is recorded, headers and `credentials` included.
 */
function server(opts: { refresh: (n: number) => Response | Promise<Response>; whoami?: (auth: string | null) => Response }) {
  const calls: Call[] = [];
  let refreshes = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const auth = headers.authorization ?? null;
    calls.push({ method: (init?.method ?? "GET").toUpperCase(), path, auth, credentials: init?.credentials });
    if (path === REFRESH_PATH && !auth) return opts.refresh(refreshes++);
    if (path === REFRESH_PATH) return json(401, { error: "invalid_token" });
    if (path === "/api/v1/whoami" && opts.whoami) return opts.whoami(auth);
    return auth === "Bearer fresh" ? json(200, { ok: path }) : json(401, { error: "invalid_token" });
  }));
  return { calls, refreshCalls: () => calls.filter((c) => c.path === REFRESH_PATH) };
}

const LOGIN_BODY = { access_token: "fresh", user_id: "u-1", is_admin: false, must_change_password: false };

let ended = 0;
beforeEach(() => {
  ended = 0;
  setUnauthorizedHandler(() => { ended += 1; });
});
afterEach(() => {
  setUnauthorizedHandler(null);
  resetRefreshBackoff();
  vi.unstubAllGlobals();
  tokenStore.clear();
  localStorage.clear();
});

describe("the api client and the refresh cookie", () => {
  it("trades the cookie once, with credentials and no bearer, and repeats the refused request", async () => {
    tokenStore.set("stale");
    const s = server({ refresh: () => json(200, LOGIN_BODY) });

    await expect(api.get("/api/v1/wallet")).resolves.toEqual({ ok: "/api/v1/wallet" });

    expect(s.refreshCalls()).toEqual([{ method: "POST", path: REFRESH_PATH, auth: null, credentials: "include" }]);
    expect(s.calls.map((c) => `${c.path} ${c.auth}`)).toEqual([
      "/api/v1/wallet Bearer stale", `${REFRESH_PATH} null`, "/api/v1/wallet Bearer fresh",
    ]);
    expect(tokenStore.get()).toBe("fresh");
    expect(ended, "a rescued session never reaches the ended handler").toBe(0);
  });

  it("shares one exchange between every request refused at the same moment", async () => {
    tokenStore.set("stale");
    let release: (r: Response) => void = () => {};
    const s = server({ refresh: () => new Promise<Response>((resolve) => { release = resolve; }) });

    const all = Promise.all([api.get("/api/v1/wallet"), api.get("/api/v1/me/door"), api.post("/api/v1/inbox/read")]);
    await waitFor(() => expect(s.refreshCalls()).toHaveLength(1));
    // Give the other two refusals time to arrive while the exchange is still in flight.
    await new Promise((r) => setTimeout(r, 20));
    release(json(200, LOGIN_BODY));

    await expect(all).resolves.toHaveLength(3);
    expect(s.refreshCalls(), "one spend of a rotating cookie").toHaveLength(1);
    expect(ended).toBe(0);
  });

  it("does not spend the cookie again for a request refused with a token already replaced", async () => {
    tokenStore.set("stale");
    const s = server({
      refresh: () => json(200, LOGIN_BODY),
      // Refused for the stale token it carried — and by the time the answer lands, an exchange
      // elsewhere (another request, another tab) has already stored the fresh one.
      whoami: () => json(500, null),
    });
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const answer = await inner(input, init);
      if (String(input) === "/api/v1/me/door" && tokenStore.get() === "stale") tokenStore.set("fresh");
      return answer;
    }));

    await expect(api.get("/api/v1/me/door")).resolves.toEqual({ ok: "/api/v1/me/door" });
    expect(s.refreshCalls()).toHaveLength(0);
  });

  it("ends the session exactly as before when the exchange is refused — one attempt, no loop", async () => {
    tokenStore.set("stale");
    const s = server({ refresh: () => json(401, { error: "session_ended" }) });

    await expect(api.get("/api/v1/wallet")).rejects.toMatchObject({ status: 401 });

    expect(s.calls.map((c) => c.path)).toEqual(["/api/v1/wallet", REFRESH_PATH]);
    expect(tokenStore.get()).toBeNull();
    expect(ended).toBe(1);
  });

  it("refreshes once per refusal: a retry that is refused again ends the session", async () => {
    tokenStore.set("stale");
    // The exchange succeeds but hands back a token the server will not take.
    const s = server({ refresh: () => json(200, { ...LOGIN_BODY, access_token: "also-bad" }) });

    await expect(api.get("/api/v1/wallet")).rejects.toMatchObject({ status: 401 });

    expect(s.refreshCalls()).toHaveLength(1);
    expect(s.calls).toHaveLength(3);
    expect(ended).toBe(1);
  });

  it("never answers the refresh call's own 401 with another refresh", async () => {
    tokenStore.set("stale");
    const s = server({ refresh: () => json(200, LOGIN_BODY) });

    await expect(endpoints.refresh()).rejects.toMatchObject({ status: 401 });

    expect(s.refreshCalls().filter((c) => c.auth === null), "no cookie exchange behind it").toHaveLength(0);
    expect(ended).toBe(1);
  });

  it("never refreshes a token-less request — a browser signed out offline must stay signed out", async () => {
    const s = server({ refresh: () => json(200, LOGIN_BODY) });
    await expect(api.get("/api/v1/wallet")).rejects.toMatchObject({ status: 401 });
    expect(s.refreshCalls()).toHaveLength(0);
  });

  it("takes another tab's win when the server says its spend was superseded", async () => {
    tokenStore.set("stale");
    const s = server({
      refresh: () => {
        tokenStore.set("fresh"); // the other tab stored its token while ours was in flight
        return json(401, { error: "refresh_superseded" });
      },
    });

    await expect(api.get("/api/v1/wallet")).resolves.toEqual({ ok: "/api/v1/wallet" });
    expect(s.refreshCalls()).toHaveLength(1);
    expect(ended).toBe(0);
  });
});

function Status() {
  const auth = useAuth();
  return <span data-testid="status">{auth.status}</span>;
}

describe("the bootstrap probe and the refresh cookie", () => {
  it("opens a phone whose access token lapsed straight into the app", async () => {
    tokenStore.set("stale");
    const s = server({
      refresh: () => json(200, LOGIN_BODY),
      whoami: (auth) => json(200, auth === "Bearer fresh"
        ? { tenant_slug: "c", tenant_id: "t", user_id: "u-1", is_authenticated: true, is_admin: false }
        : { tenant_slug: "c", tenant_id: "t", user_id: null, is_authenticated: false, is_admin: false }),
    });
    render(<MemoryRouter><AuthProvider><Status /></AuthProvider></MemoryRouter>);

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("authenticated"));
    expect(s.refreshCalls()).toHaveLength(1);
  });

  it("goes to anonymous once when the cookie cannot rescue it either", async () => {
    tokenStore.set("stale");
    const s = server({
      refresh: () => json(401, { error: "session_ended" }),
      whoami: () => json(401, { error: "invalid_token" }),
    });
    render(<MemoryRouter><AuthProvider><Status /></AuthProvider></MemoryRouter>);

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("anonymous"));
    await new Promise((r) => setTimeout(r, 30));
    expect(s.refreshCalls()).toHaveLength(1);
    expect(s.calls.filter((c) => c.path === "/api/v1/whoami")).toHaveLength(1);
  });
});

describe("a refresh endpoint that is absent or hangs", () => {
  it.each([404, 501])("ends quickly and cleanly when the endpoint is not there (%i), so boot falls through", async (status) => {
    tokenStore.set("stale");
    const s = server({ refresh: () => json(status, { error: "no route for POST /api/v1/auth/refresh" }), whoami: () => json(401, { error: "invalid_token" }) });
    render(<MemoryRouter><AuthProvider><Status /></AuthProvider></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("anonymous"), { timeout: 1_000 });
    expect(s.refreshCalls()).toHaveLength(1);
  });

  it("never lets a hanging exchange hold the request past its own budget — and a timeout is not a sign-out (C2)", async () => {
    vi.useFakeTimers();
    try {
      tokenStore.set("stale");
      vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === REFRESH_PATH) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          });
        }
        return Promise.resolve(json(401, { error: "invalid_token" }));
      }));
      const pending = api.get("/api/v1/wallet").catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(REFRESH_TIMEOUT_MS + 10);
      await expect(pending).resolves.toBeInstanceOf(NetworkError);
      expect(ended).toBe(0);
      expect(tokenStore.get(), "the session outlives a refresh the club never answered").toBe("stale");
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * C1 — a refresh reply that lands after a sign-out is discarded (round 2, IX-H). The repro: a tab's
 * exchange is on the wire, the member signs out in another tab, the reply arrives and stored its
 * new token, and the session came back from the dead in both tabs.
 */
describe("a sign-out while an exchange is in flight (C1)", () => {
  function heldRefresh() {
    let release: (r: Response) => void = () => {};
    const s = server({ refresh: () => new Promise<Response>((resolve) => { release = resolve; }) });
    return { s, release: (r: Response) => release(r) };
  }

  it("discards the reply when another tab signed out — even before its storage event arrives here", async () => {
    tokenStore.set("stale");
    const { s, release } = heldRefresh();
    const pending = api.get("/api/v1/wallet").catch((e: unknown) => e);
    await waitFor(() => expect(s.refreshCalls()).toHaveLength(1));

    // The other tab's sign-out, as shared storage sees it: the token gone, the generation moved.
    // No `storage` event is dispatched — the reply below beats it.
    localStorage.removeItem("crusaders.mainframe.token");
    localStorage.setItem("crusaders.mainframe.session-gen", "7");
    release(json(200, LOGIN_BODY));

    await expect(pending).resolves.toMatchObject({ status: 401 });
    expect(tokenStore.get(), "the late reply must never be stored").toBeNull();
    expect(s.calls.filter((c) => c.auth === "Bearer fresh"), "and nothing retried on it").toHaveLength(0);
  });

  it("discards the reply when this tab signed out while it was on the wire", async () => {
    tokenStore.set("stale");
    let heldResolve: (r: Response) => void = () => {};
    const paths: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      paths.push(path);
      if (path === "/api/v1/whoami") return json(200, { tenant_slug: "c", tenant_id: "t", user_id: "u-1", is_authenticated: true, is_admin: false });
      if (path === REFRESH_PATH) return new Promise<Response>((resolve) => { heldResolve = resolve; });
      if (path === "/api/v1/auth/logout") return json(204, undefined);
      return headers.authorization === "Bearer fresh" ? json(200, { ok: path }) : json(401, { error: "invalid_token" });
    }));
    function SignOut() {
      const auth = useAuth();
      return <><span data-testid="status">{auth.status}</span><button onClick={() => void auth.logout()}>Sign out</button></>;
    }
    render(<MemoryRouter><AuthProvider><SignOut /></AuthProvider></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("authenticated"));

    const pending = api.get("/api/v1/wallet").catch((e: unknown) => e);
    await waitFor(() => expect(paths).toContain(REFRESH_PATH));
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("anonymous"));
    // Somebody signs straight back in on this phone? No — the point is the OLD reply: even with a
    // token present again, a reply from before the sign-out must not be stored.
    tokenStore.set("next-member");
    heldResolve(json(200, LOGIN_BODY));
    await pending;

    expect(tokenStore.get(), "the late reply replaced the next session's token").toBe("next-member");
    expect(screen.getByTestId("status")).toHaveTextContent("anonymous");
  });

  it("an open tab learns of another tab's sign-out and discards its own late reply", async () => {
    tokenStore.set("stale");
    let heldResolve: (r: Response) => void = () => {};
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push(`${path} ${headers.authorization ?? null}`);
      if (path === "/api/v1/whoami") return json(200, { tenant_slug: "c", tenant_id: "t", user_id: "u-1", is_authenticated: true, is_admin: false });
      if (path === REFRESH_PATH) return new Promise<Response>((resolve) => { heldResolve = resolve; });
      return headers.authorization === "Bearer fresh" ? json(200, { ok: path }) : json(401, { error: "invalid_token" });
    }));
    render(<MemoryRouter><AuthProvider><Status /></AuthProvider></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("authenticated"));

    const pending = api.get("/api/v1/wallet").catch((e: unknown) => e);
    await waitFor(() => expect(calls.some((c) => c.startsWith(REFRESH_PATH))).toBe(true));
    // The other tab signs out: its token removal reaches this tab as a `storage` event. The
    // stored generation is NOT moved here, so only the event can carry the news.
    act(() => {
      localStorage.removeItem("crusaders.mainframe.token");
      window.dispatchEvent(new StorageEvent("storage", { key: "crusaders.mainframe.token", oldValue: "stale", newValue: null }));
    });
    // A late reply, and a token that reappeared in between — the resurrection route.
    tokenStore.set("stale");
    heldResolve(json(200, LOGIN_BODY));
    await pending;

    expect(tokenStore.get(), "the late reply was stored over the sign-out").not.toBe("fresh");
    expect(screen.getByTestId("status")).toHaveTextContent("anonymous");
  });
});

/**
 * B-10 — the club's rate limit, `429 { error: "rate_limited", retry_after_seconds }`, is busy,
 * not unreachable: said as such (with the seconds), and never an ended session.
 */
describe("a rate-limited club (B-10)", () => {
  it("says too many requests, with the wait, on the request and on the next one inside the backoff", async () => {
    tokenStore.set("stale");
    server({ refresh: () => json(429, { error: "rate_limited", retry_after_seconds: 12 }) });

    const first = await api.get("/api/v1/wallet").catch((e: unknown) => e);
    const second = await api.get("/api/v1/me/door").catch((e: unknown) => e);

    for (const err of [first, second]) {
      expect(describeFailure(err, { action: "load your wallet" })).toBe("Too many requests right now — wait 12 seconds and try again.");
      expect(describeFailure(err)).not.toMatch(/connection|reach/i);
    }
    expect(tokenStore.get()).toBe("stale");
    expect(ended).toBe(0);
  });

  it("a rate-limited request itself reads the same way, and without seconds says a moment", () => {
    expect(describeFailure(new ApiError(429, { error: "rate_limited", retry_after_seconds: 1 }))).toBe("Too many requests right now — wait 1 second and try again.");
    expect(describeFailure(new ApiError(429, { error: "rate_limited" }))).toBe("Too many requests right now — wait a moment and try again.");
  });
});

/**
 * C2 — only a 401 from /auth/refresh ends the session (round 2, IX-H). The repro: a redeploy's
 * 503 (or a 429, a dropped network, the 8 s timeout) on the refresh call signed every member out.
 */
describe("a refresh the club did not answer (C2)", () => {
  it.each([
    ["503", () => json(503, { error: "unavailable" }), (e: unknown) => e instanceof ApiError && e.status === 503],
    ["429", () => json(429, { error: "rate_limited" }), (e: unknown) => e instanceof ApiError && e.status === 429],
    ["no network", () => Promise.reject(new TypeError("Failed to fetch")), (e: unknown) => e instanceof NetworkError],
  ])("keeps the session on a %s and fails the request as the club being unreachable", async (_name, answer, isTransient) => {
    tokenStore.set("stale");
    const s = server({ refresh: answer as () => Response });

    const err = await api.get("/api/v1/wallet").catch((e: unknown) => e);

    expect(isTransient(err), String(err)).toBe(true);
    expect(tokenStore.get(), "the token is kept").toBe("stale");
    expect(ended, "the session is not ended").toBe(0);
    expect(s.refreshCalls()).toHaveLength(1);
  });

  it("backs off: requests refused inside the backoff do not spend the cookie again; the next one after it does", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      tokenStore.set("stale");
      let n = 0;
      const s = server({ refresh: () => (n++ === 0 ? json(503, null) : json(200, LOGIN_BODY)) });

      await expect(api.get("/api/v1/wallet")).rejects.toBeInstanceOf(ApiError);
      // Inside the backoff the SAME answer is repeated — a 503 stays a 503, never "unreachable".
      await expect(api.get("/api/v1/me/door")).rejects.toMatchObject({ status: 503 });
      expect(s.refreshCalls(), "single-flight with backoff").toHaveLength(1);

      vi.setSystemTime(Date.now() + 1_500);
      await expect(api.get("/api/v1/me/door")).resolves.toEqual({ ok: "/api/v1/me/door" });
      expect(s.refreshCalls()).toHaveLength(2);
      expect(ended).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the bootstrap waits out a 503 on the refresh in the outage state, token kept — never /login", async () => {
    tokenStore.set("stale");
    server({ refresh: () => json(503, null), whoami: () => json(401, { error: "invalid_token" }) });
    render(<MemoryRouter><AuthProvider><Status /></AuthProvider></MemoryRouter>);

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("offline"));
    expect(tokenStore.get()).toBe("stale");
  });

  it("tries again when the tab comes back into view after a transient failure", async () => {
    tokenStore.set("stale");
    let n = 0;
    const s = server({
      refresh: () => (n++ === 0 ? json(503, null) : json(200, LOGIN_BODY)),
      whoami: (auth) => json(200, { tenant_slug: "c", tenant_id: "t", user_id: "u-1", is_authenticated: true, is_admin: false, auth }),
    });
    render(<MemoryRouter><AuthProvider><Status /></AuthProvider></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("authenticated"), { timeout: 5_000 });
    await expect(api.get("/api/v1/wallet")).rejects.toBeInstanceOf(ApiError);

    act(() => { document.dispatchEvent(new Event("visibilitychange")); });

    // Generous: the full suite runs this under heavy load (it failed once at the 1 s default).
    await waitFor(() => expect(tokenStore.get()).toBe("fresh"), { timeout: 5_000 });
    expect(s.refreshCalls()).toHaveLength(2);
  });
});
