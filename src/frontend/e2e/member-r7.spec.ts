import type { Page } from "@playwright/test";
import { serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { bigText, fontsReady, sideways } from "./layoutKit";
import { BOOKING, detailFixture, inviteFixture, memberShellRoutes } from "./playersKit";
import { myPlayFixture } from "./playKit";

/**
 * Review round 7 (lane FD1, member shell and bookings) — what only a browser can measure: where
 * the phone's Bookings grid opens (§4.2, Dean's call), and the round's member layout findings
 * further down this file.
 */

test.describe.configure({ timeout: 120_000 });

const COURTS = ["a", "b", "c", "d"].map((x, i) => ({
  id: `aaaaaaaa-0000-4000-8000-00000000000${x}`, courtNumber: i + 1, name: `Court ${i + 1}`,
}));

const inDays = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const DAY = inDays(2);

function wholeDay() {
  return {
    date: DAY, timezone: "UTC", sliceMinutes: 15, dayStartMinute: 8 * 60, dayEndMinute: 20 * 60,
    advanceBookingDays: 14, penaltyPct: 30, penaltyWindowMinutes: 15, courts: COURTS, slots: [],
  };
}

function game(n: number) {
  const start = new Date(`${inDays(3 + n)}T10:00:00Z`);
  return {
    booking_id: `bbbbbbbb-0000-4000-8000-00000000000${n}`, court_name: `Court ${n}`,
    starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 3_600_000).toISOString(),
    role: "organiser", status: "Confirmed", players: [], my_share_minutes: 50, needs_action: false,
  };
}

async function openBookings(page: Page, width: number, height: number, query = `?date=${DAY}`) {
  await page.setViewportSize({ width, height });
  await signIn(page);
  const routes: ApiRoute[] = [
    { path: "/api/v1/schedule", body: wholeDay() },
    { path: "/api/v1/me/bookings/upcoming", body: { timezone: "UTC", items: [game(1), game(2), game(3)] } },
    { path: "/api/v1/me/bookings/recent", body: { timezone: "UTC", items: [] } },
    ...memberShellRoutes({ invites: [inviteFixture({ invite_id: "i0" }), inviteFixture({ invite_id: "i1" })] }),
  ];
  await serveApi(page, routes);
  await page.goto(`/bookings${query}`);
  await page.waitForSelector('[role="grid"] button[aria-label^="Book "]');
  // The page settles: the opening scroll runs on the frame after the grid draws.
  await page.waitForTimeout(300);
}

const FIRST_BOOK = '[role="grid"] button[aria-label^="Book "]';
const firstBookTop = (page: Page) => page.locator(FIRST_BOOK).first().evaluate((el) => el.getBoundingClientRect().top);
const mainScrollTop = (page: Page) => page.evaluate(() => document.querySelector("main")!.scrollTop);

test.describe("§4.2 — on a phone Bookings opens with the first bookable row in view", () => {
  test.beforeEach(({ browserName }, info) => { void browserName; test.skip(info.project.name !== "desktop", "widths are set per test"); });

  test("at 390 the first Book cell is in the top part of the screen, nothing above it removed", async ({ page }) => {
    await openBookings(page, 390, 844);
    const top = await firstBookTop(page);
    test.info().annotations.push({ type: "first Book cell y at 390", description: String(Math.round(top)) });
    // Measured before (R6/R7): 555–759 with the games strip, picker and court chips above it.
    expect(top, "first Book cell's y at 390").toBeLessThanOrEqual(360);
    expect(top, "below the app bar and the week").toBeGreaterThan(56);
    // Nothing removed: the games strip and the invites link are still on the page, above.
    await expect(page.locator("[data-upcoming]")).toHaveCount(1);
    await expect(page.locator("[data-invites-badge]")).toHaveCount(1);
    // The week stays in view (it sticks), so the day on screen is never a mystery.
    const strip = await page.locator("[data-day-strip]").evaluate((el) => el.getBoundingClientRect());
    expect(strip.top).toBeGreaterThanOrEqual(0);
    expect(strip.bottom).toBeLessThanOrEqual(top);
  });

  test("without a date in the address the same holds (the club's today)", async ({ page }) => {
    await openBookings(page, 390, 844, "");
    expect(await firstBookTop(page)).toBeLessThanOrEqual(360);
  });

  test("a re-read never scrolls the page again: the member's own scroll is kept", async ({ page }) => {
    await openBookings(page, 390, 844);
    await page.evaluate(() => { document.querySelector("main")!.scrollTop = 0; });
    await page.getByRole("button", { name: /Refresh/ }).first().click();
    await page.waitForTimeout(400);
    expect(await mainScrollTop(page)).toBe(0);
  });

  test("a desktop opens at the top of the page", async ({ page }) => {
    await openBookings(page, 1280, 800);
    expect(await mainScrollTop(page)).toBe(0);
  });
});

