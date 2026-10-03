import type { Page } from "@playwright/test";
import { SESSION_ADMIN, serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { bigText, fontsReady, sideways } from "./layoutKit";
import { inviteFixture, memberShellRoutes } from "./playersKit";

/**
 * Review round 6 (lane FD1, shell and member layout) — what only a browser can measure: page
 * titles broken mid-word at 200 % text (L6-1 / X6-5), icons that stay 20px while the text doubles
 * (L6-16), and the rest of the round's member layout findings further down this file.
 */

test.describe.configure({ timeout: 120_000 });

const ARRIVES = { timeout: 20_000 };

const ADMIN_SHELL: ApiRoute[] = [
  { path: "/api/v1/whoami", body: SESSION_ADMIN },
  { path: "/api/v1/me/profile", body: { full_name: "Club Admin", email: "a@test.local", photo_url: null, membership_number: "A-1" } },
  { path: "/api/v1/wallet", body: { balance_minutes: 0, entries: [], total_entries: 0, offset: 0, limit: 10 } },
  { path: "/api/v1/admin/monitoring/summary", body: { open: {} } },
];

async function openAdmin(page: Page, path: string, routes: ApiRoute[], width: number, height = 900) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width, height });
  await signIn(page);
  await page.addInitScript(() => window.localStorage.setItem("crusaders:settings-intro-dismissed", "1"));
  await serveApi(page, [...ADMIN_SHELL, ...routes]);
  await page.goto(path);
}

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

test.describe("L6-1 / X6-5 — a page title is never broken mid-word to keep its actions beside it", () => {
  test.beforeEach(({ browserName }, info) => { void browserName; test.skip(info.project.name !== "desktop", "widths are set per test"); });

  test("Repeating bookings at 768 / 200 %: the create button drops under the title", async ({ page }) => {
    await openAdmin(page, "/admin/schedules", [{ path: "/api/v1/admin/schedules", body: { schedules: [], timezone: "Africa/Johannesburg" } }], 768);
    await expect(page.getByRole("button", { name: /Create a repeating booking/ })).toBeVisible(ARRIVES);
    await bigText(page);
    await fontsReady(page);
    expect(await brokenWords(page), "was \"Repe / ating / booki / ngs\"").toEqual([]);
    expect(await sideways(page)).toBeLessThanOrEqual(1);
  });

  test("Transactions at 1280 / 200 %: the title keeps its word whole beside the rail", async ({ page }) => {
    await openAdmin(page, "/admin/ledger?from=2026-01-01&to=2026-01-31", [{ path: "/api/v1/admin/ledger/", body: [] }], 1280);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible(ARRIVES);
    await bigText(page);
    await fontsReady(page);
    expect(await brokenWords(page), "was \"Transactio / ns\"").toEqual([]);
  });

  test("at 100 % the actions still stand beside the title on one row", async ({ page }) => {
    await openAdmin(page, "/admin/schedules", [{ path: "/api/v1/admin/schedules", body: { schedules: [], timezone: "Africa/Johannesburg" } }], 1280);
    const button = page.getByRole("button", { name: /Create a repeating booking/ });
    await expect(button).toBeVisible(ARRIVES);
    const h1 = (await page.getByRole("heading", { level: 1 }).boundingBox())!;
    const action = (await button.boundingBox())!;
    expect(action.y, "beside the title, not under it").toBeLessThan(h1.y + h1.height);
    expect(action.x).toBeGreaterThan(h1.x + 200);
  });
});

/* ───────────────────────── the member's Bookings, mocked once for the rest of this file ───────────────────────── */

const COURTS = ["a", "b", "c", "d"].map((x, i) => ({ id: `aaaaaaaa-0000-4000-8000-00000000000${x}`, courtNumber: i + 1, name: `Court ${i + 1}` }));
const inDays = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const DAY = inDays(2);

function upcoming(n: number) {
  const start = new Date(`${inDays(3 + n)}T10:00:00Z`);
  return {
    booking_id: `bbbbbbbb-0000-4000-8000-00000000000${n}`, court_name: `Court ${n}`, starts_at: start.toISOString(),
    ends_at: new Date(start.getTime() + 3_600_000).toISOString(), role: "organiser", status: "Confirmed", players: [],
    my_share_minutes: 50, needs_action: false,
  };
}

