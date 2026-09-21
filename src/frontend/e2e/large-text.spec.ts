import { expect, test, type Page } from "@playwright/test";
import { serveApi, signIn, SESSION_ADMIN } from "./fixtures";

/**
 * B12, at the size the club actually turns the text up to.
 *
 * <p>
 * Every layout defect this codebase has shipped twice was invisible at a 16 px root font size:
 * a toast strip anchored at `top-[100px]`, a heading offset of `5rem`, a header that took 54 %
 * of a 320×568 phone, a confirm button rendering "Cance / l". The pattern is always the same —
 * a box sized in rem, protecting something that is not type.
 * </p>
 *
 * <p>
 * The primitives were the last three holding it: `Button`'s `h-11 px-5` is an 88 px-tall
 * button with 80 px of horizontal padding at a 32 px root, `Card`'s `p-4 sm:p-6` gives 96 px
 * of a 288 px content box to its own margins, and `Layout`'s `px-4 py-6` takes 32 px a side
 * off the page before any content. All three are in pixels now; the text still scales.
 * </p>
 *
 * <p>
 * The assertion is horizontal page scroll, because that is the failure a member sees: a screen
 * that slides sideways under a thumb, with a control half past the edge. `scrollWidth` against
 * `innerWidth` is the whole of it.
 * </p>
 */

const ADMIN_ROUTES: Array<[string, string]> = [
  ["/admin/monitoring/doors", "Doors"],
  ["/admin/monitoring/devices", "Devices"],
];

const MEMBER_ROUTES: Array<[string, string]> = [
  ["/schedule", "Bookings"],
  ["/my-code", "Your code"],
];

/** Everything either screen asks for, answered thinly — this spec is about geometry. */
function routes(isAdmin: boolean) {
  const today = new Date().toISOString().slice(0, 10);
  return [
    { path: "/api/v1/whoami", body: { ...SESSION_ADMIN, is_admin: isAdmin } },
    {
      path: "/api/v1/me/profile",
      body: {
        user_id: SESSION_ADMIN.user_id, email: "a@club.test", is_admin: isAdmin,
        tenant_slug: "crusaders", full_name: "Priya Naidoo", membership_number: "M-1",
        photo_url: null, status: "active",
      },
    },
    { path: "/api/v1/wallet", body: { balance_credits: 120, entries: [], total_entries: 0, offset: 0, limit: 100 } },
    { method: "POST", path: "/api/v1/wallet/stream-ticket", body: { ticket: "t", expires_in_seconds: 60 } },
    {
      path: "/api/v1/schedule",
      body: {
        date: today, timezone: "Africa/Johannesburg", sliceMinutes: 15,
        dayStartMinute: 360, dayEndMinute: 1320, advanceBookingDays: 14,
        penaltyPct: 30, penaltyWindowMinutes: 120,
        courts: [
          { id: "c1", courtNumber: 1, name: "Court 1", slicePriceCredits: 50 },
          { id: "c2", courtNumber: 2, name: "Court 2", slicePriceCredits: 50 },
        ],
        slots: [],
      },
    },
    { method: "POST", path: "/api/v1/me/qr/generate", body: { code: "ABC123", kind: "ident", expires_in_seconds: 120 } },
    { path: "/api/v1/me/door", body: { timezone: "Africa/Johannesburg", doors: false } },
    { path: "/api/v1/admin/members", body: [] },
    { path: "/api/v1/admin/doors/activity", body: { items: [], next_cursor: null, retention_days: 90 } },
    { path: "/api/v1/admin/doors", body: { doors: [], timezone: "Africa/Johannesburg", shut_all_at: null } },
    { path: "/api/v1/admin/devices/api-key", body: { api_key: "k", created_at: new Date().toISOString() } },
    { path: "/api/v1/admin/devices/", body: [] },
    { path: "/api/v1/admin/courts/", body: [] },
    { path: "/api/v1/admin/settings/", body: {} },
  ];
}

/** The club's text at twice the size. Added before navigation, so nothing renders at 16 first. */
async function enlarge(page: Page) {
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      document.documentElement.style.fontSize = "32px";
    });
  });
}

/**
 * Elements sticking out past the right edge — <b>excluding the ones that are meant to</b>.
 *
 * <p>
 * The first cut flagged every child of a horizontal scroller, which is what a scroller is
 * for: the section tab strip, the Monitoring strip and the booking grid all put content wider
 * than the viewport inside a `ScrollArea` on purpose, and that content is reachable by
 * scrolling the container rather than the page. Measured — it reported five "offenders" on
 * `/admin/monitoring/doors` while the document itself did not scroll sideways at all.
 * </p>
 *
 * <p>
 * So the walk stops at any ancestor that scrolls horizontally. What is left is the real
 * failure: something past the edge with no way to reach it.
 * </p>
 */
async function widestOverflow(page: Page) {
  return page.evaluate(() => {
    const limit = window.innerWidth;
    const scrollsSideways = (el: Element) => {
      const overflowX = getComputedStyle(el).overflowX;
      return overflowX === "auto" || overflowX === "scroll";
    };
    const insideAScroller = (el: Element) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        if (scrollsSideways(p)) return true;
      }
      return false;
    };

    const offenders: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("body *")) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (box.right <= limit + 1) continue;
      if (insideAScroller(el)) continue;
      offenders.push(`${el.tagName.toLowerCase()}.${el.className.toString().slice(0, 40)} @${Math.round(box.right)}`);
    }
    return {
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: limit,
      // The first few only: a single overflowing ancestor drags every descendant into the list.
      offenders: offenders.slice(0, 5),
    };
  });
}

for (const [route, heading] of [...MEMBER_ROUTES, ...ADMIN_ROUTES]) {
  const isAdmin = ADMIN_ROUTES.some(([r]) => r === route);

  test(`${route} does not scroll sideways at 320 px with a 32 px root font`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await signIn(page);
    await enlarge(page);
    await serveApi(page, routes(isAdmin));

    await page.goto(route);
    await expect(page.getByRole("heading", { name: heading, level: 1 })).toBeVisible();

    // The root font size really did apply — a spec that silently measured 16 px would pass
    // for the wrong reason, which is exactly how the `5rem` and `top-[100px]` defects survived.
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe("32px");

    const overflow = await widestOverflow(page);
    expect(overflow.offenders, `${route}: elements past the right edge`).toEqual([]);
    expect(overflow.scrollWidth, route).toBeLessThanOrEqual(overflow.innerWidth);
  });
}

test("a Button is a fingertip tall at 16 px and no taller at 32 px", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await signIn(page);
  await serveApi(page, routes(false));
  await page.goto("/schedule");

  const button = page.getByRole("button", { name: "Refresh" });
  await expect(button).toBeVisible();
  const small = (await button.boundingBox())!;

  await page.evaluate(() => { document.documentElement.style.fontSize = "32px"; });
  const large = (await button.boundingBox())!;

  // 44 px is 44 px whatever size the text is. It was `h-11` — 2.75rem — which is 88 px here.
  expect(small.height).toBeGreaterThanOrEqual(44);
  expect(large.height).toBeGreaterThanOrEqual(44);
  // The box may grow a little because the LABEL inside it did; it must not double.
  expect(large.height, "the button doubled with the text").toBeLessThan(small.height * 1.6);
});
