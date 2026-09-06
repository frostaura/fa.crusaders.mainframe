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
