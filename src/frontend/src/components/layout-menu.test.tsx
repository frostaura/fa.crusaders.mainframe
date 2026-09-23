import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import Layout from "./Layout";
import { ProfileProvider } from "../lib/profile";
import { tokenStore } from "../lib/api";
import { THEME_STORAGE_KEY, ThemeProvider } from "../lib/theme";
import { renderPage, signIn, signOut, stubFetch } from "../test/harness";

/**
 * The account menu, behind the avatar (P2, Target IA → Shell; R16, D7).
 *
 * <p>
 * <b>Retired with the gear (R16):</b> the settings menu's items — Admin settings and Webhooks —
 * and the tests that pinned them. Both are Admin destinations now, reached from the Admin tab,
 * and this menu holds only the person's own things. What those tests held is kept, because it is
 * the WAI-ARIA menu contract and it applies to this menu just as much (B15): focus moves in on
 * open, Escape closes and puts focus back on the button, arrow keys rove and wrap, Tab out
 * closes, navigations are real links (so they open in a new tab) and Sign out is a button (it is
 * not a destination). Radix implements it; these tests make sure it stays wired.
 * </p>
 *
 * <p>
 * `fireEvent`, not `user-event` — its keyboard path never settles under jsdom here and hangs to
 * the test timeout, which reads as a component that ignores input (memory/gotchas.md).
 * </p>
 */

afterEach(() => {
  signOut();
  localStorage.clear();
  document.documentElement.classList.remove("dark");
});

function renderChrome({ isAdmin = false }: { isAdmin?: boolean } = {}) {
  const whoami = signIn({ isAdmin });
  stubFetch([
    { path: "/api/v1/whoami", body: whoami },
    { path: "/api/v1/wallet", body: { balance_credits: 120, entries: [], count: 0 } },
    { path: "/api/v1/me/profile", body: { user_id: whoami.user_id, email: "naledi@sample.local", full_name: "Naledi Dube", photo_url: null, membership_number: "C-104" } },
    { path: "/api/v1/admin/members", body: [] },
    { path: "/api/v1/admin/monitoring/summary", body: { open: {} } },
    { path: "/api/v1/admin/doors", body: { day_started_at: new Date().toISOString(), timezone: "Africa/Johannesburg", shut_all_active: false, doors: [] } },
    { method: "POST", path: "/api/v1/auth/logout", body: {} },
  ]);
  return renderPage(
    <ThemeProvider>
      <ProfileProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/my-code" element={<h1>Your code</h1>} />
          </Route>
          <Route path="/login" element={<h1>Sign in</h1>} />
        </Routes>
      </ProfileProvider>
    </ThemeProvider>,
    { initialEntries: ["/my-code"] },
  );
}

async function openMenu() {
  const trigger = await screen.findByRole("button", { name: "Account menu" });
  fireEvent.keyDown(trigger, { key: "Enter" });
  const menu = await screen.findByRole("menu");
  return { trigger, menu };
}

describe("the account menu", () => {
  it("says who is signed in, and offers their own things only", async () => {
    renderChrome({ isAdmin: true });
    const { menu } = await openMenu();

    expect(menu).toHaveTextContent("Naledi Dube");
    expect(menu).toHaveTextContent("naledi@sample.local");
    const items = screen.getAllByRole("menuitem").map((item) => item.textContent);
    // P8 — the admin's own tour is one of their own things; "Replay welcome" is for an ACTIVE
    // member and this profile carries no membership status, so it is absent rather than greyed.
    expect(items).toEqual(["Profile", "How it works", "Replay admin tour", "Sign out"]);
    // R16 — even for an admin: the admin destinations are under the Admin tab, not in here.
    expect(menu).not.toHaveTextContent(/Admin settings|Webhooks/);
  });

  it("moves focus onto the first item when it opens", async () => {
    renderChrome();
    await openMenu();
    await waitFor(() => expect(screen.getAllByRole("menuitem")[0]).toHaveFocus());
  });

  it("closes on Escape and puts focus back on the button that opened it", async () => {
    renderChrome();
    const { trigger, menu } = await openMenu();

    fireEvent.keyDown(menu, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("walks its items with the arrow keys and wraps at both ends", async () => {
    renderChrome();
    await openMenu();
    const profile = screen.getByRole("menuitem", { name: "Profile" });
    await waitFor(() => expect(profile).toHaveFocus());

    // Radix moves roving focus on the next task, so each step is awaited.
    const press = async (key: string, lands: HTMLElement) => {
      fireEvent.keyDown(document.activeElement!, { key });
      await waitFor(() => expect(lands).toHaveFocus());
    };
    const signOut = screen.getByRole("menuitem", { name: "Sign out" });

    await press("ArrowDown", screen.getByRole("menuitem", { name: "How it works" }));
    await press("ArrowUp", profile);
    // Wrapping is the half a keyboard user notices: ArrowUp from the top reaches Sign out.
    await press("ArrowUp", signOut);
    await press("ArrowDown", profile);
    await press("End", signOut);
    await press("Home", profile);
  });

  /**
   * <b>Real links, not buttons</b>: a navigation that is a button cannot be middle-clicked,
   * cmd-clicked or copied (B15). Sign out stays a button — a link to /login would be openable in
   * a new tab without ending the session.
   */
  it("navigates with real links and signs out with a button", async () => {
    renderChrome();
    await openMenu();

    for (const [label, href] of [["Profile", "/profile"], ["How it works", "/how-it-works"]] as const) {
      const item = screen.getByRole("menuitem", { name: label });
      expect(item.tagName).toBe("A");
      expect(item).toHaveAttribute("href", href);
    }
    expect(screen.getByRole("menuitem", { name: "Sign out" }).tagName).toBe("DIV");
    expect(screen.getByRole("menuitem", { name: "Sign out" })).not.toHaveAttribute("href");
  });

  it("signs out: the session ends and the member lands on sign-in", async () => {
    renderChrome();
    await openMenu();

    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));

    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(tokenStore.get()).toBeNull();
  });
});

/**
 * D7 — dark mode is live from here. System / Light / Dark are a radio group on `useTheme()`;
 * the choice paints `html.dark`, persists for `theme-boot.js` to apply before the next first
 * paint, and leaves the menu open so a member can compare before deciding.
 */
describe("Appearance", () => {
  it("shows the current choice and switches the theme without closing the menu", async () => {
    renderChrome();
    await openMenu();

    const system = screen.getByRole("menuitemradio", { name: "System" });
    expect(system).toHaveAttribute("aria-checked", "true");

    fireEvent.click(screen.getByRole("menuitemradio", { name: "Dark" }));

    await waitFor(() => expect(document.documentElement.classList.contains("dark")).toBe(true));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: "Dark" })).toHaveAttribute("aria-checked", "true");

    fireEvent.click(screen.getByRole("menuitemradio", { name: "Light" }));
    await waitFor(() => expect(document.documentElement.classList.contains("dark")).toBe(false));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");

    // System is the ABSENCE of a stored choice, so the OS decides again from the next load.
    fireEvent.click(screen.getByRole("menuitemradio", { name: "System" }));
    await waitFor(() => expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull());
  });
});
