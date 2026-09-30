import { type Page } from "@playwright/test";
import { SESSION_ANON, serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { memberShellRoutes, PROFILE_ME } from "./playersKit";
import { ADMIN_TOUR, ADMIN_TOUR_PATH, REPLAY_ADMIN_TOUR } from "../src/lib/onboardingCopy";

/**
 * Review round 4 (lane F4) — the shared primitives and the shell at 200 % text, on 390 and 320 px
 * phones. 200 % text is `html { font-size: 32px }` (gotchas-frontend-layout): every rem doubles,
 * and every PIXEL-sized box does not — which is what each defect below was.
 *
 * <ul>
 *   <li>V4-1 — a text input was a fixed 44 px (`h-touch`) around a 48 px line: the typed text was
 *   cut, "Forgot password?" wrapped onto the field, the passkey pill and "Submit application" were
 *   clipped, and the photo drop zone ran out of the card.</li>
 *   <li>V4-2 / X4-7 — the signed-out Home's contact links did not wrap (the page scrolled sideways
 *   85 px at 390, 155 at 320) and were 20 px targets.</li>
 *   <li>V4-5 / X4-1 — the admin tour's popover ran off the bottom of the screen; Next unreachable.</li>
 *   <li>X4-2 — the account menu ran off the right edge (a 12rem min-width is 384 px here) and did
 *   not scroll, so Sign out could not be reached.</li>
 *   <li>V4-11 — the bell's unread badge was clipped by the top of the screen.</li>
 *   <li>X4-4 — the account menu's destinations left focus on the avatar; the replayed tour was
 *   never reached by focus.</li>
 * </ul>
 */

const BIG = "html { font-size: 32px; }";

async function bigText(page: Page) {
  await page.addStyleTag({ content: BIG });
  // One frame for the restyle to land before anything is measured.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
}

/** How far anything scrolls sideways — the document and `<main>`, the app shell's scroller. */
async function sideways(page: Page): Promise<number> {
  return page.evaluate(() => {
    const els = [document.scrollingElement, ...document.querySelectorAll("main")].filter(Boolean) as Element[];
    return Math.max(...els.map((el) => el.scrollWidth - el.clientWidth));
  });
}

/** Whether any text node inside `selector` paints outside the viewport's width (Range, not element rects). */
async function textOffScreen(page: Page, selector: string): Promise<string[]> {
  return page.evaluate((sel) => {
    const out: string[] = [];
    const root = document.querySelector(sel);
    if (!root) return ["<missing>"];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        if (rect.width > 0 && (rect.right > window.innerWidth + 1 || rect.left < -1)) out.push(node.textContent.trim().slice(0, 40));
      }
    }
    return out;
  }, selector);
}

/**
 * A button whose visible label (its `button-label` layer — the pending layer is invisible until it
 * is needed) is drawn outside the button's own box: clipped or spilled text.
 */
async function clipped(page: Page, selector: string): Promise<{ text: string; w: number; h: number }[]> {
  return page.locator(selector).evaluateAll((els) => els
    .filter((el) => (el as HTMLElement).offsetParent !== null)
    .map((el) => {
      const box = el.getBoundingClientRect();
      const label = (el.querySelector("[data-slot=button-label]") ?? el).getBoundingClientRect();
      return {
        text: (el.textContent ?? "").trim().slice(0, 30),
        w: Math.max(box.left - label.left, label.right - box.right),
        h: Math.max(box.top - label.top, label.bottom - box.bottom),
      };
    })
    .filter((c) => c.w > 1 || c.h > 1));
}

/** The painted bottom of an element's text (a Range, so a box's padding and margins do not count). */
async function textBottom(page: Page, selector: string): Promise<number> {
  return page.locator(selector).first().evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return range.getBoundingClientRect().bottom;
  });
}

const WIDTHS = [390, 320] as const;

