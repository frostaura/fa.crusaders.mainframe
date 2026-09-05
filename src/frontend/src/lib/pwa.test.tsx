import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { tokenStore } from "./api";
import { AuthProvider, useAuth } from "./auth";
import { clearOfflineCache } from "./pwa";
import { stubFetch } from "../test/harness";

/**
 * E-F06, the page's half: a session ending has to take the offline caches with it.
 *
 * <p>
 * The shipped version cleared the cache from ONE place — the Sign-out button. On a club-desk
 * tablet that is the path nobody takes: the member walks away, the token expires, an admin
 * resets the password, a 401 comes back. Every one of those ends the session, and every one of
 * them left the previous member's cached reads in place for the next person.
 * </p>
 *
 * <p>
 * The clear is also done from the PAGE rather than only by messaging the worker, because
 * `navigator.serviceWorker.controller` is null on the load that installed the worker, after a
 * hard reload, and whenever the worker has been terminated for idleness — so the message goes
 * nowhere and reports success on exactly the loads where it matters.
 * </p>
 */

/** A CacheStorage stand-in. jsdom has none, and the real one is what the fix deletes from. */
function fakeCaches(names: string[]) {
  const stores = new Set(names);
  const api = {
    keys: vi.fn(async () => [...stores]),
    delete: vi.fn(async (name: string) => stores.delete(name)),
    open: vi.fn(async () => ({})),
    match: vi.fn(async () => undefined),
    names: () => [...stores],
  };
  vi.stubGlobal("caches", api);
  return api;
}

/** A controlling worker that records what the page sent it. */
function fakeServiceWorker() {
  const posted: unknown[] = [];
  vi.stubGlobal("navigator", {
    ...navigator,
    serviceWorker: {
      controller: { postMessage: (msg: unknown) => { posted.push(msg); } },
      register: vi.fn(),
    },
  });
  return posted;
}

beforeEach(() => {
  tokenStore.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  tokenStore.clear();
});

describe("clearing the offline caches", () => {
  it("deletes every cache this app owns, and nothing else", async () => {
    const caches = fakeCaches([
      "crusaders-shell-v2",
      "crusaders-assets-v2",
      // Left behind by the leaking worker on devices that already ran it.
      "crusaders-api-v1",
      // Somebody else's, on a browser profile this app does not own alone.
      "workbox-precache-v2-https://other.example/",
    ]);

    await clearOfflineCache();

    expect(caches.names()).toEqual(["workbox-precache-v2-https://other.example/"]);
  });

  it("works with no controlling worker, which is when the message would be lost", async () => {
    const caches = fakeCaches(["crusaders-shell-v2"]);
    vi.stubGlobal("navigator", { ...navigator, serviceWorker: { controller: null, register: vi.fn() } });

    await clearOfflineCache();

    expect(caches.names()).toEqual([]);
  });

  it("also tells a controlling worker, so nothing in flight is written back behind the purge", async () => {
    fakeCaches(["crusaders-shell-v2"]);
    const posted = fakeServiceWorker();

    await clearOfflineCache();

    expect(posted).toEqual([{ type: "CLEAR_CACHES" }]);
  });

  it("does not throw where CacheStorage is unavailable or blocked", async () => {
    vi.stubGlobal("caches", { keys: async () => { throw new Error("blocked in private mode"); } });
    await expect(clearOfflineCache()).resolves.toBeUndefined();
  });
});

function SessionProbe() {
  const auth = useAuth();
  return <span data-testid="status">{auth.status}</span>;
}

function renderSession() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("every way a session ends drops the caches, not just the sign-out button", () => {
  it("clears them when the club refuses the stored token at bootstrap", async () => {
    // An expiry, a revocation, an admin password reset: the token is present and no longer
    // valid. This is `endSession`, and it used to clear nothing.
    const caches = fakeCaches(["crusaders-shell-v2", "crusaders-api-v1"]);
    stubFetch([{ method: "GET", path: "/api/v1/whoami", status: 401, body: { error: "unauthorized" } }]);
    tokenStore.set("expired.token.value");

    renderSession();

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("anonymous"));
    await waitFor(() => expect(caches.names()).toEqual([]));
  });

  it("clears them when the server says the token is no longer recognised", async () => {
    // The other endSession path: a 200 that answers is_authenticated: false.
    const caches = fakeCaches(["crusaders-assets-v2", "crusaders-api-v1"]);
    stubFetch([{ method: "GET", path: "/api/v1/whoami", body: { is_authenticated: false } }]);
    tokenStore.set("stale.token.value");

    renderSession();

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("anonymous"));
    await waitFor(() => expect(caches.names()).toEqual([]));
  });

  it("leaves them alone while the session is healthy", async () => {
    // The negative half: a fix that cleared on every render would be indistinguishable from
    // this one in the tests above, and would delete the offline shell on every page load.
    const caches = fakeCaches(["crusaders-shell-v2"]);
    stubFetch([{
      method: "GET", path: "/api/v1/whoami",
      body: {
        tenant_slug: "crusaders", tenant_id: "00000000-0000-0000-0000-0000000000cc",
        user_id: "44444444-4444-4444-4444-444444444444", is_authenticated: true, is_admin: false,
      },
    }]);
    tokenStore.set("good.token.value");

    renderSession();

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("authenticated"));
    expect(caches.names()).toEqual(["crusaders-shell-v2"]);
    expect(caches.delete).not.toHaveBeenCalled();
  });
});
