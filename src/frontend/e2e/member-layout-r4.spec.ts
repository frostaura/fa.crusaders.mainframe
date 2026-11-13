import type { Page } from "@playwright/test";
import { MEMBER_CODE, SESSION_ANON, memberCodeSecretB64, serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { BOOKING, detailFixture, inviteFixture, memberShellRoutes } from "./playersKit";
import { myPlayFixture } from "./playKit";
import { DETAIL_ACTIONS, DETAIL_COPY, INVITES_COPY } from "../src/lib/playersCopy";
import { WALLET_LAYOUT } from "../src/lib/walletCopy";
import { SPLIT_PANE_COPY } from "../src/lib/inboxCopy";
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
    { path: "/api/v1/wallet", body: { balance_minutes: 500, entries: [], total_entries: 0, offset: 0, limit: 50 } },
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
    role: "organiser", status: "Confirmed", players: [], my_share_minutes: 50, needs_action: false,
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
    // The rail went (0c8fdc0): the games drift in a ticker above the grid, which owns the page's
    // width, and their detail — what the member can spend, the games in full — lies under it.
    test(`${width}px: the ticker above the grid, the games detail under it, cards in rows by its width`, async ({ page }, info) => {
      test.skip(info.project.name !== "desktop", "one project sweeps the widths");
      await openBookings(page, width);
      await healthy(page);
      const ticker = (await box(page, "[data-upcoming-ticker]"))!;
      // The scroller, not the grid: the grid is the full day, scrolled inside it.
      const grid = (await box(page, "[data-grid-scroller]"))!;
      const games = (await box(page, "[data-upcoming]"))!;
      expect(ticker.bottom, "the ticker sits above the grid").toBeLessThanOrEqual(grid.y);
      expect(games.y, "the games detail lies under the grid").toBeGreaterThanOrEqual(grid.bottom);
      await expect(page.getByRole("group", { name: "Your wallet" })).toBeVisible();
      const room = await page.locator("[data-upcoming]").evaluate((el) => el.parentElement!.getBoundingClientRect().width);
      const cards = await page.locator("[data-upcoming] li").evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().x)));
      const columns = room < 40 * 16 ? 1 : room < 56 * 16 ? 2 : 3;
      expect(new Set(cards).size, `cards a row at a ${Math.round(room)}px detail`).toBe(Math.min(columns, cards.length));
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

test.describe("Wallet and Wallet activity (SPEC 3.4)", () => {
  const LEDGER = Array.from({ length: 6 }, (_, i) => ({
    id: `e000000${i}`, at: new Date(Date.now() - i * 86_400_000).toISOString(), from: i % 2 ? "Nomsa" : "Club treasury",
    to: i % 2 ? "Club treasury" : "Nomsa", amountMinutes: i % 2 ? 50 : 100, signedAmountMinutes: i % 2 ? -50 : 100,
    type: i % 2 ? "BookingCharge" : "TopUp", comment: i % 2 ? "Booking Court 1" : "", subjectUserId: SESSION_MEMBER.user_id,
    subjectName: "Nomsa", actorUserId: SESSION_MEMBER.user_id, actorName: "Nomsa", relatedBookingId: null,
  }));
  const walletRoutes = (): ApiRoute[] => [
    ...memberShellRoutes({ wallet: { balance_minutes: 300, held_minutes: 0, spendable_minutes: 300, entries: LEDGER, total_entries: LEDGER.length, limit: 50 } }),
  ];
  const day = (n: number) => ({ date: inDays(-n), top_ups_minutes: 0, spent_minutes: 50, refunds_minutes: 0, bookings: 1, attended: 1, minutes_on_court: 45, balance_minutes: 300 });
  const activityRoutes = (): ApiRoute[] => [
    ...walletRoutes(),
    { path: "/api/v1/reports/me/wallet", body: {
      from: inDays(-30), to: inDays(0), top_ups_minutes: 300, spent_minutes: 150, refunds_minutes: 0, penalties_minutes: 0,
      adjustments_minutes: 0, reversals_minutes: 0, net_movement_minutes: 150, penalty_count: 0, attended_bookings: 3,
      bookings: 3, minutes_on_court: 135, count: 6,
    } },
    { path: "/api/v1/reports/me/daily", body: [day(3), day(2), day(1)] },
  ];

  for (const width of WIDTHS) {
    test(`${width}px: the balance rail beside the ledger from a 64rem page; Buy minutes in thumb reach below lg`, async ({ page }, info) => {
      test.skip(info.project.name !== "desktop", "one project sweeps the widths");
      await open(page, "/wallet", walletRoutes(), width);
      const rail = page.getByRole("complementary", { name: WALLET_LAYOUT.railLabel });
      await expect(rail).toBeVisible();
      await healthy(page);
      const r = (await rail.boundingBox())!;
      const ledger = (await box(page, "[data-aside-main]"))!;
      if (width >= 1280) {
        expect(ledger.x, "the ledger beside the balance").toBeGreaterThanOrEqual(r.x + r.width);
        await expect(rail.getByRole("link", { name: /^Buy minutes/ })).toBeVisible();
      } else {
        expect(ledger.y).toBeGreaterThanOrEqual(r.y + r.height);
      }
      const docked = page.getByRole("region", { name: WALLET_LAYOUT.actionsLabel });
      if (width < 1024) {
        const b = (await docked.getByRole("link", { name: /^Buy minutes/ }).boundingBox())!;
        expect(b.y + b.height).toBeGreaterThan(HEIGHT[width] * 0.75);
        await expect(rail.getByRole("link", { name: /^Buy minutes/ })).toHaveCount(0);
      } else {
        await expect(docked).toHaveCount(0);
      }
    });
  }

  test("activity at 1280: three charts in one row, the range sticky", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "a desktop width");
    await open(page, "/wallet/activity", activityRoutes(), 1280);
    const charts = page.locator("[data-charts-grid] > *");
    await expect(charts).toHaveCount(3);
    const ys = await charts.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().y)));
    expect(new Set(ys).size).toBe(1);
    expect(await page.locator("[data-range-bar]").evaluate((el) => getComputedStyle(el).position)).toBe("sticky");
    await healthy(page);
  });

  test("390 at 200 % text: the wallet and its activity, nothing off screen", async ({ page }) => {
    await open(page, "/wallet", walletRoutes(), 390);
    await expect(page.getByRole("complementary", { name: WALLET_LAYOUT.railLabel })).toBeVisible();
    await bigText(page);
    await healthy(page);
  });

  test("390 at 200 % text: the activity's totals fall to one column rather than off the screen", async ({ page }) => {
    await open(page, "/wallet/activity", activityRoutes(), 390);
    await expect(page.getByText("Net movement over this period", { exact: false })).toBeVisible();
    await bigText(page);
    await healthy(page);
  });
});