test.describe("V4-1 — sign-in and register at 200 % text", () => {
  for (const width of WIDTHS) {
    test(`sign-in at ${width}: fields grow with their text and stay in the card`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await serveApi(page, [{ path: "/api/v1/session", body: SESSION_ANON }]);
      await page.goto("/login");
      await expect(page.getByLabel("Email")).toBeVisible();
      await bigText(page);

      // Each input at least as tall as the line it holds — a fixed 44 px box around a 48 px line
      // is the clipped text the reviewer saw.
      const fields = await page.locator("input").evaluateAll((els) => els.map((el) => {
        const cs = getComputedStyle(el);
        return { name: el.getAttribute("autocomplete"), height: el.getBoundingClientRect().height, line: parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5 };
      }));
      expect(fields.length).toBeGreaterThanOrEqual(2);
      for (const f of fields) expect(f.height, `${f.name} is shorter than its own line`).toBeGreaterThanOrEqual(f.line);

      const card = (await page.locator("form").first().evaluate((el) => el.getBoundingClientRect().toJSON())) as DOMRect;
      const password = (await page.getByLabel("Password", { exact: true }).evaluate((el) => el.getBoundingClientRect().toJSON())) as DOMRect;
      expect(password.right, "the password field runs out of the form").toBeLessThanOrEqual(card.right + 1);

      // "Forgot password?" is painted above the field, never on it.
      const forgot = await textBottom(page, "a[href='/forgot-password']");
      expect(forgot, "Forgot password? is drawn over the field").toBeLessThanOrEqual(password.top + 1);

      expect(await clipped(page, "button"), "a button's label is cut").toEqual([]);
      expect(await sideways(page)).toBeLessThanOrEqual(1);
    });

    test(`register at ${width}: the photo picker and the submit button fit`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await serveApi(page, [{ path: "/api/v1/session", body: SESSION_ANON }]);
      await page.goto("/register");
      await expect(page.getByRole("button", { name: "Submit application" })).toBeVisible();
      await bigText(page);

      expect(await clipped(page, "button"), "a button's label is cut").toEqual([]);
      expect(await textOffScreen(page, "form"), "text runs off the screen").toEqual([]);
      expect(await sideways(page)).toBeLessThanOrEqual(1);
    });
  }
});

test.describe("V4-2 / X4-7 — the signed-out Home's contact links", () => {
  for (const width of WIDTHS) {
    test(`at ${width} and 200 %: they wrap, and each is a 44 px target`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await serveApi(page, [{ path: "/api/v1/session", body: SESSION_ANON }, { path: "/api/v1/whoami", status: 401, body: { error: "unauthenticated" } }]);
      await page.goto("/");
      const touch = page.getByRole("heading", { name: "Get in touch" });
      await expect(touch).toBeVisible();
      await bigText(page);

      expect(await sideways(page), "the page scrolls sideways").toBeLessThanOrEqual(1);
      const links = page.locator("div:has(> h2:text-is('Get in touch')) a");
      const heights = await links.evaluateAll((els) => els.map((el) => ({ text: el.textContent?.trim(), h: el.getBoundingClientRect().height, r: el.getBoundingClientRect().right })));
      expect(heights.length).toBe(4);
      for (const l of heights) {
        expect(l.h, `${l.text} is not a 44 px target`).toBeGreaterThanOrEqual(44);
        expect(l.r, `${l.text} runs off the screen`).toBeLessThanOrEqual(width + 1);
      }
    });
  }
});

/** A signed-in admin with the tour not yet taken, on the admin console. */
function adminRoutes(): ApiRoute[] {
  const prefs = {
    theme: "system", member_onboarding_completed_at: null, member_onboarding_dismissed_at: "2026-09-01T10:00:00Z",
    admin_onboarding_completed_at: "2026-09-01T10:00:00Z", admin_onboarding_dismissed_at: null,
  };
  return [
    ...memberShellRoutes({ admin: true, unread: 3 }),
    { path: "/api/v1/session", body: { ...SESSION_ANON, is_authenticated: true, is_admin: true } },
    { path: "/api/v1/me/profile", body: { ...PROFILE_ME, email: "a.very.long.address.for.the.menu@club.review.test", is_admin: true, status: "active", preferences: prefs } },
    { path: "/api/v1/me/preferences", body: { ...prefs, findable: false, show_in_leaderboards: false } },
    { path: "/api/v1/me/webauthn/credentials", body: [] },
    { path: "/api/v1/me/door/history", body: { items: [], has_more: false } },
    { method: "POST", path: "/api/v1/me/onboarding/admin/complete", body: prefs },
    { path: "/api/v1/admin/members", body: [] },
    { path: "/api/v1/admin/monitoring/summary", body: { open: {} } },
    { path: "/api/v1/admin/doors", body: { day_started_at: "2026-09-23T00:00:00Z", timezone: "Africa/Johannesburg", shut_all_active: false, doors: [] } },
  ];
}

