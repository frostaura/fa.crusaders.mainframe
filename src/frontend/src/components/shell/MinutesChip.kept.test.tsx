import { render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import { resetRefreshBackoff, tokenStore } from "@/lib/api";
import { forgetClubZone, rememberClubZone } from "@/lib/clubZone";
import { memberReads } from "@/lib/offline/memberReads";
import { primeQuery, setDataOwner, wipeMemberData } from "@/lib/offline/queryCache";

/**
 * R16 X16-4 — a kept figure (the club unreachable, the chip drawn from this phone's last wallet
 * read) said "Last known at …, not yet confirmed" only in the `title`; the accessible name read
 * like the current balance. And the time was the browser's 12-hour clock in the browser's zone.
 * The name now carries the kept suffix, and the time is the club's 24-hour clock in the club's zone.
 */

const ID = "44444444-4444-4444-4444-444444444444";
// 16:04 UTC is 18:04 in Johannesburg — the club's — and 05:04 the next day in Auckland.
const READ_AT = Date.UTC(2026, 9, 5, 16, 4);

beforeEach(() => {
  localStorage.clear();
  resetRefreshBackoff();
  tokenStore.set("member.jwt.value");
  localStorage.setItem("crusaders.mainframe.last-identity", ID);
  setDataOwner(ID);
  window.history.pushState({}, "", "/my-code");
});

afterEach(async () => {
  vi.useRealTimers();
  await wipeMemberData();
  setDataOwner(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  tokenStore.clear();
  localStorage.clear();
  forgetClubZone();
  resetRefreshBackoff();
  window.history.pushState({}, "", "/");
});

async function keptChip(): Promise<HTMLElement> {
  vi.useFakeTimers({ toFake: ["Date"], now: READ_AT });
  primeQuery(ID, memberReads.wallet.key, { balance_minutes: 120, spendable_minutes: 120, held_minutes: 0, entries: [], total_entries: 0, offset: 0, limit: 100 });
  vi.setSystemTime(READ_AT + 60_000);
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
  render(<App />);
  const header = await vi.waitFor(() => {
    const found = document.querySelector<HTMLElement>("[data-app-header]");
    if (!found) throw new Error("no app header yet");
    return found;
  }, { timeout: 8_000 });
  return within(header).findByRole("link", { name: /2 hours/ }, { timeout: 8_000 });
}

describe("the chip's kept figure says it is one, in the club's clock (R16 X16-4)", () => {
  it("the accessible name carries 'last known at 18:04, not yet confirmed' in the club's zone", async () => {
    rememberClubZone("Africa/Johannesburg");
    const chip = await keptChip();
    const name = chip.getAttribute("aria-label") ?? "";
    expect(name).toMatch(/Last known at 18:04, not yet confirmed by the club/);
    expect(chip.getAttribute("title") ?? "").toContain("Last known at 18:04");
    expect(name).not.toMatch(/\b(AM|PM|am|pm)\b/);
  }, 15_000);

  it("another club zone, another clock face — never the browser's", async () => {
    rememberClubZone("Pacific/Auckland");
    const chip = await keptChip();
    expect(chip.getAttribute("aria-label") ?? "").toMatch(/Last known .*05:04, not yet confirmed/);
  }, 15_000);
});
