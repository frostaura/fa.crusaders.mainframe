import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ApiError, NetworkError, REQUEST_TIMEOUT_MS, api, tokenStore } from "./api";
import { AuthProvider, useAuth } from "./auth";

/**
 * Resilience of the session and of a single request, which are two halves of the same
 * question: what does the app do when the club does not answer?
 *
 * <p>
 * Both defects here were invisible from the code and obvious the moment a backend was made
 * to stall or to 502 — the first left every member permanently signed out after a redeploy,
 * the second left the Book button spinning with no way to know whether money had moved.
 * </p>
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  tokenStore.clear();
});

/**
 * A fetch that accepts the connection and never answers — a wedged gateway or a dropped phone.
 *
 * <p>
 * It honours `signal` exactly as the real `fetch` does (reject with an `AbortError` when the
 * signal fires) because that is the only thing that can end the call: a stub that ignored the
 * signal would hang whether or not the timeout existed, and would prove nothing either way.
 * </p>
 */
function stallingFetch() {
  const stub = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
  }));
  vi.stubGlobal("fetch", stub);
  return stub;
}

describe("request deadline", () => {
  it("gives up on a stalled backend instead of waiting forever", async () => {
    vi.useFakeTimers();
    stallingFetch();

    const call = api.get("/api/v1/schedule");
    const settled = vi.fn();
    call.then(settled, settled);

    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1000);
    expect(settled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2000);
    await expect(call).rejects.toBeInstanceOf(NetworkError);
    await expect(call).rejects.toMatchObject({ kind: "timeout" });
  });

  it("passes an abort signal so the socket is actually released", async () => {
    vi.useFakeTimers();
    const stub = stallingFetch();
    const call = api.post("/api/v1/bookings", { courtId: "c1" });
    call.catch(() => {});

    const init = stub.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1000);
    expect(init.signal?.aborted).toBe(true);
  });

  it("reports an unreachable club as a NetworkError, not as an ApiError", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
    await expect(api.get("/api/v1/schedule")).rejects.toBeInstanceOf(NetworkError);
    await expect(api.get("/api/v1/schedule")).rejects.toMatchObject({ kind: "unreachable" });
  });
});

function SessionProbe() {
  const auth = useAuth();
  return <span data-testid="status">{auth.status}</span>;
}

function renderSession() {
  return render(
    <MemoryRouter>
      <AuthProvider><SessionProbe /></AuthProvider>
    </MemoryRouter>,
  );
}

/** A whoami that answers with `status` and the given body. */
function whoamiAnswers(status: number, body: unknown) {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({
    ok: status < 400,
    status,
    headers: { get: () => null },
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
    json: () => Promise.resolve(body),
  } as unknown as Response)));
}

describe("a transient outage must not end the session", () => {
  it("keeps the stored token when the gateway answers 502", async () => {
    tokenStore.set("member.jwt.value");
    // Exactly what nginx returns while the backend container restarts: an HTML error page.
    whoamiAnswers(502, "<html><head><title>502 Bad Gateway</title></head></html>");

    renderSession();

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("offline"));
    expect(tokenStore.get()).toBe("member.jwt.value");
  });

  it("keeps the stored token when the club cannot be reached at all", async () => {
    tokenStore.set("member.jwt.value");
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));

    renderSession();

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("offline"));
    expect(tokenStore.get()).toBe("member.jwt.value");
  });

  it("recovers on its own once the backend answers again", async () => {
    tokenStore.set("member.jwt.value");
    let down = true;
    vi.stubGlobal("fetch", vi.fn(() => (down
      ? Promise.reject(new TypeError("Failed to fetch"))
      : Promise.resolve({
        ok: true, status: 200, headers: { get: () => null },
        text: () => Promise.resolve(JSON.stringify({
          tenant_slug: "crusaders", tenant_id: "t", user_id: "u1",
          is_authenticated: true, is_admin: false,
        })),
        json: () => Promise.resolve({}),
      } as unknown as Response))));

    renderSession();
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("offline"));

    down = false;
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("authenticated"), { timeout: 4000 });
    expect(tokenStore.get()).toBe("member.jwt.value");
  });

  it("still ends the session when the server actually refuses the token", async () => {
    tokenStore.set("stale.jwt.value");
    whoamiAnswers(200, {
      tenant_slug: "crusaders", tenant_id: "t", user_id: null,
      is_authenticated: false, is_admin: false,
    });

    renderSession();

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("anonymous"));
    expect(tokenStore.get()).toBeNull();
  });

  it("still ends the session on a 401 from the probe", async () => {
    tokenStore.set("stale.jwt.value");
    whoamiAnswers(401, { error: "unauthorized" });

    renderSession();

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("anonymous"));
    expect(tokenStore.get()).toBeNull();
  });
});

describe("unknown routes", () => {
  it("say so rather than silently redirecting to the home page", async () => {
    const { default: NotFoundPage } = await import("../pages/NotFound");
    render(
      <MemoryRouter initialEntries={["/some/deep/nonexistent"]}>
        <Routes><Route path="*" element={<NotFoundPage />} /></Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText("Page not found")).toBeInTheDocument();
  });
});

describe("error classification", () => {
  it("keeps ApiError and NetworkError distinguishable", () => {
    expect(new ApiError(409, { error: "slot_taken" })).toBeInstanceOf(ApiError);
    expect(new NetworkError("timeout")).not.toBeInstanceOf(ApiError);
  });
});
