import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import Layout from "./Layout";
import { ProfileProvider } from "../lib/profile";
import { doorFixture, doorsServer, renderPage, signIn, signOut, stubFetch } from "../test/harness";

/**
 * The app chrome as a keyboard and a fingertip meet it.
 *
 * <p>
 * Three findings from review round 1, all of them app-wide and none of them visible from
 * inside any one page:
 * </p>
 *
 * <ul>
 * <li><b>B11</b> — no skip link. Nine tab stops stood between the top of the document and
 * the page's own content, on every route, after every navigation.</li>
 * <li><b>C16</b> — every interactive target in the header was 36 px tall: the section tabs,
 * the avatar and the wallet chip.</li>
 * <li><b>C8</b> — the club-wide shut banner rendered on paths beginning <code>/admin/</code>,
 * and an admin lands on <code>/schedule</code>.</li>
 * </ul>
 *
 * <p>
 * <b>jsdom computes no layout and applies no Tailwind</b>, so what the touch-target test below
 * holds is the DECISION — which class each control carries — and the pixels are measured in a
 * real engine by <code>e2e/narrow-viewport.spec.ts</code>. That split is the same one
 * <code>Layout.test.tsx</code> already makes for the `lg` breakpoint, and it is stated rather
 * than implied because a class assertion that is mistaken for a measurement is how a control
 * ends up with a class that generates no CSS at all.
 * </p>
 */

afterEach(() => signOut());

const PROFILE = {
  user_id: "44444444-4444-4444-4444-444444444444",
  email: "desk@club.test", full_name: "Club Desk", photo_url: null, membership_number: "C-1",
};

function chrome({ isAdmin, route = "/schedule", doors = [doorFixture()] }: {
  isAdmin: boolean;
  route?: string;
  doors?: Record<string, unknown>[];
}) {
  const whoami = signIn({ isAdmin });
  const server = doorsServer(doors);
  const stub = stubFetch([
    { path: "/api/v1/whoami", body: whoami },
    { path: "/api/v1/wallet", body: { balance_credits: 120, entries: [], count: 0 } },
    { path: "/api/v1/me/profile", body: PROFILE },
    { path: "/api/v1/admin/members", body: [] },
    ...server.routes,
  ]);
  renderPage(<ProfileProvider><Layout /></ProfileProvider>, { initialEntries: [route] });
  return stub;
}

/** Everything the browser would stop at on the way down the document, in document order. */
function focusableInOrder(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(
    'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
  ));
}

describe("the skip link", () => {
  /**
   * <b>First in the DOM is the whole point.</b> A skip link that is second is a skip link
   * you reach by tabbing past the thing you wanted to skip.
   */
  it("is the first thing a keyboard reaches in the chrome", async () => {
    chrome({ isAdmin: true });
    await screen.findByRole("button", { name: /Open menu/ });

    const first = focusableInOrder()[0];
    expect(first).toHaveTextContent("Skip to main content");
    expect(first).toHaveAttribute("href", "#main-content");
  });

  /**
   * <b>And activating it moves FOCUS, not merely the scroll position.</b> A fragment jump to
   * a target that is not focusable scrolls the page and leaves focus at the top of the
   * document, so the next Tab lands back on the club name and the link has achieved nothing —
   * which is why `<main>` carries `tabIndex={-1}` and why this asserts `toHaveFocus` rather
   * than a hash.
   */
  it("puts focus on the main content when it is activated", async () => {
    chrome({ isAdmin: true });
    const skip = await screen.findByRole("link", { name: "Skip to main content" });

    fireEvent.click(skip);

    const main = document.querySelector("main")!;
    expect(main).toHaveAttribute("id", "main-content");
    expect(main).toHaveAttribute("tabindex", "-1");
    expect(main).toHaveFocus();
  });

  /** It costs a sighted mouse user no pixels until it is focused. */
  it("is invisible until it is focused", async () => {
    chrome({ isAdmin: true });
    const skip = await screen.findByRole("link", { name: "Skip to main content" });

    expect(skip.className).toContain("sr-only");
    expect(skip.className).toContain("focus:not-sr-only");
  });
});

