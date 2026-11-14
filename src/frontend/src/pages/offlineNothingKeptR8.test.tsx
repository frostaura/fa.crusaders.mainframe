import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { renderPage, signIn, signOut } from "@/test/harness";
import InvitesPage from "@/pages/Invites";
import BookingDetailPage from "@/pages/BookingDetail";
import BookingsPage from "@/pages/Schedule";
import { MyGameSection } from "@/components/play/MyGameSection";
import { OFFLINE_COPY } from "@/lib/offline/offlineCopy";
import { setDataOwner } from "@/lib/offline/queryCache";

/**
 * R8 X7-3 (rest) and X8-2 (Bookings) — a cold start that cannot reach the club, on a page never
 * opened on this phone, says "You're offline — … nothing kept", never red "couldn't be reached",
 * EVEN WHEN `navigator.onLine` says the phone is online (Wi-Fi without internet: R7's fix keyed on
 * `onLine` alone, which memory/decisions-frontend-offline-data says never to trust). Offline is
 * judged from the failed read (a NetworkError). A club that ANSWERS with a failure (503) is not
 * offline: that keeps its red failure and its retry.
 *
 * R15 X15-3 — the notice stays, its WORDS follow `navigator.onLine`: online, it is "Can't reach the
 * club" and the line's "once you're back online" reads "Try again in a moment".
 */

const ANA = "44444444-4444-4444-4444-444444444444";
const LAST_IDENTITY_KEY = "crusaders.mainframe.last-identity";

beforeEach(() => {
  vi.stubGlobal("EventSource", class { close() {} addEventListener() {} removeEventListener() {} } as unknown as typeof EventSource);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  signOut();
  localStorage.clear();
});

/** Wi-Fi with no internet: the phone believes it is online, and nothing answers. */
function lieFiPhone() {
  signIn({ isAdmin: false });
  localStorage.setItem(LAST_IDENTITY_KEY, ANA);
  setDataOwner(ANA);
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
}

const WAIT = { timeout: 4000 };
const NOTHING_KEPT = "[data-offline-nothing-kept]";

describe("X7-3 rest — a connection failure with nothing kept is offline, whatever navigator.onLine says", () => {
  it("Invites", async () => {
    lieFiPhone();
    renderPage(<InvitesPage />, { initialEntries: ["/bookings/invites"] });
    expect(await screen.findByText(OFFLINE_COPY.unreachableNothingKept(OFFLINE_COPY.nothingKept.invites), { exact: false }, WAIT)).toBeInTheDocument();
    expect(screen.queryByText(/couldn't be reached/i)).toBeNull();
    // No `online` event will come on Wi-Fi without internet: the failure's retry stays beside it.
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("a booking's page", async () => {
    lieFiPhone();
    renderPage(<Routes><Route path="/bookings/:bookingId" element={<BookingDetailPage />} /></Routes>, { initialEntries: ["/bookings/bk-1"] });
    expect(await screen.findByText(OFFLINE_COPY.unreachableNothingKept(OFFLINE_COPY.nothingKept.booking), { exact: false }, WAIT)).toBeInTheDocument();
    expect(screen.queryByText(/couldn't be reached/i)).toBeNull();
  });

  it("Profile's My game", async () => {
    lieFiPhone();
    renderPage(<MyGameSection />, { initialEntries: ["/profile"] });
    expect(await screen.findByText(OFFLINE_COPY.unreachableNothingKept(OFFLINE_COPY.nothingKept.myGame), { exact: false }, WAIT)).toBeInTheDocument();
    expect(screen.queryByText(/couldn't be reached/i)).toBeNull();
  });
});

describe("X8-2 — Bookings on a cold start with nothing kept", () => {
  it("says offline once — no red schedule, no red games lists", async () => {
    lieFiPhone();
    renderPage(<BookingsPage />, { initialEntries: ["/bookings"] });
    await waitFor(() => expect(document.querySelector(NOTHING_KEPT)).not.toBeNull(), WAIT);
    expect(screen.queryByText(/couldn't be reached/i)).toBeNull();
    expect(screen.queryByText(/Couldn't load your (upcoming|recent) games/i)).toBeNull();
    expect(document.querySelectorAll(NOTHING_KEPT)).toHaveLength(1);
    expect(document.querySelector("[data-offline-retry] button")).not.toBeNull();
  });

  it("phone offline too: the same", async () => {
    lieFiPhone();
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    renderPage(<BookingsPage />, { initialEntries: ["/bookings"] });
    await waitFor(() => expect(document.querySelector(NOTHING_KEPT)).not.toBeNull(), WAIT);
    expect(screen.queryByText(/couldn't be reached/i)).toBeNull();
  });
});

describe("a club that answers with a failure is not offline", () => {
  it("Invites keeps its red failure and retry on a 503", async () => {
    signIn({ isAdmin: false });
    localStorage.setItem(LAST_IDENTITY_KEY, ANA);
    setDataOwner(ANA);
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/whoami")) return Promise.resolve(new Response(JSON.stringify({ tenant_slug: "crusaders", tenant_id: "t", user_id: ANA, is_authenticated: true, is_admin: false }), { status: 200, headers: { "content-type": "application/json" } }));
      return Promise.resolve(new Response(JSON.stringify({ error: "unavailable" }), { status: 503, headers: { "content-type": "application/json" } }));
    }));
    renderPage(<InvitesPage />, { initialEntries: ["/bookings/invites"] });
    await screen.findByRole("button", { name: /try again|retry/i }, WAIT);
    expect(document.querySelector(NOTHING_KEPT)).toBeNull();
  });
});
