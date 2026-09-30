import { type Page } from "@playwright/test";
import { SESSION_ADMIN, serveApi, signIn, test, expect, type ApiRoute, memberCodeRoutes } from "./fixtures";

/**
 * F4-3 (review round 2, VIS-H) — the DOCUMENT never scrolls on a shell page; `<main>` does.
 *
 * <p>
 * The whole app scrolled off-screen: admin /admin at 1280 wide reported `window.scrollY` 1588 and
 * showed nothing but blank. `.sr-only` live-region text is `position: absolute`, and with no
 * positioned ancestor its containing block is the initial one — so a live region far down a long
 * page inside `<main>`'s own scroller sat at its static position in the DOCUMENT, made the
 * document taller than the viewport, and a wheel or a focus scrolled the document instead of
 * `<main>`: header, nav and page went up and away together. `relative` on both shell `<main>`s
 * gives the absolute text a box inside the scroller. Measured here at 1280 and 390 with every
 * live region on the page populated and one more placed at the foot of a page taller than the
 * screen — the shape of the original repro.
 * </p>
 */

const TZ = "Africa/Johannesburg";

function adminRoutes(): ApiRoute[] {
  return [
    { path: "/api/v1/whoami", body: SESSION_ADMIN },
    { path: "/api/v1/me/profile", body: { full_name: "Crusaders Admin", email: "admin@sample.local", photo_url: null, membership_number: "ADMIN-0001" } },
    { path: "/api/v1/wallet", body: { balance_credits: 0, entries: [], total_entries: 0, offset: 0, limit: 50 } },
    { path: "/api/v1/admin/courts/", body: [] },
    { path: "/api/v1/admin/members", body: [] },
    { path: "/api/v1/admin/doors", body: { doors: [], shut_together: [], shut_individually: [], timezone: TZ } },
    { path: "/api/v1/admin/monitoring/summary", body: { open: {} } },
  ];
}

function memberRoutes(): ApiRoute[] {
  return [
    { path: "/api/v1/whoami", body: { ...SESSION_ADMIN, is_admin: false } },
    { path: "/api/v1/me/profile", body: { full_name: "Lerato Mokoena", email: "lerato@sample.local", photo_url: null, membership_number: "M-0001" } },
    { path: "/api/v1/wallet", body: { balance_credits: 500, entries: [], total_entries: 0, offset: 0, limit: 50 } },
    ...memberCodeRoutes(),
    {
      path: "/api/v1/me/door",
      body: {
        doors: true, doors_shut: "none", timezone: TZ, policy: "booking_window",
        membership: "active", membership_detail: "active", is_club_admin: false, next_booking: null,
        early_entry_minutes: 30, roster_max_entries: 48,
        contact: { phone: "021 555 0134", email: "info@crusaders.co.za" },
        door_log_retention_days: 90, last_decision: null,
      },
    },
    { path: "/api/v1/me/door/history", body: { items: [], next_cursor: null, retention_days: 90, timezone: TZ } },
  ];
}

/** Populate every live region, add one at the foot of a too-tall page, and try to scroll the document. */
async function documentScroll(page: Page) {
  return page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLElement>("[aria-live], [role=status], [role=alert]")) {
      if (!el.textContent) el.textContent = "Something the page announced a moment ago.";
    }
    const main = document.querySelector<HTMLElement>("main#main-content")!;
    const host = main.querySelector<HTMLElement>("[data-shell-frame]") ?? main;
    const spacer = document.createElement("div");
    spacer.style.height = "3000px";
    // A visually hidden live region whose text is not clipped to its 1px box — what escaped. (An
    // `overflow: hidden` one adds nothing to the document in Chromium; text spilling out of the
    // box does, and so does any absolutely placed badge or tooltip with no positioned ancestor.)
    const live = document.createElement("div");
    live.className = "sr-only";
    live.style.overflow = "visible";
    live.setAttribute("role", "status");
    live.textContent = "Saved. Your changes are live for every member now.";
    const block = document.createElement("div"); // a block, not a flex item: the static position is after the spacer
    block.append(spacer, live);
    host.append(block);
    window.scrollTo(0, 1_000_000);
    document.scrollingElement!.scrollTop = 1_000_000;
    return {
      scrollY: window.scrollY,
      docHeight: document.scrollingElement!.scrollHeight,
      vh: window.innerHeight,
      mainScrolls: main.scrollHeight > main.clientHeight,
    };
  });
}

