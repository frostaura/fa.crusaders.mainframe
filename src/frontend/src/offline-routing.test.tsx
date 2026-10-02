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
  function refused() {
    // Every call refused — whoami, and the refresh cookie's exchange too (F4.1).
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({
      ok: false, status: 401,
      headers: { get: () => null },
      text: () => Promise.resolve(JSON.stringify({ error: "expired" })),
      json: () => Promise.resolve({ error: "expired" }),
    } as unknown as Response)));
  }

  it("sends a refused token to /login from every route but My Code", async () => {
    tokenStore.set("member.jwt.value");
    localStorage.setItem(LAST_IDENTITY_KEY, "44444444-4444-4444-4444-444444444444");
    refused();

    renderAt("/schedule");

    // No route matches /login in this harness, so the redirect renders nothing — which is
    // itself the assertion: the page is not what is on the screen.
    await waitFor(() => expect(tokenStore.get(), "a refusal must clear the credential").toBeNull());
    await waitFor(() => expect(screen.queryByText("the bookings page")).not.toBeInTheDocument());
    expect(screen.queryByText(/Can't reach the club/i)).not.toBeInTheDocument();
  });

  /**
   * F4.1 (the P7 decision: only an explicit sign-out wipes the key). A refusal still ends the
   * session — the credential goes — but the member is still the member, and My Code is what they
   * open at a door; it renders signed out, from the key on the phone, for the identity the club
   * confirmed. The identity is what a sign-out clears, which is the next test's business.
   */
  it("keeps My Code for the confirmed member after the session lapsed", async () => {
    tokenStore.set("member.jwt.value");
    localStorage.setItem(LAST_IDENTITY_KEY, "44444444-4444-4444-4444-444444444444");
    refused();

    renderAt("/my-code");

    await waitFor(() => expect(tokenStore.get(), "a refusal must clear the credential").toBeNull());
    expect(await screen.findByText("the member code page")).toBeInTheDocument();
    expect(localStorage.getItem(LAST_IDENTITY_KEY), "a lapse is not a sign-out").toBe("44444444-4444-4444-4444-444444444444");
    expect(screen.queryByText(/Can't reach the club/i)).not.toBeInTheDocument();
  });

  it("sends a device with no confirmed member from My Code to /login", async () => {
    refused();
    renderAt("/my-code");
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText("the member code page")).not.toBeInTheDocument();
  });
});

/**
 * P4-1 (review round 4, performance lens) — My Code waited for the session check.
 *
 * <p>
 * On bad signal at the court `whoami` took up to 20 s, and `RequireAuth` showed the boot splash
 * for all of it: the one page built to work with no signal was the one a slow signal hid. Now a
 * device holding a token AND an identity the club has confirmed renders My Code at once while the
 * check is out; the check's answer still decides everything after (a refusal still ends the
 * session). Nothing else renders early, and a token with no confirmed identity still waits.
 * </p>
 */
describe("while the session check is still out", () => {
  /** A club that never answers — the check stays in flight for the whole test. */
  function neverAnswers() {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
  }

  it("renders My Code at once for the member this device last confirmed", async () => {
    tokenStore.set("member.jwt.value");
    localStorage.setItem(LAST_IDENTITY_KEY, "44444444-4444-4444-4444-444444444444");
    neverAnswers();

    renderAt("/my-code");

    expect(await screen.findByText("the member code page")).toBeInTheDocument();
  });

  it("keeps every other route on the splash", async () => {
    tokenStore.set("member.jwt.value");
    localStorage.setItem(LAST_IDENTITY_KEY, "44444444-4444-4444-4444-444444444444");
    neverAnswers();

    renderAt("/schedule");
    await new Promise((r) => setTimeout(r, 30));

    expect(screen.queryByText("the bookings page")).not.toBeInTheDocument();
  });

  it("waits on a token nobody has confirmed", async () => {
    tokenStore.set("member.jwt.value");
    neverAnswers();

    renderAt("/my-code");
    await new Promise((r) => setTimeout(r, 30));

    expect(screen.queryByText("the member code page")).not.toBeInTheDocument();
  });
});

/**
 * R4 wave B ("offline & instant") — the member's own pages join My Code: their reads are kept on
 * the phone for the member it confirmed (`lib/offline`), so with no signal, or while the check is
 * out, they draw what the club last said instead of "can't reach the club". The same two
 * conditions hold them (a confirmed identity, and the route on the list); the desk, top-ups and a
 * lapsed session stay where they were. R5 M5-6: the invites list is kept too, so it opens offline.
 */
describe("the member's own pages, kept on the phone", () => {
  const ID = "44444444-4444-4444-4444-444444444444";
  function renderMember(path: string) {
    return render(
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <Routes>
            {["/bookings", "/bookings/:id", "/bookings/invites", "/wallet", "/wallet/activity", "/wallet/buy", "/profile", "/inbox", "/admin/members"].map((p) => (
              <Route key={p} path={p} element={<RequireAuth admin={p.startsWith("/admin")}><p>{`page ${p}`}</p></RequireAuth>} />
            ))}
            <Route path="/login" element={<p>the sign-in page</p>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );
  }

  for (const [path, page] of [
    ["/bookings", "/bookings"], ["/bookings/b1", "/bookings/:id"], ["/bookings/invites", "/bookings/invites"], ["/wallet", "/wallet"], ["/wallet/activity", "/wallet/activity"], ["/profile", "/profile"], ["/inbox", "/inbox"],
  ]) {
    it(`opens ${path} with no signal for the member this device confirmed`, async () => {
      tokenStore.set("member.jwt.value");
      localStorage.setItem(LAST_IDENTITY_KEY, ID);
      clubUnreachable();
      renderMember(path);
      expect(await screen.findByText(`page ${page}`)).toBeInTheDocument();
      expect(screen.queryByText(/Can't reach the club/i)).not.toBeInTheDocument();
    });
  }

  for (const path of ["/wallet/buy", "/admin/members"]) {
    it(`keeps the connection notice on ${path}`, async () => {
      tokenStore.set("member.jwt.value");
      localStorage.setItem(LAST_IDENTITY_KEY, ID);
      clubUnreachable();
      renderMember(path);
      await waitFor(() => expect(screen.getByText(/Can't reach the club/i)).toBeInTheDocument());
    });
  }

  it("draws /wallet at once while the check is out, and waits on a token nobody confirmed", async () => {
    tokenStore.set("member.jwt.value");
    localStorage.setItem(LAST_IDENTITY_KEY, ID);
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    const first = renderMember("/wallet");
    expect(await screen.findByText("page /wallet")).toBeInTheDocument();
    first.unmount();
    localStorage.removeItem(LAST_IDENTITY_KEY);
    renderMember("/wallet");
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText("page /wallet")).not.toBeInTheDocument();
  });

  it("a lapsed session sends /wallet to sign-in — only My Code renders signed out", async () => {
    tokenStore.set("member.jwt.value");
    localStorage.setItem(LAST_IDENTITY_KEY, ID);
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({
      ok: false, status: 401, headers: { get: () => null },
      text: () => Promise.resolve(JSON.stringify({ error: "expired" })),
      json: () => Promise.resolve({ error: "expired" }),
    } as unknown as Response)));
    renderMember("/wallet");
    expect(await screen.findByText("the sign-in page")).toBeInTheDocument();
    expect(screen.queryByText("page /wallet")).not.toBeInTheDocument();
  });
});
