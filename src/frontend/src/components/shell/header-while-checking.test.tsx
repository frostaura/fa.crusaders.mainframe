import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import { resetRefreshBackoff, tokenStore } from "@/lib/api";
import { INBOX_TITLE } from "@/lib/bellCopy";
import { memberReads } from "@/lib/offline/memberReads";
import { primeQuery, setDataOwner, wipeMemberData } from "@/lib/offline/queryCache";

/**
 * P5-6 (review round 5) — on one bar of signal the session check (`whoami`) can be out for many
 * seconds. The header dropped the bell, the credits chip and the account menu for all of it, so a
 * member could not reach Sign out — while My Code, Bookings and the tab bar were already drawn for
 * the member this phone had confirmed. The header now draws them for that member too, the chip
 * from the wallet figure the phone kept, until the club answers.
 */

const ID = "44444444-4444-4444-4444-444444444444";

/** The session check never answers; anything else the app asks is refused as unavailable. */
function whoamiStalled() {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    if (String(input).startsWith("/api/v1/whoami")) return new Promise<Response>(() => {});
    return Promise.resolve(new Response(JSON.stringify({ error: "unavailable" }), { status: 503 }));
  }));
}

beforeEach(() => {
  localStorage.clear();
  resetRefreshBackoff();
  tokenStore.set("member.jwt.value");
  localStorage.setItem("crusaders.mainframe.last-identity", ID);
  setDataOwner(ID);
  window.history.pushState({}, "", "/my-code");
});

afterEach(async () => {
  await wipeMemberData();
  setDataOwner(null);
  vi.unstubAllGlobals();
  tokenStore.clear();
  localStorage.clear();
  resetRefreshBackoff();
  window.history.pushState({}, "", "/");
});

describe("the header while the session check is out", () => {
  it("keeps the bell, the kept wallet figure and the account menu with Sign out", async () => {
    primeQuery(ID, memberReads.wallet.key, { balance_minutes: 120, spendable_minutes: 120, held_minutes: 0, entries: [], total_entries: 0, offset: 0, limit: 100 });
    primeQuery(ID, memberReads.profile.key, { full_name: "Olga Petrova", email: "olga@example.test", status: "active", photo_url: null });
    whoamiStalled();
    render(<App />);

    const header = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-app-header]");
      if (!found) throw new Error("no app header yet");
      return found;
    });
    expect(await within(header).findByRole("link", { name: INBOX_TITLE })).toBeInTheDocument();
    const chip = await within(header).findByRole("link", { name: /120\.00 credits/ });
    expect(chip).toHaveTextContent("120.00");
    expect(chip.getAttribute("title") ?? "").toMatch(/last/i);

    const menu = within(header).getByRole("button", { name: "Account menu" });
    await act(async () => {
      fireEvent.pointerDown(menu, { button: 0, pointerType: "mouse" });
    });
    expect(await screen.findByRole("menuitem", { name: /Sign out/ })).toBeInTheDocument();
  }, 15_000);

  it("draws no figure it does not have: a placeholder, never a zero", async () => {
    whoamiStalled();
    render(<App />);

    const header = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-app-header]");
      if (!found) throw new Error("no app header yet");
      return found;
    });
    const chip = await within(header).findByRole("link", { name: /Wallet balance/ });
    expect(chip).not.toHaveTextContent("0.00");
    expect(within(header).getByRole("button", { name: "Account menu" })).toBeInTheDocument();
  }, 15_000);
});