const PAGES: { path: string; admin: boolean }[] = [
  { path: "/admin", admin: true },
  { path: "/admin/members", admin: true },
  { path: "/my-code", admin: false },
  { path: "/wallet", admin: false },
  { path: "/profile", admin: false },
];

for (const width of [1280, 390]) {
  test.describe(`at ${width} px`, () => {
    test.use({ viewport: { width, height: width === 390 ? 844 : 800 } });
    for (const { path, admin } of PAGES) {
      test(`the document never scrolls on ${path}`, async ({ page }) => {
        await signIn(page);
        await serveApi(page, admin ? adminRoutes() : memberRoutes());
        await page.goto(path);
        await expect(page.getByRole("button", { name: "Account menu" })).toBeVisible();
        await expect(page.locator("main h1").first()).toBeVisible();

        const m = await documentScroll(page);

        expect(m.mainScrolls, "the tall page scrolls inside <main>").toBe(true);
        expect(m.docHeight, "the document is never taller than the viewport").toBeLessThanOrEqual(m.vh);
        expect(m.scrollY, "so the whole app cannot scroll off-screen").toBe(0);
        await expect(page.locator("header[data-app-header]")).toBeInViewport();
      });
    }
  });
}

/**
 * F4-4 (review round 2, A11Y-M) — a control reached by Tab is never left under the phone's tab bar.
 *
 * <p>
 * "Continue to PayFast", "Change split", My Code's "Wallet topped up" and admin member rows were
 * all focused BEHIND the fixed bottom bar at 390: the browser scrolled them just into `<main>`'s
 * box, and the bar sits over that box's foot. `scroll-padding-bottom` on `<main>` = the bar's
 * published height (safe area included) is what moves the target clear.
 * </p>
 */
test.describe("at 390 px, a focused control", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  for (const { path, admin } of [{ path: "/profile", admin: false }, { path: "/admin/members", admin: true }]) {
    test(`clears the tab bar on ${path}`, async ({ page }) => {
      await signIn(page);
      await serveApi(page, admin ? adminRoutes() : memberRoutes());
      await page.goto(path);
      await expect(page.locator("nav[data-primary-nav]")).toBeVisible();
      await page.evaluate(() => {
        const host = document.querySelector<HTMLElement>("main#main-content [data-shell-frame]")!;
        const block = document.createElement("div");
        block.innerHTML = '<button id="f4-before">Before</button><div id="f4-spacer" style="height:100px"></div><button id="f4-target">Continue to PayFast</button><div style="height:1500px"></div>';
        host.prepend(block);
        // Put the target exactly where the finding saw it: inside <main>'s box, behind the bar —
        // "visible" to the browser, so a plain focus does not scroll at all.
        const spacer = document.querySelector<HTMLElement>("#f4-spacer")!;
        const barTop = document.querySelector("nav[data-primary-nav]")!.getBoundingClientRect().top;
        const top = document.querySelector("#f4-target")!.getBoundingClientRect().top;
        spacer.style.height = `${100 + (barTop + 6 - top)}px`;
      });
      await page.locator("#f4-before").focus();
      await page.keyboard.press("Tab");
      await expect(page.locator("#f4-target")).toBeFocused();

      const g = await page.evaluate(() => ({
        target: document.querySelector("#f4-target")!.getBoundingClientRect().bottom,
        bar: document.querySelector("nav[data-primary-nav]")!.getBoundingClientRect().top,
      }));
      expect(g.target, "the focused control's foot is above the tab bar").toBeLessThanOrEqual(g.bar);
    });
  }
});
