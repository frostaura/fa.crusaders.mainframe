import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Layout from "./shell/AppShell";
import { AuthProvider } from "../lib/auth";
import { BalanceProvider } from "../lib/balance";
import { ProfileProvider } from "../lib/profile";
import { ToastProvider } from "./Toast";
import { memberFixture, signIn, signOut, stubFetch } from "../test/harness";

/**
 * The P2 app shell's navigation (Target IA → Shell; R15, R16).
 *
 * <p>
 * One `<nav aria-label="Main">`: My Code · Bookings · Wallet, and Admin for admins. It is the
 * desktop top bar's tabs from `md` and the phone's fixed bottom tab bar below it — the same DOM,
 * restyled — so what is held here is the list, its order, which one is current, the Admin tab's
 * attention badge, and the bottom bar's decisions (fixed, safe-area aware, publishing its height).
 * jsdom applies no Tailwind and lays nothing out, so geometry is measured by
 * `e2e/app-chrome.spec.ts` and `e2e/narrow-viewport.spec.ts`.
 * </p>
 *
 * <p>
 * Retired here (R16): the two copies of the section tabs and their paired assertions, the
 * Members / Monitoring / Transactions / Reports tabs, and the gear menu. Everything the gear held
 * and every admin tab is one Admin tab now, whose single badge counts pending applications +
 * doors needing attention + open faults (`lib/adminAttention.ts`). The accessible-sentence rule
 * the old badges carried is kept: the digits are decoration, the sentence is the name.
 * </p>
 */

const PROFILE = {
  user_id: "u1", email: "admin@club.test", is_admin: true, tenant_slug: "crusaders",
  full_name: "Club Desk", membership_number: "M-1", photo_url: null, status: "active",
};

const WALLET = { balance_minutes: 120, entries: [], total_entries: 0, offset: 0, limit: 100 };

