import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { RequireAuth } from "./App";
import { AuthProvider } from "./lib/auth";
import { forgetLastKnown } from "./lib/lastKnown";
import { tokenStore } from "./lib/api";

/**
 * D3 — which routes may render with no signal, and on whose say-so.
 *
 * <p>
 * `RequireAuth` used to have one answer for the offline state: replace the route with
 * `ConnectionLost`. That is right for every screen whose sentences need the club to be
 * reachable, and wrong for the one screen built to be true without it — a member standing at a
 * locked door with no signal is the case `lib/lastKnown` exists for, and the app-wide gate
 * fired before the page that knew how to cope.
 * </p>
 *
 * <p>
 * <b>Why these cases are not in `e2e/my-code-offline.spec.ts`.</b> That spec builds the
 * production bundle, registers the real service worker and goes genuinely offline, which is the
 * only honest way to prove the happy path — and it is exactly the wrong instrument for the two
 * conditions that GUARD it, because it necessarily arrives with both already satisfied. Proved
 * by mutation: dropping the identity check, and opening the gate to every route, both left that
 * spec green. A negative needs a harness that can withhold the thing.
 * </p>
 */

const LAST_IDENTITY_KEY = "crusaders.mainframe.last-identity";

afterEach(() => {
  vi.unstubAllGlobals();
  tokenStore.clear();
  forgetLastKnown();
  localStorage.clear();
});

/** The club unreachable — a network failure, which is what `offline` means and a 401 is not. */
function clubUnreachable() {
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <Routes>
          <Route path="/my-code" element={<RequireAuth><p>the member code page</p></RequireAuth>} />
          <Route path="/schedule" element={<RequireAuth><p>the bookings page</p></RequireAuth>} />
          <Route path="/admin/doors" element={<RequireAuth admin><p>the doors page</p></RequireAuth>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("what may render while the club cannot be reached", () => {
  it("lets /my-code through when this device has a confirmed identity", async () => {
    tokenStore.set("member.jwt.value");
    localStorage.setItem(LAST_IDENTITY_KEY, "44444444-4444-4444-4444-444444444444");
    clubUnreachable();

    renderAt("/my-code");

    await waitFor(() => expect(screen.getByText("the member code page")).toBeInTheDocument());
    expect(screen.queryByText(/Can't reach the club/i)).not.toBeInTheDocument();
  });

  /**
   * The condition the e2e cannot withhold. A token is a string in `localStorage` that nothing
   * has vouched for — it can be stale, hand-planted, or left by a profile restore — and on its
   * own it is not a reason to render anything belonging to a person. A device that has never
   * had a session confirmed also has no last-known store to render, so the honest
   * "can't reach it" screen is both safer and more accurate.
   */
  it("does not let /my-code through on a token alone", async () => {
    tokenStore.set("member.jwt.value");
    // No identity: whoami has never succeeded on this device.
    clubUnreachable();

    renderAt("/my-code");

    await waitFor(() => expect(screen.getByText(/Can't reach the club/i)).toBeInTheDocument());
    expect(screen.queryByText("the member code page")).not.toBeInTheDocument();
  });

  /**
   * And the list is a list. Every other screen needs the club to say anything true — the
   * schedule, the wallet, every admin surface — so the gate stays shut on them even for a
   * member whose identity this device has confirmed.
   */
  for (const route of [
    { path: "/schedule", body: "the bookings page" },
    { path: "/admin/doors", body: "the doors page" },
  ]) {
    it(`keeps the connection notice on ${route.path}`, async () => {
      tokenStore.set("member.jwt.value");
      localStorage.setItem(LAST_IDENTITY_KEY, "44444444-4444-4444-4444-444444444444");
      clubUnreachable();

      renderAt(route.path);

      await waitFor(() => expect(screen.getByText(/Can't reach the club/i)).toBeInTheDocument());
      expect(screen.queryByText(route.body)).not.toBeInTheDocument();
    });
  }

  /**
   * A REFUSAL is not an outage, and this is the distinction the whole offline state was built
   * around: "the club says this token is bad" ends the session, and no amount of stored
   * identity may talk the app out of it. Without this, the fix above would be a way of staying
   * signed in after being signed out.
   */
  it("sends a refused token to /login even with a confirmed identity on the device", async () => {
    tokenStore.set("member.jwt.value");
    localStorage.setItem(LAST_IDENTITY_KEY, "44444444-4444-4444-4444-444444444444");
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({
      ok: false, status: 401,
      headers: { get: () => null },
      text: () => Promise.resolve(JSON.stringify({ error: "expired" })),
      json: () => Promise.resolve({ error: "expired" }),
    } as unknown as Response)));

    renderAt("/my-code");

    // No route matches /login in this harness, so the redirect renders nothing — which is
    // itself the assertion: the member code page is not what is on the screen.
    await waitFor(() => expect(screen.queryByText("the member code page")).not.toBeInTheDocument());
    expect(screen.queryByText(/Can't reach the club/i)).not.toBeInTheDocument();
    expect(tokenStore.get(), "a refusal must clear the credential").toBeNull();
    expect(localStorage.getItem(LAST_IDENTITY_KEY), "and the identity with it").toBeNull();
  });
});
