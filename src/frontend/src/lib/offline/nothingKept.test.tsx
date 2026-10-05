import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import { renderPage, signIn, signOut } from "@/test/harness";
import InboxPage from "@/pages/Inbox";
import WalletActivityPage from "@/pages/WalletActivity";
import BuyMinutesPage from "@/pages/TopUp";
import WalletPage from "@/pages/Wallet";
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

  it("R8 X8-2 — Wallet says it is offline and what is missing, never red, and loads once the signal is back", async () => {
    offlinePhone();
    renderPage(<WalletPage />, { initialEntries: ["/wallet"] });
    expect(screen.getByRole("heading", { level: 1, name: "Wallet" })).toBeInTheDocument();
    expect(await screen.findByText(OFFLINE_COPY.nothingKept.wallet, { exact: false }, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.queryByText(/couldn't be reached|couldn't load/i)).toBeNull();

    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      const body = url.includes("/whoami") ? { is_authenticated: true, is_admin: false, user_id: ANA, tenant_id: "t", tenant_slug: "crusaders" }
        : { balance_minutes: 90, entries: [], total_entries: 0, offset: 0, limit: 100 };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));
    await act(async () => { window.dispatchEvent(new Event("online")); });
    expect(await screen.findByText("No movements yet", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.queryByText(OFFLINE_COPY.nothingKept.wallet, { exact: false })).toBeNull();
  });

  // R15 X15-3 reverses R8's wording (not its notice): Wi-Fi without internet still gets the
  // nothing-kept notice, never red — but it is "Can't reach the club", not "You're offline".
  it("R8 X8-2 / R15 X15-3 — Wi-Fi without internet (onLine true, the read fails to connect): the notice, as Can't reach the club", async () => {
    offlinePhone();
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    renderPage(<WalletPage />, { initialEntries: ["/wallet"] });
    expect(await screen.findByText(OFFLINE_COPY.unreachableNothingKept(OFFLINE_COPY.nothingKept.wallet), { exact: false }, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByText(OFFLINE_COPY.unreachableTitle)).toBeInTheDocument();
    expect(screen.queryByText(OFFLINE_COPY.staleTitle)).toBeNull();
    expect(screen.queryByText(/couldn't be reached|couldn't load/i)).toBeNull();
  });

  it("R8 X7-3 rest / R15 X15-3 — Inbox and Wallet activity keep the notice on a failed connection when onLine says true", async () => {
    offlinePhone();
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    const inbox = renderPage(<InboxPage />, { initialEntries: ["/inbox"] });
    expect(await screen.findByText(OFFLINE_COPY.unreachableNothingKept(OFFLINE_COPY.nothingKept.inbox), { exact: false }, { timeout: 3000 })).toBeInTheDocument();
    inbox.unmount();
    renderPage(<WalletActivityPage />, { initialEntries: ["/wallet/activity"] });
    expect(await screen.findByText(OFFLINE_COPY.unreachableNothingKept(OFFLINE_COPY.nothingKept.activity), { exact: false }, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.queryByText(/couldn't be reached/i)).toBeNull();
  });
});