test.describe("the shell at 200 % text", () => {
  test("X4-2 — the account menu stays on a 375×667 screen and scrolls to Sign out", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await signIn(page);
    await serveApi(page, adminRoutes());
    await page.goto("/profile");
    await expect(page.getByRole("button", { name: "Account menu" })).toBeVisible();
    await bigText(page);

    await page.getByRole("button", { name: "Account menu" }).click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    const box = (await menu.boundingBox())!;
    expect(box.x, "the menu runs off the left").toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, "the menu runs off the right").toBeLessThanOrEqual(375 + 1);
    expect(box.y + box.height, "the menu runs off the bottom").toBeLessThanOrEqual(667 + 1);

    // Sign out is the last row: reachable by the keyboard and scrolled into the menu's own view.
    const signOut = menu.getByRole("menuitem", { name: "Sign out" });
    await page.keyboard.press("End");
    await expect(signOut).toBeFocused();
    await expect(signOut).toBeInViewport({ ratio: 1 });
  });

  test("V4-11 — the bell's unread badge is not cut by the top of the screen", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);
    await serveApi(page, adminRoutes());
    await page.goto("/wallet");
    await expect(page.locator("[data-unread-badge]")).toBeVisible();
    await bigText(page);
    const badge = (await page.locator("[data-unread-badge]").evaluate((el) => el.getBoundingClientRect().toJSON())) as DOMRect;
    const header = (await page.locator("[data-app-header]").evaluate((el) => el.getBoundingClientRect().toJSON())) as DOMRect;
    expect(badge.top, "the badge is above the top of the screen").toBeGreaterThanOrEqual(0);
    expect(badge.top, "the badge sticks out of the header").toBeGreaterThanOrEqual(header.top);
  });

  for (const width of WIDTHS) {
    test(`V4-5 / X4-1 — the admin tour fits a ${width} phone and Next can be reached`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await signIn(page);
      await serveApi(page, adminRoutes());
      await page.addInitScript((css) => {
        document.addEventListener("DOMContentLoaded", () => {
          const style = document.createElement("style");
          style.textContent = css;
          document.head.append(style);
        });
      }, BIG);
      await page.goto(ADMIN_TOUR_PATH);
      const mark = page.getByRole("dialog", { name: ADMIN_TOUR.stops[0].title });
      await expect(mark).toBeVisible();
      const box = (await mark.boundingBox())!;
      expect(box.y, "the tour starts above the screen").toBeGreaterThanOrEqual(0);
      expect(box.y + box.height, "the tour runs off the bottom of the screen").toBeLessThanOrEqual(844 + 1);
      expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
      const next = mark.getByRole("button", { name: ADMIN_TOUR.next, exact: true });
      await next.scrollIntoViewIfNeeded();
      await expect(next).toBeInViewport({ ratio: 1 });
      await next.click();
      await expect(page.getByRole("dialog", { name: ADMIN_TOUR.stops[1].title })).toBeVisible();
    });
  }
});

