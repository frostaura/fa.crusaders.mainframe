import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderPage, signIn, signOut } from "@/test/harness";
import BookingsPage from "@/pages/Schedule";
import WalletPage from "@/pages/Wallet";
import InboxPage from "@/pages/Inbox";
import { OFFLINE_COPY } from "@/lib/offline/offlineCopy";
import { setDataOwner } from "@/lib/offline/queryCache";

/**
 * R9 X9-6 — a stalled connection (the request is accepted and never answered) with nothing kept on
 * this phone: Bookings, Wallet and Inbox showed bare skeletons for the whole 20 s request budget
 * before the offline notice. Like the session splash, after a few seconds they say they are still
 * trying and that the connection is slow; a fast answer never shows it.
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

/** A connection that takes every request and answers none. */
function stalledPhone() {
  signIn({ isAdmin: false });
  localStorage.setItem(LAST_IDENTITY_KEY, ANA);
  setDataOwner(ANA);
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
}

const WAIT = { timeout: 7000 };

describe("X9-6 — a stalled read says it is still trying", () => {
  for (const [name, ui, path] of [
    ["Bookings", <BookingsPage key="b" />, "/bookings"],
    ["Wallet", <WalletPage key="w" />, "/wallet"],
    ["Inbox", <InboxPage key="i" />, "/inbox"],
  ] as const) {
    it(name, async () => {
      stalledPhone();
      renderPage(ui, { initialEntries: [path] });
      expect(screen.queryByText(OFFLINE_COPY.stillTrying)).toBeNull();
      const note = await screen.findByText(OFFLINE_COPY.stillTrying, {}, WAIT);
      expect(note.closest("[role=status]")).not.toBeNull();
    });
  }
});
