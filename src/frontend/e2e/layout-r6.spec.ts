import type { Page } from "@playwright/test";
import { MEMBER_CODE, SESSION_ADMIN, memberCodeSecretB64, serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { bigText, fontsReady, sideways } from "./layoutKit";
import { inviteFixture, memberShellRoutes } from "./playersKit";
import { myPlayFixture, resultFixture } from "./playKit";

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

/* ───────────────────────────── the member frame at 1920 ───────────────────────────── */

test.describe("L6-10 — the app bar holds still between member pages at 1920", () => {
  test.beforeEach(({ browserName }, info) => { void browserName; test.skip(info.project.name !== "desktop", "widths are set per test"); });

  test("Bookings and Invites: the crest and the account button do not move, and Invites uses the width", async ({ page }) => {
    await openBookings(page, 1920, 1080, { invites: 2 });
    const crest = async () => (await page.locator("[data-app-crest]").boundingBox())!;
    const onBookings = await crest();
    await page.getByRole("link", { name: /invite/i }).first().click();
    await expect(page.locator("[data-invite]").first()).toBeVisible(ARRIVES);
    const onInvites = await crest();
    expect(Math.abs(onInvites.x - onBookings.x), "jumped 320px").toBeLessThanOrEqual(1);
    const shell = (await page.locator("[data-page-shell]").first().boundingBox())!;
    expect(shell.width / 1920, "an 80rem column in a 1920 window").toBeGreaterThanOrEqual(0.9);
  });
});

test.describe("Dean / L6 — My Code at 1920 uses the window", () => {
  test.beforeEach(({ browserName }, info) => { void browserName; test.skip(info.project.name !== "desktop", "widths are set per test"); });

  test("three filled columns: the pass, setting up, and the wallet with what happens next", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1920, height: 1080 });
    await signIn(page);
    const start = new Date(Date.now() + 3 * 3_600_000);
    const end = new Date(start.getTime() + 3_600_000);
    await serveApi(page, [
      { method: "POST", path: "/api/v1/me/code/enrol", respond: () => ({ v: 1, ref: MEMBER_CODE.ref, generation: 1, secret: memberCodeSecretB64(), tz: MEMBER_CODE.tz, step_seconds: 30, server_time_ms: Date.now() }) },
      { path: "/api/v1/me/code", respond: () => ({ v: 1, ref: MEMBER_CODE.ref, generation: 1, tz: MEMBER_CODE.tz, server_time_ms: Date.now() }) },
      {
        path: "/api/v1/me/door", body: {
          doors: false, doors_shut: "none", timezone: "Africa/Johannesburg", policy: "active_member", membership: "active", membership_detail: "active",
          is_club_admin: false, early_entry_minutes: null, roster_max_entries: 48, contact: { phone: "021 555 0134", email: null }, door_log_retention_days: 90, last_decision: null,
          next_booking: { starts_at: start.toISOString(), ends_at: end.toISOString(), court_number: 1, door_opens_at: start.toISOString(), door_closes_at: end.toISOString() },
        },
      },
      // After the door above: of two routes with one path, the first declared answers.
      ...memberShellRoutes(),
    ]);
    await page.goto("/my-code");
    await expect(page.getByRole("article", { name: "Your member pass" })).toBeVisible(ARRIVES);
    const next = page.getByRole("heading", { name: /what happens next/i });
    await expect(next).toBeVisible();
    await fontsReady(page);
    const shell = (await page.locator("[data-page-shell]").first().boundingBox())!;
    expect(shell.width / 1920, "an 80rem column: 61 % of the window").toBeGreaterThanOrEqual(0.9);
    const side = (await page.locator("[data-my-code-side]").boundingBox())!;
    const rest = (await page.locator("[data-my-code-rest]").boundingBox())!;
    // Was a 20rem column holding only "You can spend", beside a 1fr column holding everything else.
    expect(side.width / rest.width, "the side column is a real column").toBeGreaterThanOrEqual(0.45);
    expect(await next.evaluate((el) => Boolean(el.closest("[data-my-code-side]"))), "what happens next stands beside the setup").toBe(true);
  });
});

