import type { Page } from "@playwright/test";
import { serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { BOOKINGS_COPY } from "../src/lib/bookingsCopy";
import { inviteFixture, memberShellRoutes } from "./playersKit";

/**
 * Review round 5 on the Bookings screen (lane C), where only a browser can tell: the grid's
 * place on a 390 phone (§4.2), the 1920 frame (F5-6), the floating selection bar's centre
 * (V5-10), sideways scroll at 320/200 % (X5-11) and the invites link's target (X5-12).
 */

const COURTS = ["a", "b", "c", "d"].map((x, i) => ({
  id: `aaaaaaaa-0000-4000-8000-00000000000${x}`, courtNumber: i + 1, name: `Court ${i + 1}`, slicePriceCredits: 50,
}));

const inDays = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const DAY = inDays(2);

function wholeDay(courts = COURTS) {
  return {
    date: DAY, timezone: "UTC", sliceMinutes: 15, dayStartMinute: 8 * 60, dayEndMinute: 20 * 60,
    advanceBookingDays: 14, penaltyPct: 30, penaltyWindowMinutes: 15, courts, slots: [],
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

async function open(page: Page, options: { invites?: number; games?: number; recent?: number; bigText?: boolean; courts?: typeof COURTS } = {}) {
  await signIn(page);
  const invites = Array.from({ length: options.invites ?? 0 }, (_, i) => inviteFixture({ invite_id: `i${i}` }));
  const routes: ApiRoute[] = [
    { path: "/api/v1/schedule", body: wholeDay(options.courts) },
    { path: "/api/v1/me/bookings/upcoming", body: { timezone: "UTC", items: Array.from({ length: options.games ?? 0 }, (_, i) => game(i + 1)) } },
    { path: "/api/v1/me/bookings/recent", body: { timezone: "UTC", items: Array.from({ length: options.recent ?? 0 }, (_, i) => ({ ...game(i + 5), starts_at: new Date(Date.now() - (i + 1) * 86_400_000).toISOString(), ends_at: new Date(Date.now() - (i + 1) * 86_400_000 + 3_600_000).toISOString(), result_status: "none", can_record: false })) } },
    ...memberShellRoutes({ invites }),
  ];
  await serveApi(page, routes);
  await page.goto(`/bookings?date=${DAY}`);
  if (options.bigText) await page.addStyleTag({ content: "html { font-size: 32px; }" });
  await page.waitForSelector('[role="grid"] button[aria-label^="Book "]');
}

test.describe.configure({ timeout: 120_000 });

type Box = { left: number; right: number; top: number; bottom: number; height: number };
const box = (page: Page, selector: string) => page.locator(selector).first().evaluate((el) => {
  const r = el.getBoundingClientRect();
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height } as Box;
});
const FRAME = "[data-grid-scroller] >> xpath=..";

test.describe("one project sweeps the widths", () => {
  test.beforeEach(({ browserName }, info) => { void browserName; test.skip(info.project.name !== "desktop", "widths are set per test"); });

  test("V5-10 — at 1280 the selection bar centres on the grid, not the window", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(page, { invites: 3 });
    await page.getByRole("button", { name: BOOKINGS_COPY.selectOn }).click();
    const frame = await box(page, FRAME);
    const bar = await box(page, "[data-action-bar] [role=toolbar]");
    expect(Math.abs((bar.left + bar.right) / 2 - (frame.left + frame.right) / 2)).toBeLessThanOrEqual(2);
  });

  test("F5-6 — at 1920 the strip spans the grid and the rail stands beside it", async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await open(page, { invites: 3 });
    const frame = await box(page, FRAME);
    const strip = await box(page, "[data-week-strip]");
    const rail = await box(page, "aside[data-aside]");
    expect(Math.abs(strip.right - frame.right), "the week strip ends where the grid does").toBeLessThanOrEqual(2);
    // Was 1306 → 1484: ~180px of nothing between the grid and the rail.
    expect(rail.left - frame.right, "no dead gutter").toBeLessThanOrEqual(40);
  });

  test("X5-12 / X5-11 — the invites link is a 44px target and 320/200 % scrolls nothing sideways", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await open(page, { invites: 3, bigText: true });
    const link = await box(page, "[data-invites-badge]");
    expect(link.height).toBeGreaterThanOrEqual(44);
    const overflow = await page.evaluate(() => { const m = document.querySelector("main")!; return m.scrollWidth - m.clientWidth; });
    expect(overflow, "was 41px").toBeLessThanOrEqual(0);
  });

  test("§4.2 — at 390 the games, recent games and invites are one sideways row above the week", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, { invites: 3, games: 3, recent: 2 });
    await expect(page.locator("[data-recent] li").first()).toBeVisible();
    const upcoming = await box(page, "[data-upcoming]");
    const recent = await box(page, "[data-recent]");
    expect(Math.abs(recent.top - upcoming.top), "one row, not stacked sections").toBeLessThanOrEqual(1);
    const invites = await box(page, "[data-invites-badge]");
    expect(invites.top).toBeLessThan(upcoming.bottom);
    const first = await box(page, '[role="grid"] button[aria-label^="Book "]');
    // Was 722 with the sections stacked (SPEC 3.1's target is 360, which needs the sticky strip).
    expect(first.top).toBeLessThanOrEqual(560);
    const tabBar = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--app-bottom-bar-height")) || 0);
    expect(first.bottom + 3 * 52, "four slot rows on the first screen").toBeLessThanOrEqual(844 - tabBar);
  });
});

test.describe("§4.2 — the phone's week strip sticks", () => {
  test.beforeEach(({ browserName }, info) => { void browserName; test.skip(info.project.name !== "desktop", "widths are set per test"); });

  test("stays under the app bar while the grid is worked, and the grid's header is never behind it", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, { invites: 3, games: 3, recent: 2 });
    await expect(page.locator("[data-day-strip][data-sticks]")).toHaveCount(1);
    const chrome = await page.evaluate(() => document.querySelector("main")!.getBoundingClientRect().top);
    // Scroll the page to its end: the games go, the week stays, the court header sits under it.
    await page.evaluate(() => { const m = document.querySelector("main")!; m.scrollTop = m.scrollHeight; });
    await page.waitForTimeout(100);
    const strip = await box(page, "[data-day-strip]");
    expect(Math.abs(strip.top - chrome)).toBeLessThanOrEqual(1);
    const header = await box(page, '[role="columnheader"][data-court-col="0"]');
    expect(header.top, "the court header is below the strip, not under it").toBeGreaterThanOrEqual(strip.bottom - 1);
    const tabBar = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--app-bottom-bar-height")) || 0);
    const frame = await box(page, FRAME);
    expect(frame.bottom, "the grid's frame ends above the tab bar").toBeLessThanOrEqual(844 - tabBar + 1);
  });

  test("does not stick where it would take too much of a short phone at 200 % text", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await open(page, { bigText: true });
    await expect(page.locator("[data-day-strip]")).toHaveCount(1);
    await expect(page.locator("[data-day-strip][data-sticks]")).toHaveCount(0);
  });

  test("is not sticky beside a desktop grid", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(page);
    await expect(page.locator("[data-day-strip][data-sticks]")).toHaveCount(0);
  });
});
