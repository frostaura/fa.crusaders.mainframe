import type { Page } from "@playwright/test";
import { MEMBER_CODE, SESSION_ANON, memberCodeSecretB64, serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { BOOKING, detailFixture, memberShellRoutes } from "./playersKit";
import { DETAIL_ACTIONS, DETAIL_COPY } from "../src/lib/playersCopy";
import { HEIGHT, WIDTHS, bigText, box, fontsReady, sideways, textOffScreen, widthUsed, type Width } from "./layoutKit";

/**
 * The member screens' form-factor layouts (R4, SPEC 3), measured in Chromium at
 * 390/768/1024/1280/1920 and at 390 with 200 % text: each screen uses the width it has instead of
 * centring a phone column on a desktop, and stays 100 % usable on a phone.
 *
 * <p>
 * The width sweep runs on the desktop project only (it sets its own viewport); the phone checks
 * run on both projects.
 * </p>
 */
const SESSION_MEMBER = { ...SESSION_ANON, user_id: "00000000-0000-0000-0000-000000000009", is_authenticated: true };
const PROFILE = { user_id: SESSION_MEMBER.user_id, email: "nomsa@club.test", full_name: "Nomsa Khumalo", photo_url: null, status: "active", is_admin: false, tenant_slug: "crusaders", membership_number: "M-1" };

function baseRoutes(): ApiRoute[] {
  return [
    { path: "/api/v1/whoami", body: SESSION_MEMBER },
    { path: "/api/v1/wallet", body: { balance_credits: 500, entries: [], total_entries: 0, offset: 0, limit: 50 } },
    { path: "/api/v1/me/profile", body: PROFILE },
    { path: "/api/v1/me/preferences", body: {} },
    { path: "/api/v1/webauthn/credentials", body: [] },
  ];
}

function myCodeRoutes(): ApiRoute[] {
  return [
    ...baseRoutes(),
    {
      method: "POST", path: "/api/v1/me/code/enrol",
      respond: () => ({ v: 1, ref: MEMBER_CODE.ref, generation: 1, secret: memberCodeSecretB64(), tz: MEMBER_CODE.tz, step_seconds: 30, server_time_ms: Date.now() }),
    },
    { path: "/api/v1/me/code", respond: () => ({ v: 1, ref: MEMBER_CODE.ref, generation: 1, tz: MEMBER_CODE.tz, server_time_ms: Date.now() }) },
    { path: "/api/v1/me/door", body: { doors: false, doors_shut: "none", timezone: "Africa/Johannesburg", policy: "active_member", membership: "active", membership_detail: "active", is_club_admin: false, next_booking: null, early_entry_minutes: null, roster_max_entries: 48, contact: { phone: "021 555 0134", email: null }, door_log_retention_days: 90, last_decision: null } },
  ];
}

async function open(page: Page, path: string, routes: ApiRoute[], width: Width) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width, height: HEIGHT[width] });
  await signIn(page);
  await serveApi(page, routes);
  await page.goto(path);
  await fontsReady(page);
}

async function healthy(page: Page) {
  expect(await sideways(page), "nothing scrolls sideways").toBeLessThanOrEqual(0);
  expect(await textOffScreen(page), "no text paints off screen").toEqual([]);
}

test.describe("My Code (SPEC 3.2)", () => {
  for (const width of WIDTHS) {
    test(`${width}px: the pass first; beside the rest from a 60rem page; three columns from 72rem`, async ({ page }, info) => {
      test.skip(info.project.name !== "desktop", "one project sweeps the widths");
      await open(page, "/my-code", myCodeRoutes(), width);
      await expect(page.getByRole("article", { name: "Your member pass" })).toBeVisible();
      await healthy(page);
      const shell = (await box(page, "[data-page-shell]"))!;
      const inner = shell.width - (width >= 1800 ? 96 : width >= 1024 ? 64 : width >= 640 ? 48 : 32);
      const pass = (await box(page, "[data-my-code-pass]"))!;
      const rest = (await box(page, "[data-my-code-rest]"))!;
      const side = (await box(page, "[data-my-code-side]"))!;
      if (inner >= 60 * 16) {
        expect(rest.x, "the rest stands beside the pass").toBeGreaterThanOrEqual(pass.right);
        expect(Math.abs(rest.y - pass.y)).toBeLessThan(4);
        await expect(page.getByRole("group", { name: "Your wallet" })).toBeVisible();
      } else {
        expect(rest.y, "stacked under the pass").toBeGreaterThanOrEqual(pass.bottom);
        await expect(page.getByRole("group", { name: "Your wallet" })).toBeHidden();
      }
      if (inner >= 72 * 16) expect(side.y).toBeLessThan(rest.y + 4);
      if (width >= 1280) expect(await widthUsed(page)).toBeGreaterThanOrEqual(width >= 1800 ? 0.6 : 0.7);
    });
  }

  test("390 at 200 % text: one column, the pass on top, nothing off screen", async ({ page }) => {
    await open(page, "/my-code", myCodeRoutes(), 390);
    await expect(page.getByRole("article", { name: "Your member pass" })).toBeVisible();
    await bigText(page);
    await healthy(page);
    const pass = (await box(page, "[data-my-code-pass]"))!;
    const rest = (await box(page, "[data-my-code-rest]"))!;
    expect(rest.y).toBeGreaterThanOrEqual(pass.bottom);
  });
});

