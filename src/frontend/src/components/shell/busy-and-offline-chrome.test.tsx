import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import { resetRefreshBackoff, tokenStore } from "@/lib/api";
import { OFFLINE_COPY } from "@/lib/offline/offlineCopy";
import { setDataOwner, wipeMemberData } from "@/lib/offline/queryCache";
import { CONNECTION_COPY } from "@/lib/shellCopy";

/**
 * R8 — the bar while the club is not confirming the session.
 *
 * <ul>
 *   <li><b>X8-2</b>: offline, cold, with nothing of the wallet kept on this phone, the minutes chip
 *   said "Wallet balance, loading" for ever — a skeleton waiting on a read nobody would make. It
 *   says it has no figure, and that the phone is offline.</li>
 *   <li><b>Busy (429) on a phone that never confirmed who it is</b>: the bar kept only the crest —
 *   no tabs, no bell, no account menu (no Sign out) — under a screen saying "You're still signed
 *   in". It keeps them; nothing in it reads as anybody, and no Admin tab is offered unconfirmed.</li>
 * </ul>
 */

const ID = "44444444-4444-4444-4444-444444444444";

function json(status: number, body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

async function header(): Promise<HTMLElement> {
  return waitFor(() => {
    const found = document.querySelector<HTMLElement>("[data-app-header]");
    if (!found) throw new Error("no app header yet");
    return found;
  });
}

beforeEach(() => {
  localStorage.clear();
  resetRefreshBackoff();
  tokenStore.set("member.jwt.value");
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

describe("the minutes chip offline with nothing kept (X8-2)", () => {
  // R15 X15-3 — "You're offline" only when the phone says so; otherwise "Can't reach the club".
  it.each([
    ["the phone offline", false, OFFLINE_COPY.staleTitle, OFFLINE_COPY.unreachableTitle],
    ["the phone online, the club unreachable", true, OFFLINE_COPY.unreachableTitle, OFFLINE_COPY.staleTitle],
  ])("%s: says it has no figure, and why — never 'loading' for ever", async (_n, onLine, said, notSaid) => {
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(onLine);
    localStorage.setItem("crusaders.mainframe.last-identity", ID);
    setDataOwner(ID);
    window.history.pushState({}, "", "/my-code");
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
    render(<App />);

    const bar = await header();
    const chip = await within(bar).findByRole("link", { name: new RegExp(said) }, { timeout: 8_000 });
    expect(chip.getAttribute("aria-label")).not.toContain(notSaid);
    expect(chip.getAttribute("aria-label")).not.toMatch(/loading/i);
    expect(chip.querySelector("[data-chip-skeleton]")).toBeNull();
    expect(chip).not.toHaveTextContent("0 min");
    vi.restoreAllMocks();
  }, 15_000);
});

describe("the busy screen on a phone that never confirmed its member", () => {
  it("keeps the tabs, the bell and the account menu; no Admin tab; the chip has no figure and is not loading", async () => {
    window.history.pushState({}, "", "/bookings");
    vi.stubGlobal("fetch", vi.fn(() => json(429, { error: "rate_limited", retry_after_seconds: 12 })));
    render(<App />);

    expect(await screen.findByRole("heading", { name: CONNECTION_COPY.busyTitle }, { timeout: 8_000 })).toBeInTheDocument();
    const bar = await header();
    expect(within(bar).getAllByRole("link", { name: /^Bookings/ }).length).toBeGreaterThan(0);
    expect(within(bar).getByRole("button", { name: "Account menu" })).toBeInTheDocument();
    expect(within(bar).queryAllByRole("link", { name: /^Admin/ })).toHaveLength(0);
    const chip = await within(bar).findByRole("link", { name: /^Wallet balance/ });
    expect(chip.getAttribute("aria-label")).not.toMatch(/loading/i);
    expect(chip).not.toHaveTextContent("0 min");
  }, 15_000);
});
