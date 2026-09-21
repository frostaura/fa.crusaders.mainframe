import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import Layout from "./Layout";
import { ProfileProvider } from "../lib/profile";
import { renderPage, signIn, signOut, stubFetch } from "../test/harness";

/**
 * The settings menu, from a keyboard.
 *
 * <p>
 * Every other way out of it worked — a click outside, choosing an item — and Escape did
 * nothing, twice, on two different sessions: the effect registered a `mousedown` document
 * listener and no `keydown`. Tab moves focus INTO the menu, so it was otherwise perfectly
 * keyboard-usable; a keyboard user simply could not dismiss it without reaching for the mouse.
 * WAI-ARIA's menu pattern makes Escape the way out.
 * </p>
 *
 * <p>
 * Returning focus to the gear is the half that is easy to leave out and just as load-bearing:
 * closing the menu while focus sits on a node that has just been unmounted drops the keyboard
 * user at the top of the document, several tab stops from where they were.
 * </p>
 *
 * <p>
 * `fireEvent.keyDown`, not `user-event` — its keyboard path never settles under jsdom 28 here
 * and hangs to the test timeout, which reads as a component that ignores input. See
 * memory/gotchas.md.
 * </p>
 */

afterEach(() => signOut());

function renderChrome() {
  const whoami = signIn({ isAdmin: false });
  stubFetch([
    { path: "/api/v1/whoami", body: whoami },
    { path: "/api/v1/wallet", body: { balance_credits: 120, entries: [], count: 0 } },
    { path: "/api/v1/me/profile", body: { user_id: whoami.user_id, email: "naledi@sample.local", full_name: "Naledi", photo_url: null, membership_number: "C-104" } },
  ]);
  // ProfileProvider is wrapped here rather than added to the shared harness: Layout is the only
  // thing that reads it, and the harness is a file every route test depends on.
  return renderPage(<ProfileProvider><Layout /></ProfileProvider>, { initialEntries: ["/schedule"] });
}

/**
 * The admin's menu — five items rather than one, which is what makes the keyboard contract
 * below testable at all. A member's menu holds only Sign out, and a single-item menu proves
 * nothing about roving focus.
 *
 * <p>
 * An empty doors view on purpose: this file is about the menu's behaviour, and a dot, a badge
 * and a banner would all be noise in it. The doors cues have their own tests.
 * </p>
 */
function renderAdminChrome() {
  const whoami = signIn({ isAdmin: true });
  stubFetch([
    { path: "/api/v1/whoami", body: whoami },
    { path: "/api/v1/wallet", body: { balance_credits: 120, entries: [], count: 0 } },
    { path: "/api/v1/me/profile", body: { user_id: whoami.user_id, email: "desk@sample.local", full_name: "Club Desk", photo_url: null, membership_number: "C-1" } },
    { path: "/api/v1/admin/members", body: [] },
    {
      path: "/api/v1/admin/doors",
      body: {
        day_started_at: new Date().toISOString(),
        timezone: "Africa/Johannesburg",
        shut_all_active: false,
        doors: [],
      },
    },
  ]);
  return renderPage(<ProfileProvider><Layout /></ProfileProvider>, { initialEntries: ["/schedule"] });
}

describe("the settings menu", () => {
  it("closes on Escape and puts focus back on the button that opened it", async () => {
    renderChrome();

    const gear = await screen.findByRole("button", { name: "Open menu" });
    fireEvent.click(gear);
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(gear).toHaveFocus();
    expect(gear).toHaveAttribute("aria-expanded", "false");
  });

  it("still closes on a click outside", async () => {
    renderChrome();

    const gear = await screen.findByRole("button", { name: "Open menu" });
    fireEvent.click(gear);
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  });
});

