import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import Layout from "./shell/AppShell";
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
 * the avatar and the wallet chip. (P2 rebuilt the chrome — one primary nav that is the phone's
 * bottom tab bar, a credits chip, an account menu — and the 44 px rule carried over.)</li>
 * <li><b>C8</b> — the club-wide shut banner rendered on paths beginning <code>/admin/</code>,
 * and an admin lands on a member route (<code>/my-code</code> since R15).</li>
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

function chrome({ isAdmin, route = "/bookings", doors = [doorFixture()] }: {
  isAdmin: boolean;
  route?: string;
  doors?: Record<string, unknown>[];
}) {
  const whoami = signIn({ isAdmin });
  const server = doorsServer(doors);
  const stub = stubFetch([
    { path: "/api/v1/whoami", body: whoami },
    { path: "/api/v1/wallet", body: { balance_minutes: 120, entries: [], count: 0 } },
    { path: "/api/v1/me/profile", body: PROFILE },
    { path: "/api/v1/admin/members", body: [] },
    { path: "/api/v1/admin/monitoring/summary", body: { open: {} } },
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
    await screen.findByRole("button", { name: "Account menu" });

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

  /**
   * C-L4 / R3-35 — and the public landing page gets one too.
   *
   * <p>
   * The link was added to the signed-in shell, and `Layout` returns before that shell on two
   * branches. One of them is the club's own front door: the longest page in the product — a
   * hero, four sections, a map link and a footer — and the first page anybody sees. A keyboard
   * user arriving there had no way past its navigation to its content, and `#main-content`
   * did not exist for the route announcer to land on either.
   * </p>
   */
  it("is there on the signed-out landing page, which is a different shell", async () => {
    signOut();
    stubFetch([{ path: "/api/v1/whoami", body: { is_authenticated: false, is_admin: false, tenant_slug: "crusaders", tenant_id: "t", user_id: null } }]);
    renderPage(<ProfileProvider><Layout /></ProfileProvider>, { initialEntries: ["/"] });

    const skip = await screen.findByRole("link", { name: "Skip to main content" });
    expect(focusableInOrder()[0], "the skip link is not the first thing a keyboard reaches").toBe(skip);

    fireEvent.click(skip);
    const main = document.querySelector("main")!;
    expect(main).toHaveAttribute("id", "main-content");
    expect(main).toHaveFocus();
  });

  /**
   * P2 — and past ALL the navigation, onto the page's own heading when it has one. The admin
   * console's rail and section switcher are inside `<main>`, ahead of the page: a skip link that
   * stopped at the top of `<main>` would leave an admin a dozen rail links from the page (C14).
   */
  it("lands on the page's heading, past any navigation inside main", async () => {
    const whoami = signIn({ isAdmin: false });
    stubFetch([
      { path: "/api/v1/whoami", body: whoami },
      { path: "/api/v1/wallet", body: { balance_minutes: 120, entries: [], count: 0 } },
      { path: "/api/v1/me/profile", body: PROFILE },
    ]);
    renderPage(
      <ProfileProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/wallet" element={<><nav aria-label="Section"><a href="/x">A rail link</a></nav><h1>Wallet</h1></>} />
          </Route>
        </Routes>
      </ProfileProvider>,
      { initialEntries: ["/wallet"] },
    );

    fireEvent.click(await screen.findByRole("link", { name: "Skip to main content" }));

    const heading = screen.getByRole("heading", { name: "Wallet" });
    expect(heading).toHaveFocus();
    // Focusable without becoming a tab stop, and carrying the scroll margin / keyboard ring hook.
    expect(heading).toHaveAttribute("tabindex", "-1");
    expect(heading).toHaveAttribute("data-route-heading");
  });

  /** It costs a sighted mouse user no pixels until it is focused. */
  it("is invisible until it is focused", async () => {
    chrome({ isAdmin: true });
    const skip = await screen.findByRole("link", { name: "Skip to main content" });

    expect(skip.className).toContain("sr-only");
    expect(skip.className).toContain("focus:not-sr-only");
  });
});

describe("the chrome's touch targets", () => {
  /**
   * C16 — every target in the old header was 36 px: the tabs, the avatar and the wallet chip.
   * The rebuilt chrome states each in named tokens, and each one's decision is pinned here as a
   * class (jsdom applies no Tailwind); `e2e/narrow-viewport.spec.ts` measures the pixels.
   *
   * <p>
   * B12's rule carries over: a touch target is a fingertip and does not double with the text, so
   * every one is a token in PIXELS (`touch` 44, `tabbar` 64), never `h-11`.
   * </p>
   */
  it("gives every one of them a fingertip", async () => {
    chrome({ isAdmin: true });

    // The primary nav: 64 px tabs in the phone's bottom bar, 44 px pills in the top bar.
    const nav = await screen.findByRole("navigation", { name: "Main" });
    for (const tab of within(nav).getAllByRole("link")) {
      expect(tab.className).toContain("min-h-tabbar");
      expect(tab.className).toContain("@[44rem]/appbar:min-h-touch");
      expect(tab.className).not.toMatch(/\bh-11\b/);
    }

    // The account menu's trigger is 44 px at every pointer: it is the only way to Sign out.
    const account = screen.getByRole("button", { name: "Account menu" });
    expect(account.className).toContain("size-touch");

    // The crest is the way home and a 44 px target, though it carries no other action.
    const crest = screen.getByRole("link", { name: "Crusaders Squash — home" });
    expect(crest.className).toContain("min-h-touch");
    expect(crest.className).toContain("min-w-touch");
    expect(crest).toHaveAttribute("href", "/my-code");

    // The credits chip: a 44 px floor at every pointer, and no fixed height — a box that did not
    // grow with a 32 px root's text would clip the one number it exists to show.
    const wallet = screen.getByRole("link", { name: /^Wallet balance/ });
    expect(wallet.className).toContain("min-h-touch");
    expect(wallet.className).not.toMatch(/(^|\s)h-\d/);
    /**
     * B12's other half on this chip: it never abbreviates the one number it exists to show. At a
     * 32 px root the old `max-w-[35vw]` + `truncate` pair rendered a balance of 0 as "0…".
     * Asserted on the FIGURE as well as the link — a mutation that put `truncate` on the span
     * holding the digits once survived a link-only check.
     */
    const figure = wallet.querySelector("span[aria-hidden]")!;
    expect(figure).toBeTruthy();
    for (const node of [wallet, figure]) {
      expect(node.className).not.toContain("truncate");
      expect(node.className).not.toContain("text-ellipsis");
    }
    // No inline pixel sizes left behind: a class and a `style` would disagree and the style wins.
    expect(account.getAttribute("style")).toBeNull();
  });
});

describe("the club-wide shut banner", () => {
  /**
   * C8 — "every admin route" and "every path beginning `/admin/`" are not the same set, and
   * the difference is the landing screen. An admin signs in and arrived at `/schedule`; so
   * are `/reports`, `/wallet` and `/my-code` member routes by path. A club that shut every
   * door after an incident could sign in the next morning, look at the day's bookings, and
   * be told nothing at all. Since R15 the landing is My Code, which is a member route too.
   */
  it("is on a member-pathed route while the signed-in user is an admin", async () => {
    chrome({ isAdmin: true, route: "/my-code", doors: [doorFixture({ enabled: false })] });

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
    chrome({ isAdmin: true, route: "/my-code" });

    await screen.findByRole("button", { name: "Account menu" });
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  /**
   * And a member gets neither the banner nor the READ behind it. The absence of the banner
   * is weak evidence on its own — a member would see no banner even if the condition were
   * still the path — so what is asserted is that the admin-only endpoint is never called.
   */
  it("is not rendered, and not even read, for a member", async () => {
    const stub = chrome({ isAdmin: false, route: "/my-code", doors: [doorFixture({ enabled: false })] });

    await screen.findByRole("button", { name: "Account menu" });
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(stub.calls.some((c) => c.path.startsWith("/api/v1/admin/doors"))).toBe(false);
  });
});