beforeEach(() => {
  vi.stubGlobal("EventSource", class { close() {} addEventListener() {} } as unknown as typeof EventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
  signOut();
  document.documentElement.style.removeProperty("--app-bottom-bar-height");
});

function renderShell(route: string) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <AuthProvider>
        <ProfileProvider>
          <BalanceProvider>
            <ToastProvider>
              <Routes>
                <Route element={<Layout />}>
                  <Route path="*" element={<h1>the page</h1>} />
                </Route>
              </Routes>
            </ToastProvider>
          </BalanceProvider>
        </ProfileProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

function adminClub(extra: Parameters<typeof stubFetch>[0] = []) {
  const whoami = { ...signIn({ isAdmin: true }), user_id: "u1" };
  const base: Parameters<typeof stubFetch>[0] = [
    { path: "/api/v1/whoami", body: whoami },
    { path: "/api/v1/me/profile", body: PROFILE },
    { path: "/api/v1/wallet", body: WALLET },
    { method: "POST", path: "/api/v1/wallet/stream-ticket", body: { ticket: "t", expires_in_seconds: 60 } },
    { path: "/api/v1/admin/members", body: [] },
    { path: "/api/v1/admin/monitoring/summary", body: { open: {} } },
  ];
  // An extra route REPLACES the base one with its path: the stub breaks a longest-prefix tie by
  // declaration order, so an appended duplicate would never be reached — a silent pass.
  return stubFetch([...base.filter((r) => !extra.some((x) => x.path === r.path)), ...extra]);
}

function memberClub() {
  const whoami = { ...signIn({ isAdmin: false }), user_id: "u2", is_admin: false };
  return stubFetch([
    { path: "/api/v1/whoami", body: whoami },
    { path: "/api/v1/me/profile", body: { ...PROFILE, is_admin: false } },
    { path: "/api/v1/wallet", body: WALLET },
    { method: "POST", path: "/api/v1/wallet/stream-ticket", body: { ticket: "t", expires_in_seconds: 60 } },
  ]);
}

const mainNav = () => screen.getByRole("navigation", { name: "Main" });

describe("the primary navigation", () => {
  it("offers a member My Code, Bookings and Wallet, in that order (R15)", async () => {
    memberClub();
    renderShell("/bookings");

    const nav = await screen.findByRole("navigation", { name: "Main" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["My Code", "/my-code"],
      ["Bookings", "/bookings"],
      ["Wallet", "/wallet"],
    ]);
  });

  it("adds exactly one Admin tab for an admin, last (R16)", async () => {
    adminClub();
    renderShell("/my-code");

    await waitFor(() => expect(within(mainNav()).getAllByRole("link")).toHaveLength(4));
    const admin = within(mainNav()).getAllByRole("link")[3];
    expect(admin).toHaveAttribute("href", "/admin");
    expect(admin).toHaveTextContent(/^Admin/);
    // One nav, not the inline + strip pair the old chrome drew.
    expect(screen.getAllByRole("navigation")).toHaveLength(1);
  });

  it("marks the current destination, and only it, for every page under it", async () => {
    adminClub();
    renderShell("/admin/monitoring/doors");

    await waitFor(() => expect(within(mainNav()).getAllByRole("link")).toHaveLength(4));
    const current = within(mainNav()).getAllByRole("link").filter((a) => a.getAttribute("aria-current") === "page");
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAttribute("href", "/admin");
  });

  it("marks Wallet current on the wallet's own sub-pages too", async () => {
    memberClub();
    renderShell("/wallet/activity");

    const wallet = await within(await screen.findByRole("navigation", { name: "Main" })).findByRole("link", { name: "Wallet" });
    expect(wallet).toHaveAttribute("aria-current", "page");
  });

  /**
   * R16 — the gear is gone. It was the only route to Settings, Webhooks and Sign out; the first
   * two are Admin destinations now and Sign out is in the account menu.
   */
  it("has no gear menu", async () => {
    adminClub();
    renderShell("/my-code");
    await screen.findByRole("button", { name: "Account menu" });
    expect(screen.queryByRole("button", { name: /Open menu/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /Admin settings/ })).toBeNull();
  });
});

describe("the Admin tab's attention badge", () => {
  it("counts waiting applications, and its name is the sentence rather than the digit", async () => {
    adminClub([{ path: "/api/v1/admin/members", body: [memberFixture({ status: "PendingApproval", email_verified: false })] }]);
    renderShell("/my-code");

    const badge = await screen.findByLabelText("1 membership application awaiting review");
    expect(badge).toHaveTextContent("1");
    // It is ON the Admin tab — one badge, not one per copy of the nav.
    expect(badge.closest("a")).toHaveAttribute("href", "/admin");
    expect(screen.getAllByLabelText(/awaiting review/)).toHaveLength(1);
  });

  it("adds the open faults to the same count and the same sentence", async () => {
    adminClub([
      { path: "/api/v1/admin/members", body: [memberFixture({ status: "PendingApproval", email_verified: false })] },
      { path: "/api/v1/admin/monitoring/summary", body: { open: { warning: 2, info: 5 } } },
    ]);
    renderShell("/my-code");

    // Info (a board's boot record) is not counted — a badge that fires on every restart is one
    // an admin learns to ignore.
    const badge = await screen.findByLabelText("1 membership application awaiting review and 2 faults need attention");
    expect(badge).toHaveTextContent("3");
  });

  it("renders nothing at zero", async () => {
    const stub = adminClub();
    renderShell("/my-code");
    await waitFor(() => expect(stub.calls.some((c) => c.path.startsWith("/api/v1/admin/members"))).toBe(true));
    expect(document.querySelector("[data-attention-badge]")).toBeNull();
  });

  it("asks for nothing, and shows nothing, for a member", async () => {
    const stub = memberClub();
    renderShell("/my-code");

    await screen.findByRole("navigation", { name: "Main" });
    await waitFor(() => expect(stub.calls.some((c) => c.path.startsWith("/api/v1/me/profile"))).toBe(true));
    expect(stub.calls.some((c) => c.path.startsWith("/api/v1/admin/"))).toBe(false);
    expect(screen.queryByLabelText(/awaiting review|need attention/)).not.toBeInTheDocument();
  });
});

describe("the page scroller keeps focus clear of the sticky bars", () => {
  /**
   * X5-2 (review round 5, WCAG 2.4.11): a focused ledger row scrolled under a sticky TOP bar. The
   * scroller (`<main>`) is padded at the top by the stuck bar's published height (lane A's
   * `--context-bar-top-height`), as it already was at the foot by the tab bar's and the dock's.
   */
  it("pads <main>'s scroll at the top by the stuck top bar's height", async () => {
    memberClub();
    renderShell("/my-code");
    await screen.findByRole("navigation", { name: "Main" });
    const main = document.getElementById("main-content")!;
    expect(main.style.scrollPaddingTop).toBe("calc(var(--context-bar-top-height, 0px) + 0.5rem)");
    expect(main.style.scrollPaddingBottom).toContain("--app-bottom-bar-height");
  });
});

describe("the phone's bottom tab bar", () => {
  /**
   * The decision, as classes: fixed to the bottom where the top bar is narrower than 44rem, inline
   * in it from there (V5-3: the bar's own width in rem, so 768 px at normal text, and the bottom bar
   * wherever large text would not fit the row — the browser half is `e2e/app-chrome`).
   */
  it("is fixed to the bottom edge on a phone and inline where the bar has room", async () => {
    memberClub();
    renderShell("/my-code");
    const nav = await screen.findByRole("navigation", { name: "Main" });

    for (const token of ["fixed", "bottom-0", "inset-x-0", "@[44rem]/appbar:static"]) expect(nav.className).toContain(token);
    // The home indicator's inset is a spacer inside the bar (`height: env(safe-area-inset-bottom)`
    // — jsdom drops `env()` as invalid, so the value itself is measured in the browser), so the
    // published height already includes it.
    const spacer = nav.lastElementChild as HTMLElement;
    expect(spacer).toHaveAttribute("aria-hidden", "true");
    expect(spacer.className).toContain("@[44rem]/appbar:hidden");
    // Every tab is a 64px target on the phone and 44px in the top bar — never a 36px one.
    for (const link of within(nav).getAllByRole("link")) {
      expect(link.className).toContain("min-h-tabbar");
      expect(link.className).toContain("@[44rem]/appbar:min-h-touch");
    }
  });

  it("keeps the page's last line above it", async () => {
    memberClub();
    renderShell("/my-code");
    await screen.findByRole("navigation", { name: "Main" });
    expect(document.querySelector("main")!.getAttribute("style")).toContain("var(--app-bottom-bar-height");
  });

  /**
   * The toast strip and the multiselect ActionBar read `--app-bottom-bar-height`. It is the bar's
   * measured height while the bar is fixed, and 0 while it sits in the top bar — so a toast on a
   * desktop does not float 88px above nothing.
   */
  it("publishes its height while it is a bottom bar, and zero while it is not", async () => {
    memberClub();
    renderShell("/my-code");
    const nav = await screen.findByRole("navigation", { name: "Main" });
    const root = document.documentElement;

    expect(root.style.getPropertyValue("--app-bottom-bar-height")).toBe("0px");

    nav.style.position = "fixed";
    nav.getBoundingClientRect = () => ({ height: 88.4 } as DOMRect);
    act(() => { window.dispatchEvent(new Event("resize")); });
    expect(root.style.getPropertyValue("--app-bottom-bar-height")).toBe("88px");

    nav.style.position = "static";
    act(() => { window.dispatchEvent(new Event("resize")); });
    expect(root.style.getPropertyValue("--app-bottom-bar-height")).toBe("0px");
  });
});

describe("a page that fails to render", () => {
  /**
   * Without a boundary one bad row on one screen unmounted the whole tree: a blank document with
   * no tab bar and no way anywhere. Now the page takes only itself down, the chrome stays, and
   * leaving the page clears it.
   */
  it("takes only itself down, and leaving it clears the failure", async () => {
    memberClub();
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    function Broken(): never { throw new Error("bad row"); }
    render(
      <MemoryRouter initialEntries={["/wallet"]}>
        <AuthProvider>
          <ProfileProvider>
            <BalanceProvider>
              <ToastProvider>
                <Routes>
                  <Route element={<Layout />}>
                    <Route path="/wallet" element={<Broken />} />
                    <Route path="/bookings" element={<h1>Bookings page</h1>} />
                  </Route>
                </Routes>
              </ToastProvider>
            </BalanceProvider>
          </ProfileProvider>
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "This page hit a problem" })).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Main" });
    act(() => { within(nav).getByRole("link", { name: "Bookings" }).click(); });
    expect(await screen.findByRole("heading", { name: "Bookings page" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "This page hit a problem" })).toBeNull();
    quiet.mockRestore();
  });
});