/**
 * B15 — the rest of what `role="menu"` promises.
 *
 * <p>
 * The menu declared the role and had none of the behaviour. Escape worked (above); nothing
 * else did. Focus never moved into it, so opening it from the keyboard left you on the gear
 * with an open panel over the page and nothing focused inside it; Tab walked out of it and
 * left it open behind you; and every item was a <code>&lt;button&gt;</code>, so four
 * navigations could not be middle-clicked, cmd-clicked or copied.
 * </p>
 *
 * <p>
 * The choice the finding demanded was <i>menu, properly</i> or <i>not a menu at all</i>. This
 * is the first: the role stays and the keyboard contract that goes with it is implemented,
 * because a half-implemented <code>role="menu"</code> is worse than no role — a screen-reader
 * user is told to expect arrow keys that do nothing.
 * </p>
 *
 * <p>
 * <code>fireEvent.focusOut</code> rather than <code>fireEvent.blur</code>: React's
 * <code>onBlur</code> is delivered from the bubbling <code>focusout</code> event, and a
 * non-bubbling <code>blur</code> dispatched at the item never reaches the container's
 * handler. The distinction is invisible in the passing direction and total in the failing one.
 * </p>
 */
describe("the settings menu's keyboard contract", () => {
  it("moves focus onto the first item when it opens", async () => {
    renderAdminChrome();

    fireEvent.click(await screen.findByRole("button", { name: /Open menu/ }));

    const items = screen.getAllByRole("menuitem");
    // "Admin settings" since D3 §3.1 took Doors and Devices out of this menu and into the
    // Monitoring section. What is under test is the focus move, not which item is first.
    expect(items[0]).toHaveTextContent("Admin settings");
    await waitFor(() => expect(items[0]).toHaveFocus());
  });

  /**
   * <b>Real links, not buttons.</b> An admin standing at the desk wants Doors in a second tab
   * while keeping the bookings screen they are looking at, and a button that navigates cannot
   * give them that however it is styled.
   */
  it("navigates with real links, so they can be opened in a new tab", async () => {
    renderAdminChrome();

    fireEvent.click(await screen.findByRole("button", { name: /Open menu/ }));

    const destinations = [
      ["Admin settings", "/admin/settings"],
      ["Webhooks", "/admin/webhooks"],
    ] as const;
    for (const [label, href] of destinations) {
      const item = screen.getByRole("menuitem", { name: new RegExp(`^${label}`) });
      expect(item.tagName).toBe("A");
      expect(item).toHaveAttribute("href", href);
    }

    // Sign out is deliberately NOT a link: it is not a destination, and a `Link` to /login
    // would be openable in a new tab without ending the session.
    expect(screen.getByRole("menuitem", { name: "Sign out" }).tagName).toBe("BUTTON");
  });

  it("closes when focus leaves it, which is what Tab does", async () => {
    renderAdminChrome();

    fireEvent.click(await screen.findByRole("button", { name: /Open menu/ }));
    const menu = screen.getByRole("menu");
    const last = screen.getAllByRole("menuitem").at(-1)!;

    // Somewhere outside the menu — the club name is the first stop in the header and is
    // certainly not inside it.
    const outside = screen.getAllByRole("link", { name: "Crusaders Squash" })[0];
    fireEvent.focusOut(last, { relatedTarget: outside });

    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(menu).not.toBeInTheDocument();
  });

  it("stays open while focus moves between its own items", async () => {
    renderAdminChrome();

    fireEvent.click(await screen.findByRole("button", { name: /Open menu/ }));
    const items = screen.getAllByRole("menuitem");
    fireEvent.focusOut(items[0], { relatedTarget: items[1] });

    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("walks the items with the arrow keys and wraps at both ends", async () => {
    renderAdminChrome();

    fireEvent.click(await screen.findByRole("button", { name: /Open menu/ }));
    const menu = screen.getByRole("menu");
    const items = screen.getAllByRole("menuitem");
    await waitFor(() => expect(items[0]).toHaveFocus());

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(items[1]).toHaveFocus();

    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(items[0]).toHaveFocus();

    // Wrapping is the half that is easy to leave out, and the half a keyboard user notices:
    // ArrowUp from the top is how you reach Sign out in one press.
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(items.at(-1)).toHaveFocus();

    fireEvent.keyDown(menu, { key: "Home" });
    expect(items[0]).toHaveFocus();

    fireEvent.keyDown(menu, { key: "End" });
    expect(items.at(-1)).toHaveFocus();
  });
});
