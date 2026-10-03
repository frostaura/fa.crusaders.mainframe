import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { renderPage, signIn, signOut } from "@/test/harness";
import InvitesPage from "@/pages/Invites";
import BookingDetailPage from "@/pages/BookingDetail";
import WalletActivityPage from "@/pages/WalletActivity";
import BuyMinutesPage from "@/pages/TopUp";
import ProfilePage from "@/pages/Profile";
import { ProfileProvider } from "@/lib/profile";
import { OFFLINE_COPY } from "@/lib/offline/offlineCopy";
import { setDataOwner } from "@/lib/offline/queryCache";

/**
 * R10 X10-1 — the R9 "Still trying" reached only Bookings, Wallet and Inbox. On /bookings/invites,
 * /wallet/activity, /wallet/buy, /bookings/:id and /profile a stalled first read (accepted, never
 * answered) pulsed a bare skeleton for the whole 20 s budget; and /profile said a red "Couldn't
 * load your profile — the club's system couldn't be reached" 0.6 s into a failed connection,
 * where every other page says it is offline and what is missing.
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
vi.setConfig({ testTimeout: 15_000 });

function phone(fetcher: () => Promise<unknown>) {
  signIn({ isAdmin: false });
  localStorage.setItem(LAST_IDENTITY_KEY, ANA);
  setDataOwner(ANA);
  vi.stubGlobal("fetch", vi.fn(fetcher));
}
/** A connection that takes every request and answers none. */
const stalled = () => phone(() => new Promise(() => {}));
/** Wi-Fi with no internet: every request fails to connect, and `onLine` still says true. */
const unreachable = () => phone(() => Promise.reject(new TypeError("Failed to fetch")));

const WAIT = { timeout: 7000 };

describe("R10 X10-1 — a stalled first read says it is still trying, on every member page", () => {
  for (const [name, ui, path] of [
    ["Invites", <InvitesPage key="i" />, "/bookings/invites"],
    ["Wallet activity", <WalletActivityPage key="a" />, "/wallet/activity"],
    ["Buy minutes", <BuyMinutesPage key="b" />, "/wallet/buy"],
    ["a booking's page", <Routes key="d"><Route path="/bookings/:bookingId" element={<BookingDetailPage />} /></Routes>, "/bookings/bk-1"],
    ["Profile", <ProfileProvider key="p"><ProfilePage /></ProfileProvider>, "/profile"],
  ] as const) {
    it(name, async () => {
      stalled();
      renderPage(ui, { initialEntries: [path] });
      expect(screen.queryByText(OFFLINE_COPY.stillTrying)).toBeNull();
      const note = await screen.findByText(OFFLINE_COPY.stillTrying, {}, WAIT);
      expect(note.closest("[role=status]")).not.toBeNull();
      // Outside the skeleton, whose aria-busy would mute it.
      expect(note.closest("[aria-busy=true]")).toBeNull();
    });
  }
});

describe("R10 X10-1 — Profile offline with nothing kept says offline, never red", () => {
  it("says what is missing and keeps a retry", async () => {
    unreachable();
    renderPage(<ProfileProvider><ProfilePage /></ProfileProvider>, { initialEntries: ["/profile"] });
    expect(await screen.findByText(OFFLINE_COPY.nothingKept.profile, { exact: false }, WAIT)).toBeInTheDocument();
    expect(screen.queryByText(/couldn't be reached/i)).toBeNull();
    expect(screen.queryByText(/Couldn't load your profile/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});