/* ───────────────────────────── L7-12 — the 120rem frame at 3xl ───────────────────────────── */

async function openMember(page: Page, path: string, routes: ApiRoute[], width: number, height: number) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width, height });
  await signIn(page);
  await serveApi(page, [...routes, ...memberShellRoutes()]);
  await page.goto(path);
}

const shellShare = async (page: Page, width: number) => (await page.locator("[data-page-shell]").first().boundingBox())!.width / width;

test.describe("L7-12 — booking detail and How it works take the 120rem frame from 3xl", () => {
  test.beforeEach(({ browserName }, info) => { void browserName; test.skip(info.project.name !== "desktop", "widths are set per test"); });

  test("a booking's page at 1920 uses the window (was 1280px, 62 %)", async ({ page }) => {
    await openMember(page, `/bookings/${BOOKING}`, [{ path: `/api/v1/bookings/${BOOKING}`, body: detailFixture() }], 1920, 1080);
    await expect(page.locator("[data-detail-layout]")).toBeVisible({ timeout: 20_000 });
    expect(await shellShare(page, 1920)).toBeGreaterThanOrEqual(0.9);
  });

  test("How it works at 1920 uses the window (was 62 %)", async ({ page }) => {
    await openMember(page, "/how-it-works", [], 1920, 1080);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 20_000 });
    expect(await shellShare(page, 1920)).toBeGreaterThanOrEqual(0.9);
  });

  test("at 1280 both keep their xl frame (80rem), not a stretched page", async ({ page }) => {
    await openMember(page, "/how-it-works", [], 1280, 800);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 20_000 });
    expect((await page.locator("[data-page-shell]").first().boundingBox())!.width).toBeLessThanOrEqual(1280);
  });
});

/* ───────────────────────────── L7-13 — the page title at large text ───────────────────────────── */

/** The words of the page's h1 that paint on more than one line — a word broken mid-word. */
async function brokenWords(page: Page): Promise<string[]> {
  return page.getByRole("heading", { level: 1 }).first().evaluate((h1) => {
    const out: string[] = [];
    const walker = document.createTreeWalker(h1, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? "";
      const re = /\S+/g;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        const range = document.createRange();
        range.setStart(node, m.index);
        range.setEnd(node, m.index + m[0].length);
        const tops = new Set(Array.from(range.getClientRects()).filter((r) => r.width > 0).map((r) => Math.round(r.top)));
        if (tops.size > 1) out.push(m[0]);
      }
    }
    return out;
  });
}

