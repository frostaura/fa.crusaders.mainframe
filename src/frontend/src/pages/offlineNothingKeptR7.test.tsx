import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { renderPage, signIn, signOut } from "@/test/harness";
import InvitesPage from "@/pages/Invites";
import BookingDetailPage from "@/pages/BookingDetail";
import { MyGameSection } from "@/components/play/MyGameSection";
import { OFFLINE_COPY } from "@/lib/offline/offlineCopy";
import { setDataOwner } from "@/lib/offline/queryCache";

/**
 * R7 X7-3 — a cold start with no signal, on a page never opened on this phone: Invites, a booking's
 * page and Profile's "My game" said "the club's system couldn't be reached" in red. Offline is said
 * as offline (`OfflineNothingKept`), as Inbox and Wallet activity already do (R6 X6-4).
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

function offlinePhone() {
  signIn({ isAdmin: false });
  localStorage.setItem(LAST_IDENTITY_KEY, ANA);
  setDataOwner(ANA);
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
}

const WAIT = { timeout: 3000 };

describe("X7-3 — offline with nothing kept says offline, not 'couldn't be reached'", () => {
  it("Invites", async () => {
    offlinePhone();
    renderPage(<InvitesPage />, { initialEntries: ["/bookings/invites"] });
    expect(await screen.findByText(OFFLINE_COPY.nothingKept.invites, { exact: false }, WAIT)).toBeInTheDocument();
    expect(screen.queryByText(/couldn't be reached/i)).toBeNull();
  });

  it("a booking's page", async () => {
    offlinePhone();
    renderPage(<Routes><Route path="/bookings/:bookingId" element={<BookingDetailPage />} /></Routes>, { initialEntries: ["/bookings/bk-1"] });
    expect(await screen.findByText(OFFLINE_COPY.nothingKept.booking, { exact: false }, WAIT)).toBeInTheDocument();
    expect(screen.queryByText(/couldn't be reached/i)).toBeNull();
  });

  it("Profile's My game", async () => {
    offlinePhone();
    renderPage(<MyGameSection />, { initialEntries: ["/profile"] });
    expect(await screen.findByText(OFFLINE_COPY.nothingKept.myGame, { exact: false }, WAIT)).toBeInTheDocument();
    expect(screen.queryByText(/couldn't be reached/i)).toBeNull();
  });
});