async function openBookings(page: Page, width: number, height: number, options: { games?: number; invites?: number } = {}) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width, height });
  await signIn(page);
  const invites = Array.from({ length: options.invites ?? 0 }, (_, i) => inviteFixture({ invite_id: `i${i}`, participant_id: `p${i}` }));
  await serveApi(page, [
    { path: "/api/v1/schedule", body: { date: DAY, timezone: "UTC", sliceMinutes: 15, dayStartMinute: 480, dayEndMinute: 1200, advanceBookingDays: 14, penaltyPct: 30, penaltyWindowMinutes: 15, courts: COURTS, slots: [] } },
    { path: "/api/v1/me/bookings/upcoming", body: { timezone: "UTC", items: Array.from({ length: options.games ?? 0 }, (_, i) => upcoming(i + 1)) } },
    { path: "/api/v1/me/bookings/recent", body: { timezone: "UTC", items: [] } },
    ...memberShellRoutes({ invites }),
  ]);
  await page.goto(`/bookings?date=${DAY}`);
  await page.waitForSelector('[role="grid"] button[aria-label^="Book "]', ARRIVES);
}

const iconWidth = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate((el) => el.querySelector("svg")!.getBoundingClientRect().width);

test.describe("L6-16 — icons grow with the text", () => {
  test.beforeEach(({ browserName }, info) => { void browserName; test.skip(info.project.name !== "desktop", "widths are set per test"); });

  test("390 / 200 %: the refresh and the dialog's × are drawn at twice their size, in a target that holds them", async ({ page }) => {
    await openBookings(page, 390, 844);
    expect(await iconWidth(page, "[data-page-actions] button:last-child"), "20px at 100 %, as before").toBe(20);
    await bigText(page);
    const refresh = page.locator("[data-page-actions] button").last();
    expect(await iconWidth(page, "[data-page-actions] button:last-child"), "stayed 20px at a 32px root").toBeGreaterThanOrEqual(36);
    const box = (await refresh.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(56);
    await page.locator('[role="grid"] button[aria-label^="Book "]').first().click();
    const close = page.locator("[data-slot=dialog-close]");
    await expect(close).toBeVisible();
    expect(await iconWidth(page, "[data-slot=dialog-close]")).toBeGreaterThanOrEqual(36);
  });
});

/* ───────────────────────────────────────── Invites ───────────────────────────────────────── */

async function openInvites(page: Page, width: number, height: number, count: number) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width, height });
  await signIn(page);
  const invites = Array.from({ length: count }, (_, i) => inviteFixture({ participant_id: `p000000${i}-0000-0000-0000-000000000003`, organiser: { name: "Paul Abernathy-Wolstenholme", photo_url: null } }));
  await serveApi(page, memberShellRoutes({ invites }));
  await page.goto("/bookings/invites");
  await expect(page.locator("[data-invite]").first()).toBeVisible(ARRIVES);
}

test.describe("L6-4 / L6-13 — invite cards", () => {
  test.beforeEach(({ browserName }, info) => { void browserName; test.skip(info.project.name !== "desktop", "widths are set per test"); });

  test("320 / 200 %: the card's words stack under the avatar instead of an 80px column", async ({ page }) => {
    await openInvites(page, 320, 700, 2);
    await bigText(page);
    await fontsReady(page);
    const card = page.locator("[data-invite]").first();
    const text = await card.evaluate((el) => {
      const body = el.querySelector(":scope > span:last-child") as HTMLElement;
      return { width: body.getBoundingClientRect().width, card: el.getBoundingClientRect().width };
    });
    expect(text.width, "was ~80px beside the avatar").toBeGreaterThanOrEqual(text.card - 8);
    expect(await sideways(page)).toBeLessThanOrEqual(1);
  });

  test("390 at 100 %: the avatar still stands beside the words", async ({ page }) => {
    await openInvites(page, 390, 844, 2);
    const card = page.locator("[data-invite]").first();
    const sideBySide = await card.evaluate((el) => {
      const avatar = el.firstElementChild!.getBoundingClientRect();
      const body = (el.querySelector(":scope > span:last-child") as HTMLElement).getBoundingClientRect();
      return Math.abs(avatar.top - body.top) < 4 && body.left > avatar.right;
    });
    expect(sideBySide).toBe(true);
  });

  test("390, one invite: one primary answer on the screen — the docked one", async ({ page }) => {
    await openInvites(page, 390, 844, 1);
    const docked = page.locator("[data-context-bar] button, [data-context-bar] a");
    await expect(docked.first()).toBeVisible();
    // Was the card's own Accept AND a docked "Answer this invite": two primaries for one question.
    const primaries = await page.locator("button:visible").evaluateAll((els) =>
      els.filter((el) => el.closest("[data-invite-actions], [data-context-bar]") && /(^|\s)bg-primary(\s|$)/.test(el.className)).length);
    expect(primaries).toBe(1);
    await expect(page.locator("[data-invite-actions]")).toHaveCount(0);
  });
});