test.describe("L7-13 — a page title steps down at large text rather than break a word", () => {
  test.beforeEach(({ browserName }, info) => { void browserName; test.skip(info.project.name !== "desktop", "widths are set per test"); });

  test("Notifications at 320 / 200 % paints whole (was \"Notificatio / ns\")", async ({ page }) => {
    await openMember(page, "/inbox", [{ path: "/api/v1/me/notifications", body: { items: [], next_cursor: null, unread_count: 0 } }], 320, 700);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 20_000 });
    await bigText(page);
    await fontsReady(page);
    expect(await brokenWords(page)).toEqual([]);
    expect(await sideways(page)).toBeLessThanOrEqual(1);
  });

  test("at 100 % a phone keeps the full title size", async ({ page }) => {
    await openMember(page, "/inbox", [{ path: "/api/v1/me/notifications", body: { items: [], next_cursor: null, unread_count: 0 } }], 320, 700);
    const h1 = page.getByRole("heading", { level: 1 });
    await expect(h1).toBeVisible({ timeout: 20_000 });
    expect(await h1.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBe(24);
  });
});

/* ───────────────────────────── L7-5 / L6-16 — the injury pause and small icons at 200 % ───────────────────────────── */

const svgWidth = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate((el) => el.querySelector("svg")!.getBoundingClientRect().width);

test.describe("L7-5 — the injury pause's sentence takes the card's width at 320 / 200 %", () => {
  test.beforeEach(({ browserName }, info) => { void browserName; test.skip(info.project.name !== "desktop", "widths are set per test"); });

  test("the description is not a ~70px column beside the switch; the switch drops under it", async ({ page }) => {
    await openMember(page, "/profile", [{ path: "/api/v1/me/play", body: myPlayFixture() }], 320, 700);
    const pause = page.locator("[data-pause]");
    await expect(pause).toBeVisible({ timeout: 20_000 });
    await bigText(page);
    await fontsReady(page);
    const m = await pause.evaluate((el) => {
      const desc = el.querySelector("[data-slot=field-description]") ?? el.querySelector("p");
      return { desc: desc!.getBoundingClientRect().width, card: el.getBoundingClientRect().width };
    });
    expect(m.desc, "was ~70px").toBeGreaterThanOrEqual(m.card * 0.9);
    expect(await sideways(page)).toBeLessThanOrEqual(1);
  });

  test("390 at 100 %: the switch still stands beside the words", async ({ page }) => {
    await openMember(page, "/profile", [{ path: "/api/v1/me/play", body: myPlayFixture() }], 390, 844);
    const pause = page.locator("[data-pause]");
    await expect(pause).toBeVisible({ timeout: 20_000 });
    const beside = await pause.evaluate((el) => {
      const sw = el.querySelector('[role="switch"]')!.getBoundingClientRect();
      const label = el.querySelector("label")!.getBoundingClientRect();
      return sw.left > label.left + 100 && sw.top < label.bottom + 40;
    });
    expect(beside).toBe(true);
  });

  test("L6-16 — the pause's icon grows with its words", async ({ page }) => {
    await openMember(page, "/profile", [{ path: "/api/v1/me/play", body: myPlayFixture() }], 390, 844);
    await expect(page.locator("[data-pause]")).toBeVisible({ timeout: 20_000 });
    expect(await svgWidth(page, "[data-pause] label")).toBe(16);
    await bigText(page);
    expect(await svgWidth(page, "[data-pause] label"), "stayed 16px at a 32px root").toBeGreaterThanOrEqual(28);
  });
});

test.describe("L6-16 — the Bookings date controls' icons grow with the text", () => {
  test.beforeEach(({ browserName }, info) => { void browserName; test.skip(info.project.name !== "desktop", "widths are set per test"); });

  test("390 / 200 %: the calendar and the week arrows are drawn at twice their size", async ({ page }) => {
    await openBookings(page, 390, 844);
    const calendar = "[data-day-strip] button[aria-label^='Jump to a date']";
    expect(await svgWidth(page, calendar)).toBe(16);
    await bigText(page);
    expect(await svgWidth(page, calendar), "stayed 16px").toBeGreaterThanOrEqual(28);
    expect(await svgWidth(page, "button[aria-label='Next week']"), "stayed 20px").toBeGreaterThanOrEqual(36);
    expect(await sideways(page)).toBeLessThanOrEqual(1);
  });
});