const ANON_ROUTES: ApiRoute[] = [
  { path: "/api/v1/whoami", body: SESSION_ANON },
  { path: "/api/v1/session", body: SESSION_ANON },
];

async function openAnon(page: Page, path: string, width: Width) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width, height: HEIGHT[width] });
  await serveApi(page, ANON_ROUTES);
  await page.goto(path);
  await fontsReady(page);
}

test.describe("Sign in and Join (SPEC 3.17)", () => {
  for (const width of WIDTHS) {
    for (const path of ["/login", "/register"]) {
      test(`${path} at ${width}px: the club beside the card from lg, the card alone below it`, async ({ page }, info) => {
        test.skip(info.project.name !== "desktop", "one project sweeps the widths");
        await openAnon(page, path, width);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await healthy(page);
        const brand = await box(page, "[data-auth-brand]");
        const card = (await box(page, "[data-auth-shell] > div:last-child"))!;
        if (width >= 1024) {
          expect(brand, "the brand panel stands beside the card").not.toBeNull();
          expect(card.x).toBeGreaterThanOrEqual(brand!.right);
          expect(await widthUsed(page)).toBeGreaterThanOrEqual(width >= 1800 ? 0.6 : 0.85);
        } else {
          expect(brand).toBeNull();
        }
        // Register from xl: the photo beside the fields, in the same order.
        if (path === "/register" && width >= 1280) {
          const photo = (await page.getByText("Photo of yourself").first().boundingBox())!;
          const name = (await page.getByLabel("Full name").boundingBox())!;
          expect(photo.x).toBeGreaterThan(name.x + name.width);
        }
      });
    }
  }

  test("390 at 200 % text: the card alone, nothing off screen", async ({ page }) => {
    await openAnon(page, "/register", 390);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await bigText(page);
    await healthy(page);
    expect(await box(page, "[data-auth-brand]")).toBeNull();
  });
});

test.describe("Home, signed out (SPEC 3.18)", () => {
  test("1920: the 120rem frame; league, the Open and the app's blocks share one row", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "a desktop width");
    await openAnon(page, "/", 1920);
    await expect(page.getByRole("heading", { name: "Crusaders Squash", level: 1 })).toBeVisible();
    await healthy(page);
    const league = (await box(page, 'section[aria-labelledby="league"]'))!;
    const app = (await box(page, 'section[aria-labelledby="mainframe"]'))!;
    expect(app.x).toBeGreaterThanOrEqual(league.right);
    expect(Math.abs(app.y - league.y)).toBeLessThan(4);
    expect(await widthUsed(page)).toBeGreaterThanOrEqual(0.9);
  });

  test("390 at 200 % text: one column, nothing off screen", async ({ page }) => {
    await openAnon(page, "/", 390);
    await expect(page.getByRole("heading", { name: "Crusaders Squash", level: 1 })).toBeVisible();
    await bigText(page);
    await healthy(page);
  });
});

const COURTS = [1, 2, 3, 4].map((n) => ({ id: `aaaaaaaa-0000-4000-8000-00000000000${n}`, courtNumber: n, name: `Court ${n}`, slicePriceCredits: 50 }));
const inDays = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const BOOK_DAY = inDays(2);

function game(n: number) {
  const start = new Date(`${inDays(3 + n)}T10:00:00Z`);
  return {
    booking_id: `bbbbbbbb-0000-4000-8000-00000000000${n}`, court_name: `Court ${n}`,
    starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 3_600_000).toISOString(),
    role: "organiser", status: "Confirmed", players: [], my_share_credits: 50, needs_action: false,
  };
}

function bookingsRoutes(): ApiRoute[] {
  return [
    ...baseRoutes(),
    {
      path: "/api/v1/schedule",
      body: {
        date: BOOK_DAY, timezone: "UTC", sliceMinutes: 15, dayStartMinute: 8 * 60, dayEndMinute: 20 * 60,
        advanceBookingDays: 14, penaltyPct: 30, penaltyWindowMinutes: 15, courts: COURTS, slots: [],
      },
    },
    { path: "/api/v1/me/bookings/upcoming", body: { timezone: "UTC", items: [game(1), game(2), game(3)] } },
    { path: "/api/v1/me/bookings/recent", body: { timezone: "UTC", items: [] } },
    { method: "POST", path: "/api/v1/wallet/stream-ticket", body: { ticket: "t", expires_in_seconds: 60 } },
  ];
}

async function openBookings(page: Page, width: Width) {
  await open(page, `/bookings?date=${BOOK_DAY}`, bookingsRoutes(), width);
  await page.waitForSelector('[role="grid"]');
  await expect(page.locator("[data-upcoming] li").first()).toBeVisible();
}

