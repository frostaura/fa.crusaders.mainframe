import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import { renderPage, signIn, signOut } from "@/test/harness";
import InboxPage from "@/pages/Inbox";
import WalletActivityPage from "@/pages/WalletActivity";
import BuyMinutesPage from "@/pages/TopUp";
import { BUY_COPY } from "@/lib/topUpShelf";
import { minutesShelf } from "@/test/minutesFixtures";
import { OFFLINE_COPY } from "./offlineCopy";
import { setDataOwner } from "./queryCache";

/**
 * R6 X6-4 — offline, with nothing of this page kept on the phone (never opened here with signal),
 * /inbox and /wallet/activity said "the club's system couldn't be reached. Check your connection"
 * in red, and /wallet/buy lost its heading and never said buying needs a connection. Offline is
 * said as offline: what is missing, why, and that it loads by itself once the signal is back.
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

describe("offline with nothing kept (R6 X6-4)", () => {
  it("Inbox says it is offline and what is missing — never 'couldn't be reached'", async () => {
    offlinePhone();
    renderPage(<InboxPage />, { initialEntries: ["/inbox"] });
    expect(await screen.findByText(OFFLINE_COPY.nothingKept.inbox, { exact: false }, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByText(OFFLINE_COPY.staleTitle)).toBeInTheDocument();
    expect(screen.queryByText(/couldn't be reached/i)).toBeNull();
  });

  it("Wallet activity says the same for a period it has never drawn", async () => {
    offlinePhone();
    renderPage(<WalletActivityPage />, { initialEntries: ["/wallet/activity"] });
    expect(await screen.findByText(OFFLINE_COPY.nothingKept.activity, { exact: false }, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.queryByText(/couldn't be reached/i)).toBeNull();
  });

  it("Buy minutes keeps its heading, says buying needs a connection, and loads once the signal is back", async () => {
    offlinePhone();
    renderPage(<BuyMinutesPage />, { initialEntries: ["/wallet/buy"] });
    expect(screen.getByRole("heading", { level: 1, name: BUY_COPY.title })).toBeInTheDocument();
    expect(await screen.findByText(OFFLINE_COPY.buyNeedsConnection, { exact: false }, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.queryByText(/couldn't be reached/i)).toBeNull();

    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      const body = url.includes("/minutes/packages") ? minutesShelf()
        : url.includes("/whoami") ? { is_authenticated: true, is_admin: false, user_id: ANA, tenant_id: "t", tenant_slug: "crusaders" }
        : { balance_minutes: 0, entries: [], total_entries: 0, offset: 0, limit: 1 };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));
    await act(async () => { window.dispatchEvent(new Event("online")); });
    expect(await screen.findByRole("radio", { name: "5 hours" }, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.queryByText(OFFLINE_COPY.buyNeedsConnection, { exact: false })).toBeNull();
  });
});