test.describe("Invites (SPEC 3.5)", () => {
  const second = () => inviteFixture({ participant_id: "p0000000-0000-0000-0000-000000000009", court_name: "Court 2" });
  const routes = (invites: unknown[]) => memberShellRoutes({ invites });

  for (const width of WIDTHS) {
    test(`${width}px: the list beside the picked invite from lg; the sheet on a phone`, async ({ page }, info) => {
      test.skip(info.project.name !== "desktop", "one project sweeps the widths");
      await open(page, "/bookings/invites", routes([inviteFixture(), second()]), width);
      const list = page.getByRole("list", { name: INVITES_COPY.listLabel });
      await expect(list).toBeVisible();
      await healthy(page);
      const cards = list.locator("[data-invite]");
      if (width >= 1024) {
        await expect(page.getByText(INVITES_COPY.pickTitle)).toBeVisible();
        await cards.nth(1).click();
        await expect(page).toHaveURL(/seat=p0000000-0000-0000-0000-000000000009/);
        // The pane draws after the URL moves (its read answers first): measure it once it is there.
        await expect(page.locator("[data-invite-detail]")).toBeVisible();
        const pane = (await box(page, "[data-invite-detail]"))!;
        const l = (await list.boundingBox())!;
        expect(pane.x).toBeGreaterThanOrEqual(l.x + l.width);
        await expect(cards.nth(1)).toHaveAttribute("aria-current", "true");
        await expect(page.getByRole("dialog")).toHaveCount(0);
        // Up/Down walk the list.
        await cards.nth(1).focus();
        await page.keyboard.press("ArrowUp");
        await expect(cards.nth(0)).toBeFocused();
      } else {
        await cards.first().click();
        await expect(page.getByRole("dialog")).toBeVisible();
        expect(await box(page, "[data-invite-detail]")).toBeNull();
      }
    });
  }

  test("one invite: opened in the pane at 1280, docked in thumb reach at 390", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "two widths, one project");
    await open(page, "/bookings/invites", routes([inviteFixture()]), 1280);
    await expect(page.locator("[data-invite-detail]")).toBeVisible();
    await expect(page.getByRole("region", { name: INVITES_COPY.actionsLabel })).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    // R6 L6-13 — the dock carries the invite's own answers (the card then carries none).
    const docked = page.getByRole("region", { name: INVITES_COPY.actionsLabel }).getByRole("button", { name: SPLIT_PANE_COPY.cardAccept });
    await expect(docked).toBeVisible();
    const b = (await docked.boundingBox())!;
    expect(b.y + b.height).toBeGreaterThan(844 * 0.75);
    await docked.click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });

  test("390 at 200 % text: nothing off screen", async ({ page }) => {
    await open(page, "/bookings/invites", routes([inviteFixture(), second()]), 390);
    await expect(page.getByRole("list", { name: INVITES_COPY.listLabel })).toBeVisible();
    await bigText(page);
    await healthy(page);
  });
});