test.describe("Bookings (SPEC 3.1)", () => {
  for (const width of WIDTHS) {
    test(`${width}px: games strip on a phone, cards in rows, then a rail beside the grid from a 72rem page`, async ({ page }, info) => {
      test.skip(info.project.name !== "desktop", "one project sweeps the widths");
      await openBookings(page, width);
      await healthy(page);
      const host = (await box(page, "[data-with-aside]"))!;
      const rail = (await box(page, "aside[data-aside]"))!;
      const grid = (await box(page, '[role="grid"]'))!;
      const cards = await page.locator("[data-upcoming] li").evaluateAll((els) => els.map((el) => {
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), height: r.height };
      }));
      if (host.width >= 72 * 16) {
        expect(rail.x, "the rail stands beside the grid").toBeGreaterThanOrEqual(grid.right);
        expect(new Set(cards.map((c) => c.x)).size, "a vertical list in the rail").toBe(1);
        await expect(page.getByRole("group", { name: "Your wallet" })).toBeVisible();
        expect(await widthUsed(page)).toBeGreaterThanOrEqual(0.85);
      } else {
        expect(rail.bottom, "stacked: the games come first").toBeLessThanOrEqual(grid.y);
        await expect(page.getByRole("group", { name: "Your wallet" })).toBeHidden();
        if (host.width < 40 * 16) {
          expect(new Set(cards.map((c) => c.y)).size, "a sideways strip").toBe(1);
          for (const c of cards) expect(c.height).toBeLessThan(96);
        }
      }
      if (width >= 1800) {
        // Four courts are not stretched to 300px each: a court column stops at 18rem.
        const head = await page.locator('[role="columnheader"]').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width));
        for (const w of head) expect(w).toBeLessThanOrEqual(18 * 16 + 1);
      }
    });
  }

  test("390: the grid's first slot row is on the first screen, above the tab bar", async ({ page }) => {
    await openBookings(page, 390);
    const firstCell = (await page.locator('[role="grid"] [role="gridcell"]').first().boundingBox())!;
    const tabBar = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--app-bottom-bar-height")) || 0);
    expect(firstCell.y + firstCell.height).toBeLessThanOrEqual(844 - tabBar);
  });

  test("390 at 200 % text: nothing off screen, the strip still scrolls sideways inside itself", async ({ page }) => {
    await openBookings(page, 390);
    await bigText(page);
    await healthy(page);
  });
});

test.describe("Booking detail (SPEC 3.3)", () => {
  const twoSeats = () => {
    const d = detailFixture() as Record<string, unknown> & { players: unknown[] };
    return { ...d, players: d.players.slice(0, 2) };
  };
  async function openDetail(page: Page, width: Width) {
    await open(page, `/bookings/${BOOKING}`, [
      { path: `/api/v1/bookings/${BOOKING}`, body: twoSeats() },
      ...memberShellRoutes(),
    ], width);
    await expect(page.locator("[data-players-section]")).toBeVisible();
  }

  for (const width of WIDTHS) {
    test(`${width}px: players, money, the court; a money rail from xl; Invite in thumb reach on a phone`, async ({ page }, info) => {
      test.skip(info.project.name !== "desktop", "one project sweeps the widths");
      await openDetail(page, width);
      await healthy(page);
      const players = (await box(page, "[data-players-section]"))!;
      const money = (await box(page, "[data-detail-money]"))!;
      const court = (await box(page, "[data-detail-court]"))!;
      const docked = page.getByRole("region", { name: DETAIL_COPY.actionsLabel });
      if (width >= 1280) {
        expect(money.x, "money stands in a rail beside the players").toBeGreaterThanOrEqual(players.right);
        expect(court.y).toBeGreaterThanOrEqual(players.bottom);
        expect(court.right).toBeLessThanOrEqual(money.x);
      } else if (width >= 1024) {
        expect(court.x, "money beside the court column").toBeGreaterThanOrEqual(money.right);
      } else {
        expect(money.y).toBeGreaterThanOrEqual(players.bottom);
        expect(court.y).toBeGreaterThanOrEqual(money.bottom);
      }
      if (width >= 1024) {
        await expect(docked).toHaveCount(0);
        await expect(page.locator("[data-players-section]").getByRole("button", { name: DETAIL_ACTIONS.invite })).toBeVisible();
      } else {
        const button = docked.getByRole("button", { name: DETAIL_ACTIONS.invite });
        await expect(button).toBeVisible();
        const b = (await button.boundingBox())!;
        expect(b.y + b.height, "in thumb reach").toBeGreaterThan(HEIGHT[width] * 0.75);
        expect(b.height).toBeGreaterThanOrEqual(44);
        await expect(page.locator("[data-players-section]").getByRole("button", { name: DETAIL_ACTIONS.invite })).toHaveCount(0);
      }
    });
  }

  test("390 at 200 % text: nothing off screen, the docked Invite still in reach", async ({ page }) => {
    await openDetail(page, 390);
    await bigText(page);
    await healthy(page);
    await expect(page.getByRole("region", { name: DETAIL_COPY.actionsLabel }).getByRole("button", { name: DETAIL_ACTIONS.invite })).toBeVisible();
  });
});