describe("the header's touch targets", () => {
  /**
   * C16 — 36 px on every one of them: `h-9` on the tabs and the wallet chip, and a hard
   * `style={{width: 36}}` on the avatar. The constraint is a fingertip, so the increase is
   * gated on a coarse pointer: a 44 px chip in a 56 px desktop header row is a chip that has
   * stopped being a chip.
   *
   * <p>
   * The avatar and the gear are asserted in PIXELS rather than on the rem scale for a second
   * reason (D6): everything around them doubles at a 32 px root font size and a fixed 36 px
   * avatar did not, so the cluster overflowed a 360 px screen while the target inside it was
   * still too small to hit.
   * </p>
   */
  it("raises every one of them to 44 px on a coarse pointer", async () => {
    chrome({ isAdmin: true });

    /**
     * B12 — the target is stated in PIXELS now, and that is the point of the finding.
     *
     * <p>
     * `[@media(pointer:coarse)]:h-11` is 2.75rem, which is 44 px at a 16 px root font size
     * and <b>88 px at a 32 px one</b>. Reviewer B measured what that did on a 320×568
     * screen: the header and this strip together took 54 % of the phone, so the page the
     * chrome exists to get you to had less than half of it. None of that height is a touch
     * target — 44 px is — it was a touch target written in a unit that doubles when the text
     * doubles. `min-h-[44px]` is the same 44 px at every root font size, and it is a floor,
     * so the text inside is still free to grow.
     * </p>
     */
    const tabs = await screen.findAllByRole("link", { name: "Bookings" });
    for (const tab of tabs) expect(tab.className).toContain("[@media(pointer:coarse)]:min-h-[44px]");

    // `/^Wallet balance/`, not the figure. The chip's accessible name is the BALANCE, and it
    // passes through "Wallet balance, loading" before the wallet read lands — a query on the
    // number is a query that depends on which of those two the render happened to be in, and
    // this test is about a class, not about a figure.
    const wallet = screen.getByRole("link", { name: /^Wallet balance/ });
    expect(wallet.className).toContain("[@media(pointer:coarse)]:min-h-[44px]");
    // B12's other half on this chip: it never abbreviates the one number it exists to show.
    // At a 32 px root font size the `max-w-[35vw]` + `truncate` pair rendered a balance of
    // 0 as "0…".
    expect(wallet.className).not.toContain("truncate");
    expect(wallet.className).not.toContain("max-w-[35vw]");

    const avatar = screen.getByRole("link", { name: "Edit profile" });
    expect(avatar.className).toContain("[@media(pointer:coarse)]:h-[44px]");
    expect(avatar.className).toContain("[@media(pointer:coarse)]:w-[44px]");
    // No inline 36 px left behind — the class and a `style` would disagree and the style wins.
    expect(avatar.getAttribute("style")).toBeNull();

    // The gear is 44 px at every pointer, because it is the only route to Doors and to
    // Sign out and must never be the thing that is too small OR the thing pushed off screen.
    const gear = screen.getByRole("button", { name: /Open menu/ });
    expect(gear.className).toContain("w-[44px]");
    expect(gear.className).toContain("h-[44px]");
  });
});

describe("the club-wide shut banner", () => {
  /**
   * C8 — "every admin route" and "every path beginning `/admin/`" are not the same set, and
   * the difference is the landing screen. An admin signs in and arrives at `/schedule`; so
   * are `/reports`, `/wallet` and `/my-code` member routes by path. A club that shut every
   * door after an incident could sign in the next morning, look at the day's bookings, and
   * be told nothing at all.
   */
  it("is on a member-pathed route while the signed-in user is an admin", async () => {
    chrome({ isAdmin: true, route: "/schedule", doors: [doorFixture({ enabled: false })] });

    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  /**
   * B14 — the door card is printed and put in a cupboard beside the board, and the banner
   * printed with it: a sheet of paper saying "the doors are shut", plus a button, that will
   * still be saying it in March.
   *
   * <p>
   * jsdom has no print media and no Tailwind, so this pins the DECISION — the banner sits
   * inside the chrome's print-hidden wrapper — rather than the rendering. The print
   * stylesheet itself is in `index.css` and already hides `header` and `nav`; the banner is
   * inside `main`, which is why it needed saying separately.
   * </p>
   */
  it("does not print with the door card", async () => {
    chrome({ isAdmin: true, route: "/admin/doors/99999999-9999-9999-9999-999999999999/print", doors: [doorFixture({ enabled: false })] });

    const banner = await screen.findByRole("alert");
    expect(banner.parentElement!.className).toContain("print:hidden");
  });

  it("is absent on that same route while every door is open", async () => {
    chrome({ isAdmin: true, route: "/schedule" });

    await screen.findByRole("button", { name: /Open menu/ });
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  /**
   * And a member gets neither the banner nor the READ behind it. The absence of the banner
   * is weak evidence on its own — a member would see no banner even if the condition were
   * still the path — so what is asserted is that the admin-only endpoint is never called.
   */
  it("is not rendered, and not even read, for a member", async () => {
    const stub = chrome({ isAdmin: false, route: "/schedule", doors: [doorFixture({ enabled: false })] });

    await screen.findByRole("button", { name: /Open menu/ });
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(stub.calls.some((c) => c.path.startsWith("/api/v1/admin/doors"))).toBe(false);
  });
});