test.describe("Inbox (SPEC 3.6)", () => {
  const at = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
  const notices = [
    { id: "n1", kind: "players.share_moved", headline: "Sam paid you 25.00 credits", link: `/bookings/${BOOKING}`, booking_id: BOOKING, created_at: at(5), read_at: null },
    { id: "n2", kind: "players.response", headline: "Alex accepted — Court 1", link: `/bookings/${BOOKING}`, booking_id: BOOKING, created_at: at(9), read_at: null },
  ];
  const routes = (): ApiRoute[] => [
    { path: "/api/v1/me/notifications", body: { items: notices, unread_count: 2, next_cursor: null, timezone: "Africa/Johannesburg" } },
    { method: "POST", path: "/api/v1/me/notifications/", respond: ({ path }) => ({ id: path.split("/").at(-2), read: true }) },
    { path: `/api/v1/bookings/${BOOKING}`, body: detailFixture() },
    ...memberShellRoutes({ unread: 2 }),
  ];

  for (const width of WIDTHS) {
    test(`${width}px: from lg a notice opens its booking in place beside the list`, async ({ page }, info) => {
      test.skip(info.project.name !== "desktop", "one project sweeps the widths");
      await open(page, "/inbox", routes(), width);
      const list = page.getByRole("list", { name: "Your notifications" });
      await expect(list.getByRole("listitem")).toHaveCount(2);
      await healthy(page);
      const first = list.getByRole("link", { name: "Sam paid you 25.00 credits" });
      if (width >= 1024) {
        await first.click();
        await expect(page).toHaveURL(/\/inbox\?n=n1/);
        const panel = page.locator(`[data-booking-panel="${BOOKING}"]`);
        await expect(panel.getByRole("region", { name: "Money" })).toBeVisible();
        const l = (await list.boundingBox())!;
        const p = (await panel.boundingBox())!;
        expect(p.x).toBeGreaterThanOrEqual(l.x + l.width);
        expect(await page.getByRole("heading", { level: 1 }).count(), "one h1 on the page").toBe(1);
        await expect(panel.getByRole("link", { name: DETAIL_COPY.openPage })).toHaveAttribute("href", `/bookings/${BOOKING}`);
      } else {
        await first.click();
        await expect(page).toHaveURL(new RegExp(`/bookings/${BOOKING}$`));
      }
    });
  }

  test("390 at 200 % text: the list alone, nothing off screen", async ({ page }) => {
    await open(page, "/inbox", routes(), 390);
    await expect(page.getByRole("list", { name: "Your notifications" })).toBeVisible();
    await bigText(page);
    await healthy(page);
  });
});

test.describe("Profile (SPEC 3.7, §4.6)", () => {
  const routes = (): ApiRoute[] => [
    { path: "/api/v1/me/play", body: myPlayFixture() },
    { path: "/api/v1/me/webauthn/credentials", body: [] },
    { path: "/api/v1/me/preferences", body: { findable: false, show_in_leaderboards: false } },
    { path: "/api/v1/me/door/history", body: { items: [], next_cursor: null } },
    ...memberShellRoutes(),
  ];

  for (const width of WIDTHS) {
    test(`${width}px: My game in two columns from a 56rem card; the account cards in columns`, async ({ page }, info) => {
      test.skip(info.project.name !== "desktop", "one project sweeps the widths");
      await open(page, "/profile", routes(), width);
      await expect(page.locator('[data-my-game-part="stats"]')).toBeVisible();
      await healthy(page);
      const ring = (await box(page, '[data-my-game-part="ring"]'))!;
      const stats = (await box(page, '[data-my-game-part="stats"]'))!;
      const body = (await box(page, "[data-my-game-body]"))!;
      if (body.width >= 56 * 16) expect(stats.x, "stats beside the ring").toBeGreaterThanOrEqual(ring.right);
      else expect(stats.y).toBeGreaterThanOrEqual(ring.bottom);

      await page.getByRole("tab", { name: "Account" }).click();
      await expect(page).toHaveURL(/tab=account/);
      await expect(page.getByRole("region", { name: "Your details" })).toBeVisible();
      // The cards settle as their reads answer (skeletons first): poll the column count, not one frame.
      const columns = () => page.locator("[data-account-cards] > *")
        .evaluateAll((els) => new Set(els.map((el) => Math.round(el.getBoundingClientRect().x))).size);
      if (width >= 1280) await expect.poll(columns).toBeGreaterThanOrEqual(2);
      if (width < 768) await expect.poll(columns).toBe(1);
      await healthy(page);
    });
  }

  test("390: each tab is far shorter than the old 5,628px page", async ({ page }) => {
    await open(page, "/profile", routes(), 390);
    await expect(page.locator('[data-my-game-part="stats"]')).toBeVisible();
    const tall = () => page.locator("#main-content").evaluate((el) => el.scrollHeight);
    expect(await tall()).toBeLessThan(4000);
    await page.getByRole("tab", { name: "Account" }).click();
    await expect(page.getByRole("region", { name: "Your details" })).toBeVisible();
    expect(await tall()).toBeLessThan(4000);
  });

  test("390 at 200 % text: both tabs, nothing off screen", async ({ page }) => {
    await open(page, "/profile", routes(), 390);
    await expect(page.locator('[data-my-game-part="stats"]')).toBeVisible();
    await bigText(page);
    await healthy(page);
    await page.getByRole("tab", { name: "Account" }).click();
    await expect(page.getByRole("region", { name: "Your details" })).toBeVisible();
    await healthy(page);
  });
});

