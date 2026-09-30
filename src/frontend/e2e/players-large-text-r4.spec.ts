import { type Page } from "@playwright/test";
import { serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { BOOKING, detailFixture, memberShellRoutes, seat } from "./playersKit";
import { myPlayFixture } from "./playKit";

/**
 * Review round 4 (V4-3, V4-4, X4-6) — the member's own screens at 200 % text on a phone, 390 and
 * 320 wide. Found: "Who's paid" names breaking mid-word beside their figures; inbox headlines
 * squeezed to ~110 px beside an 80 px icon tile; Profile's "Sessi/ons", "Celebratio/ns" and badge
 * names cut to "Twel/ve-…" by a two-line clamp.
 *
 * <p>
 * The probe reads TEXT, not element boxes (gotchas-frontend-layout: text overflowing its own box
 * is invisible to an element's rect): every word is a `Range`, and a word whose rects sit on two
 * lines broke mid-word; a rect past the viewport ran off the screen.
 * </p>
 */

const WIDTHS = [390, 320] as const;

async function open(page: Page, path: string, width: number, routes: ApiRoute[], bigText = true) {
  await page.setViewportSize({ width, height: 844 });
  await signIn(page);
  await serveApi(page, [...routes, ...memberShellRoutes({ unread: 2 })]);
  await page.goto(path);
  if (bigText) await page.addStyleTag({ content: "html { font-size: 32px; }" });
}

/** A viewport shot with `selector` scrolled to the top of the app's own scroller (`<main>`). */
async function shot(page: Page, selector: string, name: string) {
  await page.locator(selector).first().evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: test.info().outputPath(name) });
}

const PROFILE_ROUTES: ApiRoute[] = [
  { path: "/api/v1/me/play", body: myPlayFixture() },
  { path: "/api/v1/me/webauthn/credentials", body: [] },
  { path: "/api/v1/me/preferences", body: { findable: false, show_in_leaderboards: false } },
  { path: "/api/v1/me/door/history", body: { items: [], next_cursor: null } },
];

function inboxRoutes(): ApiRoute[] {
  const at = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  return [{ path: "/api/v1/me/notifications", body: { unread_count: 2, next_cursor: null, items: [
    { id: "n1", kind: "players.invited", headline: "Bongani asked you to play — Court 1, Wed 30 Sep, 18:00", link: "/bookings/b1", booking_id: "b1", created_at: at(5), read_at: null },
    { id: "n2", kind: "players.reminder", headline: "Your 25.00 cr share for Friday is still open", link: null, booking_id: "b2", created_at: at(90), read_at: null },
  ] } }];
}

/** Every word under `selector` that breaks across lines or runs past the viewport. */
async function brokenWords(page: Page, selector: string): Promise<string[]> {
  return page.locator(selector).first().evaluate((root) => {
    const out: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const host = node.parentElement;
      if (!host || host.closest(".sr-only") || host.getClientRects().length === 0) continue;
      const text = node.textContent ?? "";
      // A hyphen, a dash, a slash or a middot is a place a line may break; a letter is not.
      for (const m of text.matchAll(/[^\s\-–—/·]+/g)) {
        const range = document.createRange();
        range.setStart(node, m.index);
        range.setEnd(node, m.index + m[0].length);
        const rects = [...range.getClientRects()].filter((r) => r.width > 0);
        if (new Set(rects.map((r) => Math.round(r.top))).size > 1) out.push(`split: ${m[0]}`);
        if (rects.some((r) => r.right > window.innerWidth + 1 || r.left < -1)) out.push(`off-screen: ${m[0]}`);
      }
    }
    return out;
  });
}

/** Elements under `selector` whose text is clamped or cut rather than wrapped. */
async function clipped(page: Page, selector: string): Promise<string[]> {
  return page.locator(selector).evaluateAll((els) => els
    .filter((el) => {
      const style = getComputedStyle(el);
      return style.webkitLineClamp !== "none" || style.textOverflow === "ellipsis" || el.scrollHeight > el.clientHeight + 1;
    })
    .map((el) => el.textContent ?? ""));
}

const LONG_NAMES = detailFixture({
  split_mode: "amount",
  players: [
    seat({ name: "Nomsa Khumalo-Mthembu" }),
    seat({ participant_id: "p0000000-0000-0000-0000-000000000002", seat: 2, kind: "member", user_id: "u2", name: "Bongani Wilhelmina Oosthuizen",
      status: "accepted", consented_credits: 25, paid_credits: 25, target_credits: 25 }),
    seat({ participant_id: "p0000000-0000-0000-0000-000000000003", seat: 3, team: "B", kind: "member", user_id: "u3", name: "Alexandria Naidoo",
      status: "invited", unpaid_credits: 25 }),
  ],
});