/** Opens the account menu and chooses `name` with the keyboard alone, as the reviewer did. */
async function chooseByKeyboard(page: Page, name: string) {
  await page.getByRole("button", { name: "Account menu" }).focus();
  await page.keyboard.press("Enter");
  const item = page.getByRole("menu").getByRole("menuitem", { name });
  for (let i = 0; i < 12 && !(await item.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("ArrowDown");
  await expect(item).toBeFocused();
  await page.keyboard.press("Enter");
}

test.describe("X4-4 — the account menu hands focus to where it went", () => {
  test("Replay admin tour: focus lands in the tour, which is announced by its name", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);
    await serveApi(page, adminRoutes());
    await page.goto("/profile");
    await expect(page.getByRole("button", { name: "Account menu" })).toBeVisible();
    await chooseByKeyboard(page, REPLAY_ADMIN_TOUR);
    const mark = page.getByRole("dialog", { name: ADMIN_TOUR.stops[0].title });
    await expect(mark).toBeVisible();
    await expect.poll(() => mark.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    // And it stays there — the menu's close must not pull it back to the avatar afterwards.
    await page.waitForTimeout(400);
    expect(await mark.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  });

  test("Profile: focus lands on the page's heading, not back on the avatar", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);
    await serveApi(page, adminRoutes());
    await page.goto("/wallet");
    await expect(page.getByRole("button", { name: "Account menu" })).toBeVisible();
    await chooseByKeyboard(page, "Profile");
    await expect(page).toHaveURL(/\/profile$/);
    await expect(page.locator("#main-content h1")).toBeFocused();
    await page.waitForTimeout(400);
    await expect(page.locator("#main-content h1")).toBeFocused();
  });
});

/* ------------------------------------------------------------------------------------------
 * The integrator's asks after the bookings lane (R4): the selection bar and a sheet's header.
 * ---------------------------------------------------------------------------------------- */

const tomorrowUtc = () => { const d = new Date(); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
const COURT_1 = "aaaaaaaa-0000-4000-8000-00000000000a";

async function openDay(page: Page) {
  const date = tomorrowUtc();
  await signIn(page);
  await serveApi(page, [
    ...memberShellRoutes(),
    { path: "/api/v1/me/bookings/upcoming", body: { timezone: "UTC", items: [] } },
    { path: "/api/v1/me/bookings/recent", body: { timezone: "UTC", items: [] } },
    { path: "/api/v1/schedule", body: {
      date, timezone: "UTC", sliceMinutes: 15, dayStartMinute: 7 * 60, dayEndMinute: 9 * 60,
      advanceBookingDays: 14, penaltyPct: 30, penaltyWindowMinutes: 15,
      courts: [{ id: COURT_1, courtNumber: 1, name: "Court 1", slicePriceCredits: 50 }], slots: [],
    } },
  ]);
  await page.goto(`/bookings?date=${date}`);
  await page.waitForSelector('[role="grid"]');
}

test("the selection bar at 390 and 200 %: its words wrap whole and the actions go under them", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openDay(page);
  await page.getByRole("button", { name: "Select several slots" }).click();
  for (const at of ["07:00", "07:15", "07:30", "07:45"]) await page.getByRole("button", { name: new RegExp(`^Book Court 1 at ${at}`) }).click();
  await bigText(page);
  const bar = page.getByRole("toolbar", { name: "Selected slots" });
  await expect(bar).toBeVisible();
  const cut = await bar.locator("p").evaluateAll((els) => els.map((el) => ({
    text: el.textContent, ellipsis: getComputedStyle(el).textOverflow === "ellipsis" || getComputedStyle(el).webkitLineClamp !== "none",
    over: el.scrollHeight - el.clientHeight, wide: el.scrollWidth - el.clientWidth,
  })));
  for (const c of cut) {
    expect(c.ellipsis, `"${c.text}" is cut`).toBe(false);
    expect(Math.max(c.over, c.wide), `"${c.text}" overflows its line box`).toBeLessThanOrEqual(1);
  }
  const b = (await bar.boundingBox())!;
  expect(b.x + b.width).toBeLessThanOrEqual(390 + 1);
  expect(await clipped(page, "[role=toolbar] button"), "an action's label is cut").toEqual([]);
});

test("a sheet at 320×640 and 200 %: the header leaves the body most of the room", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await openDay(page);
  await page.getByRole("button", { name: /^Book Court 1 at 07:00/ }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  await bigText(page);
  const header = (await sheet.locator("[data-slot=dialog-header]").first().boundingBox())!;
  const body = (await sheet.locator("[data-slot=dialog-body]").first().boundingBox())!;
  expect(header.height, "the header takes more than a third of the screen").toBeLessThanOrEqual(640 / 3 + 1);
  expect(body.height, "the body is a sliver").toBeGreaterThanOrEqual(header.height * 0.75);
});