test("Profile at 390 with 200 % text: the account's switch skeletons stay on the phone while they are read", async ({ page }) => {
  await open(page, "/profile?tab=account", [
    { path: "/api/v1/me/webauthn/credentials", body: [] },
    { path: "/api/v1/me/door/history", body: { items: [], next_cursor: null } },
    ...memberShellRoutes(),
  ], 390);
  // The switches' read never answers: the skeleton is what is measured.
  await page.route("**/api/v1/me/preferences", () => undefined);
  await page.reload();
  await expect(page.getByRole("region", { name: "Privacy" })).toBeVisible();
  await bigText(page);
  await healthy(page);
});

test.describe("How it works (SPEC P3)", () => {
  for (const width of [390, 1280, 1920] as const) {
    test(`${width}px: the steps in rows of cards on a desktop, one column on a phone`, async ({ page }, info) => {
      test.skip(width !== 390 && info.project.name !== "desktop", "a desktop width");
      await open(page, "/how-it-works", memberShellRoutes(), width);
      const steps = page.locator("main ol > li");
      await expect(steps.first()).toBeVisible();
      await healthy(page);
      const ys = await steps.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().y)));
      const firstRow = ys.filter((y) => y === ys[0]).length;
      if (width >= 1280) expect(firstRow).toBe(3);
      else expect(firstRow).toBe(1);
    });
  }
});

test.describe("the app bar follows the page frame (SPEC 2.1)", () => {
  const adminRoutes = (): ApiRoute[] => [
    { path: "/api/v1/whoami", body: { ...SESSION_MEMBER, is_admin: true } },
    { path: "/api/v1/me/profile", body: { ...PROFILE, is_admin: true } },
    { path: "/api/v1/wallet", body: { balance_minutes: 0, entries: [], total_entries: 0, offset: 0, limit: 50 } },
    { path: "/api/v1/admin/members", body: [] },
    { path: "/api/v1/admin/doors", body: { doors: [], timezone: "Africa/Johannesburg", shut_all_at: null } },
    { path: "/api/v1/admin/courts/", body: [] },
  ];
  for (const width of [1280, 1920] as const) {
    test(`/admin at ${width}: the crest over the rail, the nav at the content's edge`, async ({ page }, info) => {
      test.skip(info.project.name !== "desktop", "a desktop width");
      await open(page, "/admin/courts", adminRoutes(), width);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      const crest = (await box(page, "[data-app-crest]"))!;
      const rail = (await box(page, "[data-admin-rail]"))!;
      const nav = (await page.locator("header nav li").first().boundingBox())!;
      const h1 = (await page.getByRole("heading", { level: 1 }).boundingBox())!;
      expect(crest.right, "the crest's box is the rail's width").toBeLessThanOrEqual(rail.right + 1);
      expect(Math.abs(nav.x - h1.x), "the nav starts where the content does").toBeLessThanOrEqual(2);
    });
  }

  test("a member page that widens at 3xl takes the bar with it", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "a desktop width");
    await open(page, `/bookings?date=${BOOK_DAY}`, bookingsRoutes(), 1920);
    await page.waitForSelector('[role="grid"]');
    const crest = (await box(page, "[data-app-crest]"))!;
    const h1 = (await page.getByRole("heading", { level: 1 }).boundingBox())!;
    expect(Math.abs(crest.x - h1.x)).toBeLessThanOrEqual(2);
  });
});