for (const width of WIDTHS) {
  test.describe(`at ${width} px with 200 % text`, () => {
    test("the booking's money: every name and figure whole, nothing past the edge (V4-3)", async ({ page }) => {
      await open(page, `/bookings/${BOOKING}`, width, [{ path: `/api/v1/bookings/${BOOKING}`, body: LONG_NAMES }]);
      const money = page.locator("[data-money-panel]");
      await expect(money).toBeVisible();
      await money.scrollIntoViewIfNeeded();
      expect(await brokenWords(page, "[data-money-panel]")).toEqual([]);
      await shot(page, "[data-money-panel]", `money-${width}.png`);
    });

    test("an inbox row gives its headline the row's width, not what an icon tile leaves (V4-4)", async ({ page }) => {
      await open(page, "/inbox", width, inboxRoutes());
      const row = page.locator("[data-inbox-list] > li").first();
      await expect(row).toBeVisible();
      expect(await brokenWords(page, "[data-inbox-list]")).toEqual([]);
      const headline = await row.locator("a > span").nth(1).evaluate((el) => el.getBoundingClientRect().width);
      const li = await row.evaluate((el) => el.getBoundingClientRect().width);
      // Stacked under its icon at large text: the words get the row, less its padding.
      expect(headline / li, "share of the row the headline gets").toBeGreaterThan(0.7);
      await shot(page, "[data-inbox-list]", `inbox-${width}.png`);
    });

    test("Profile's stats, badges and the Celebrations switch keep their words whole (X4-6)", async ({ page }) => {
      await open(page, "/profile", width, PROFILE_ROUTES);
      const stats = page.locator("[data-stats]");
      await expect(stats).toBeVisible();
      expect(await brokenWords(page, "[data-stats]")).toEqual([]);
      expect(await brokenWords(page, "[data-badges]")).toEqual([]);
      expect(await clipped(page, "[data-badges] [data-badge-name]"), "a badge name is cut short").toEqual([]);
      const switchRow = page.locator("#celebrations-switch").locator("xpath=ancestor::*[@data-slot='field'][1]");
      expect(await brokenWords(page, "[data-celebrations]")).toEqual([]);
      await expect(switchRow).toBeVisible();
      await shot(page, "[data-stats]", `stats-${width}.png`);
      await shot(page, "[data-badges]", `badges-${width}.png`);
      await shot(page, "[data-celebrations]", `celebrations-${width}.png`);
    });
  });
}

test.describe("at 390 px with normal text, nothing gave up its row", () => {
  test("an inbox row keeps icon · words · caret on one line, and stats and badges keep two columns", async ({ page }) => {
    await open(page, "/inbox", 390, inboxRoutes(), false);
    const row = page.locator("[data-inbox-list] > li").first();
    await expect(row).toBeVisible();
    const tile = await row.locator("a > span").first().evaluate((el) => el.getBoundingClientRect().toJSON() as DOMRect);
    const words = await row.locator("a > span").nth(1).evaluate((el) => el.getBoundingClientRect().toJSON() as DOMRect);
    expect(tile.width, "the icon tile is whole").toBeGreaterThanOrEqual(39);
    expect(words.left, "the headline stands beside the icon").toBeGreaterThan(tile.right);
    expect(Math.abs(words.top - tile.top), "on the same line").toBeLessThan(4);
    await shot(page, "[data-inbox-list]", "inbox-390-normal.png");

    await open(page, "/profile", 390, PROFILE_ROUTES, false);
    await expect(page.locator("[data-stats]")).toBeVisible();
    const tops = await page.locator("[data-stats] [data-stat]").evaluateAll((els) => els.slice(0, 2).map((el) => el.getBoundingClientRect().top));
    expect(tops[0], "two stats side by side").toBe(tops[1]);
    const badgeTops = await page.locator("[data-badges] > li").evaluateAll((els) => els.slice(0, 2).map((el) => el.getBoundingClientRect().top));
    expect(badgeTops[0], "two badges side by side").toBe(badgeTops[1]);
    await shot(page, "[data-stats]", "profile-390-normal.png");
  });
});
