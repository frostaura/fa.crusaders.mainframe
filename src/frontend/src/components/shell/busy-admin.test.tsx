import { StrictMode } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import { resetRefreshBackoff, tokenStore } from "@/lib/api";
import { CONNECTION_COPY } from "@/lib/shellCopy";

/**
 * R7 (L6 note, still open in R7) — the "club is busy" screen (a 429 on the session check) kept the
 * member's tabs, bell, chip and account menu, but an ADMIN lost the Admin tab: the session was not
 * confirmed again, so the shell did not know it was an admin. The shell remembers the admin it
 * last confirmed on this device, for that member only, and keeps the tab while the club is busy.
 */

const ADMIN = "44444444-4444-4444-4444-444444444444";
const WHOAMI = { tenant_slug: "crusaders", tenant_id: "t", user_id: ADMIN, is_authenticated: true, is_admin: true };

function json(status: number, body: unknown) {
  return Promise.resolve({
    ok: status < 400, status, headers: new Headers({ "content-type": "application/json" }),
    text: () => Promise.resolve(JSON.stringify(body)), json: () => Promise.resolve(body),
  } as unknown as Response);
}

describe("the busy screen for an admin", () => {
  beforeEach(() => {
    localStorage.clear();
    resetRefreshBackoff();
    tokenStore.set("admin.jwt.value");
    window.history.pushState({}, "", "/how-it-works");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    tokenStore.clear();
    resetRefreshBackoff();
    localStorage.clear();
    window.history.pushState({}, "", "/");
  });

  it("keeps the Admin tab, the bell and the account menu while the club answers 429", async () => {
    // A session the club confirmed as an admin's, on this device.
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => (String(input).includes("/whoami") ? json(200, WHOAMI) : json(200, {}))));
    render(<StrictMode><App /></StrictMode>);
    expect(await screen.findAllByRole("link", { name: /^Admin/ }, { timeout: 4_000 })).not.toHaveLength(0);
    cleanup();

    // The next visit, to a page that needs the club: the club is busy.
    window.history.pushState({}, "", "/admin");
    vi.stubGlobal("fetch", vi.fn(() => json(429, { error: "rate_limited", retry_after_seconds: 12 })));
    render(<StrictMode><App /></StrictMode>);
    expect(await screen.findByRole("heading", { name: CONNECTION_COPY.busyTitle }, { timeout: 4_000 })).toBeInTheDocument();
    const header = document.querySelector("[data-app-header]") as HTMLElement;
    expect(within(header).getAllByRole("link", { name: /^Admin/ }).length).toBeGreaterThan(0);
    expect(document.querySelector("[data-app-header-actions]")!.children.length).toBeGreaterThan(0);
  });

  it("a member's busy screen never shows the Admin tab", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => (String(input).includes("/whoami") ? json(200, { ...WHOAMI, is_admin: false }) : json(200, {}))));
    render(<StrictMode><App /></StrictMode>);
    expect(await screen.findAllByRole("link", { name: /^Wallet/ }, { timeout: 4_000 })).not.toHaveLength(0);
    cleanup();
    window.history.pushState({}, "", "/admin");
    vi.stubGlobal("fetch", vi.fn(() => json(429, { error: "rate_limited", retry_after_seconds: 12 })));
    render(<StrictMode><App /></StrictMode>);
    expect(await screen.findByRole("heading", { name: CONNECTION_COPY.busyTitle }, { timeout: 4_000 })).toBeInTheDocument();
    expect(screen.queryAllByRole("link", { name: /^Admin/ })).toHaveLength(0);
  });
});