/* ───────────────────────────── Profile, My results, How it works ───────────────────────────── */

async function openMember(page: Page, path: string, routes: ApiRoute[], width: number, height: number) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width, height });
  await signIn(page);
  await serveApi(page, [...routes, ...memberShellRoutes()]);
  await page.goto(path);
}

test.describe("L6-18 / F5 / L6-17 — the member's own pages use the width without holes", () => {
  test.beforeEach(({ browserName }, info) => { void browserName; test.skip(info.project.name !== "desktop", "widths are set per test"); });

  test("Profile at 1920: each My game column stacks its own parts — no blank band", async ({ page }) => {
    await openMember(page, "/profile", [{ path: "/api/v1/me/play", body: myPlayFixture() }], 1920, 1080);
    await expect(page.locator('[data-my-game-part="badges"]')).toBeVisible(ARRIVES);
    await fontsReady(page);
    const gap = (above: string, below: string) => page.evaluate(([a, b]) => {
      const top = document.querySelector(`[data-my-game-part="${b}"]`)!.getBoundingClientRect().top;
      const bottom = document.querySelector(`[data-my-game-part="${a}"]`)!.getBoundingClientRect().bottom;
      return Math.round(top - bottom);
    }, [above, below]);
    // Was ~165px under the stats and ~110px above the celebrations, each column padded to the other's rows.
    expect(await gap("stats", "badges"), "under the stats").toBeLessThanOrEqual(40);
    expect(await gap("people", "celebrations"), "above the celebrations").toBeLessThanOrEqual(40);
    const shell = (await page.locator("[data-page-shell]").first().boundingBox())!;
    expect(shell.width / 1920).toBeGreaterThanOrEqual(0.9);
  });

  test("My results at 1280: the results use the page, not a 36rem column", async ({ page }) => {
    const rows = Array.from({ length: 6 }, (_, i) => ({ ...resultFixture({ result_id: `r${i}`, status: "confirmed" }), court_name: "Court 1", starts_at: new Date(Date.now() - (i + 1) * 86_400_000).toISOString() }));
    await openMember(page, "/profile/results", [
      { path: "/api/v1/me/play/results", body: { timezone: "Africa/Johannesburg", items: rows, next_cursor: null } },
      { path: "/api/v1/me/bookings/recent", body: { timezone: "UTC", items: [] } },
    ], 1280, 800);
    await expect(page.locator("[data-results] > li").first()).toBeVisible(ARRIVES);
    const shell = (await page.locator("[data-page-shell]").first().boundingBox())!;
    expect(shell.width / 1280, "was 40 % of the window").toBeGreaterThanOrEqual(0.9);
    const xs = await page.locator("[data-results] > li").evaluateAll((els) => new Set(els.map((el) => Math.round(el.getBoundingClientRect().x))).size);
    expect(xs, "the results in columns").toBeGreaterThanOrEqual(2);
  });

  for (const width of [1024, 1280, 1920] as const) {
    test(`How it works at ${width}: every row of steps is full and even`, async ({ page }) => {
      await openMember(page, "/how-it-works", [], width, 900);
      const steps = page.locator("main ol > li");
      await expect(steps.first()).toBeVisible(ARRIVES);
      await fontsReady(page);
      const shape = await page.locator("main ol").evaluate((ol) => {
        const box = ol.getBoundingClientRect();
        const items = Array.from(ol.children).map((li) => li.getBoundingClientRect());
        const rows = new Map<number, DOMRect[]>();
        for (const r of items) rows.set(Math.round(r.top), [...(rows.get(Math.round(r.top)) ?? []), r]);
        return Array.from(rows.values()).map((row) => ({
          right: Math.max(...row.map((r) => r.right)) - box.right,
          heights: row.map((r) => Math.round(r.height)),
        }));
      });
      // Was card 7 alone on its row at 1024, beside two empty tracks.
      for (const row of shape) {
        expect(Math.abs(row.right), "the row reaches the grid's right edge").toBeLessThanOrEqual(2);
        expect(Math.max(...row.heights) - Math.min(...row.heights), "cards in a row are one height").toBeLessThanOrEqual(1);
      }
    });
  }
});
