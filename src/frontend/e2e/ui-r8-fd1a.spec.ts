import type { Page } from "@playwright/test";
import { SESSION_ANON, serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { PASSWORD_TOGGLE } from "../src/lib/authCopy";
import { bigText, fontsReady } from "./layoutKit";
import { inviteFixture, memberShellRoutes } from "./playersKit";

/**
 * Review round 8 (lane FD1a — ui primitives, the dialog, the shell, the auth pages): what only a
 * browser can measure. Each block names its finding.
 */

test.describe.configure({ timeout: 120_000 });

const COURTS = ["a", "b", "c", "d"].map((x, i) => ({
  id: `aaaaaaaa-0000-4000-8000-00000000000${x}`, courtNumber: i + 1, name: `Court ${i + 1}`,
}));

const inDays = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const DAY = inDays(2);
const FIRST_BOOK = '[role="grid"] button[aria-label^="Book "]';

async function openBookings(page: Page, width: number, height: number) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width, height });
  await signIn(page);
  const routes: ApiRoute[] = [
    {
      path: "/api/v1/schedule",
      body: {
        date: DAY, timezone: "UTC", sliceMinutes: 15, dayStartMinute: 8 * 60, dayEndMinute: 20 * 60,
        advanceBookingDays: 14, penaltyPct: 30, penaltyWindowMinutes: 15, courts: COURTS, slots: [],
      },
    },
    { path: "/api/v1/me/bookings/upcoming", body: { timezone: "UTC", items: [] } },
    { path: "/api/v1/me/bookings/recent", body: { timezone: "UTC", items: [] } },
    ...memberShellRoutes({ invites: [inviteFixture({ invite_id: "i0" })] }),
  ];
  await serveApi(page, routes);
  await page.goto(`/bookings?date=${DAY}`);
  await page.waitForSelector(FIRST_BOOK);
  await page.waitForTimeout(300);
}

async function openBookSheet(page: Page, width: number, height: number, big: boolean) {
  await openBookings(page, width, height);
  if (big) await bigText(page);
  await fontsReady(page);
  await page.locator(FIRST_BOOK).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.waitForTimeout(400);
}

const rectOf = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height };
  });

/**
 * Whether the "more below" hint is drawn on the sheet's own opaque surface. R7 drew it as a fade
 * from the surface to transparent with the caret on top, so the caret painted over the last
 * visible line of the description; an opaque strip ends the visible text instead.
 */
async function hintIsOpaque(page: Page): Promise<boolean> {
  return page.locator("[data-slot=dialog-header] [data-more-below]").evaluate((el) => {
    const style = getComputedStyle(el);
    const alpha = style.backgroundColor.startsWith("rgba") ? Number(style.backgroundColor.split(",")[3].replace(")", "")) : 1;
    return style.backgroundImage === "none" && alpha === 1;
  });
}

/* ───────────────────────── L8-5 / L7-14 — a phone sheet at 320 × 640, 200 % text ───────────────────────── */

test.describe("L8-5 / L7-14 — the sheet's header never cuts its title, and the body keeps a usable height", () => {
  test.beforeEach(({ browserName }, info) => { void browserName; test.skip(info.project.name !== "desktop", "widths are set per test"); });

  test("320 × 640 / 200 %: the whole title shows, the body is at least 200px, the hint covers no words", async ({ page }) => {
    await openBookSheet(page, 320, 640, true);
    const header = await rectOf(page, "[data-slot=dialog-header]");
    const title = await rectOf(page, "[data-slot=dialog-title]");
    const body = await rectOf(page, "[data-slot=dialog-body]");
    test.info().annotations.push({ type: "geometry", description: JSON.stringify({ header, title, body }) });
    expect(title.top, "the title starts inside the header").toBeGreaterThanOrEqual(header.top);
    expect(title.bottom, "the header's cap cuts the title").toBeLessThanOrEqual(header.bottom + 0.5);
    // Was 164px: header 33dvh (211) + a 212px footer of a 589px sheet.
    expect(body.height, "the body is a sliver").toBeGreaterThanOrEqual(200);
    await expect(page.locator("[data-slot=dialog-header] [data-more-below]"), "the header is cut and says so").toBeVisible();
    // Was a fade + caret painted over the last visible line of the description.
    expect(await hintIsOpaque(page), "the caret paints over the words").toBe(true);
  });

  test("320 × 640 / 200 %: the description and stepper run the header's width, not a column clear of the × all the way down", async ({ page }) => {
    await openBookSheet(page, 320, 640, true);
    const header = await rectOf(page, "[data-slot=dialog-header]");
    const description = await rectOf(page, "[data-slot=dialog-description]");
    const close = await rectOf(page, "[data-slot=dialog-close]");
    // Clear of the × only beside it: the title row. Was 112px of right padding on every line.
    expect(header.right - description.right, "the description stops short of the header's edge").toBeLessThanOrEqual(24);
    expect(description.top, "the description starts under the ×").toBeGreaterThanOrEqual(close.bottom - 0.5);
  });

  test("390 × 844 at 100 %: a header that fits shows no hint and is not capped", async ({ page }) => {
    await openBookSheet(page, 390, 844, false);
    const scroll = await page.locator("[data-slot=dialog-header]").evaluate((el) => el.scrollHeight - el.clientHeight);
    expect(scroll).toBeLessThanOrEqual(1);
    await expect(page.locator("[data-slot=dialog-header] [data-more-below]")).toHaveCount(0);
    // The title's words still clear the ×.
    const words = await page.locator("[data-slot=dialog-title]").evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return Math.max(...Array.from(range.getClientRects()).map((r) => r.right));
    });
    const close = await rectOf(page, "[data-slot=dialog-close]");
    expect(words).toBeLessThanOrEqual(close.left);
  });
});

/* ───────────────────────── L8-12 — the Book dialog on a desktop ───────────────────────── */

test.describe("L8-12 — the Book dialog stays on the screen and opens centred", () => {
  test.beforeEach(({ browserName }, info) => { void browserName; test.skip(info.project.name !== "desktop", "widths are set per test"); });

  test("1280 × 800 / 200 %: the dialog is wholly inside the window (was 128–808)", async ({ page }) => {
    await openBookSheet(page, 1280, 800, true);
    const dialog = await rectOf(page, "[data-slot=dialog-content]");
    test.info().annotations.push({ type: "dialog", description: JSON.stringify(dialog) });
    expect(dialog.top).toBeGreaterThanOrEqual(0);
    expect(dialog.bottom).toBeLessThanOrEqual(800);
  });

  test("1280 × 800 at 100 %: it opens centred (was 64–565), and a step change keeps its top edge still (D12)", async ({ page }) => {
    await openBookSheet(page, 1280, 800, false);
    const first = await rectOf(page, "[data-slot=dialog-content]");
    test.info().annotations.push({ type: "dialog", description: JSON.stringify(first) });
    const above = first.top;
    const below = 800 - first.bottom;
    expect(Math.abs(above - below), "space above vs below").toBeLessThanOrEqual(4);
    await page.getByRole("dialog").getByRole("button", { name: "Continue" }).click();
    await page.waitForTimeout(500);
    const next = await rectOf(page, "[data-slot=dialog-content]");
    expect(Math.abs(next.top - first.top), "the top edge jumped on a step change").toBeLessThanOrEqual(1);
    expect(next.bottom).toBeLessThanOrEqual(800);
  });
});

/* ───────────────────────── L8-8 / L7-13 — words never break mid-word at 320 / 200 % ───────────────────────── */

/** Words under `selector` that paint on more than one line — broken mid-word. Long tokens (an address, a password hint) excepted. */
async function brokenWords(page: Page, selector: string): Promise<string[]> {
  return page.evaluate((sel) => {
    const out: string[] = [];
    for (const root of Array.from(document.querySelectorAll(sel))) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if ((node.parentElement as HTMLElement).closest(".sr-only,[aria-hidden=true]")) continue;
        const text = node.textContent ?? "";
        const re = /[A-Za-z][A-Za-z'’?.,]+/g;
        for (let m = re.exec(text); m; m = re.exec(text)) {
          const range = document.createRange();
          range.setStart(node, m.index);
          range.setEnd(node, m.index + m[0].length);
          const tops = new Set(Array.from(range.getClientRects()).filter((r) => r.width > 0.5).map((r) => Math.round(r.top)));
          if (tops.size > 1) out.push(m[0]);
        }
      }
    }
    return out;
  }, selector);
}

async function openPublic(page: Page, path: string, width: number) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width, height: 700 });
  await serveApi(page, [{ path: "/api/v1/session", body: SESSION_ANON }, { path: "/api/v1/whoami", body: SESSION_ANON }]);
  await page.goto(path);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 20_000 });
  await bigText(page);
  await fontsReady(page);
}

test.describe("L8-8 / L7-13 — the auth screens' club name and title keep their words whole at 320 / 200 %", () => {
  test.beforeEach(({ browserName }, info) => { void browserName; test.skip(info.project.name !== "desktop", "widths are set per test"); });

  for (const path of ["/login", "/register", "/forgot-password"]) {
    test(`${path}: "Crusaders" and the title paint whole, and nothing runs past the card`, async ({ page }) => {
      await openPublic(page, path, 320);
      // Was "Crusader / s Squash Club" in the band, and "password" run into the card's edge.
      expect(await brokenWords(page, "[data-auth-shell] .bg-brand-strong, [data-auth-shell] h1")).toEqual([]);
      const past = await page.locator("[data-auth-shell] h1").evaluate((h1) => {
        const card = h1.closest(".rounded-2xl")!.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(h1);
        return Math.max(...Array.from(range.getClientRects()).map((r) => r.right)) - card.right;
      });
      expect(past, "the title paints past the card's edge").toBeLessThanOrEqual(0);
    });
  }

  test("at 100 % a 390 phone keeps the full title size", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await serveApi(page, [{ path: "/api/v1/session", body: SESSION_ANON }, { path: "/api/v1/whoami", body: SESSION_ANON }]);
    await page.goto("/login");
    const h1 = page.locator("[data-auth-shell] h1");
    await expect(h1).toBeVisible({ timeout: 20_000 });
    expect(await h1.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBe(24);
  });

  test("the password's eye sits in the middle of its field at 200 % (was top-aligned)", async ({ page }) => {
    await openPublic(page, "/login", 390);
    const field = page.locator("input[type=password]").first();
    const eye = page.getByRole("button", { name: PASSWORD_TOGGLE.show }).first();
    const f = (await field.boundingBox())!;
    const e = (await eye.boundingBox())!;
    expect(Math.abs((e.y + e.height / 2) - (f.y + f.height / 2))).toBeLessThanOrEqual(1.5);
  });
});

test.describe("L7-13 — How it works' step titles keep their words whole at 200 %", () => {
  test.beforeEach(({ browserName }, info) => { void browserName; test.skip(info.project.name !== "desktop", "widths are set per test"); });

  for (const width of [320, 390]) {
    test(`${width} / 200 %: "Buy minutes" is not "Buy minut / es"`, async ({ page }) => {
      await openPublic(page, "/how-it-works", width);
      expect(await brokenWords(page, "main h2")).toEqual([]);
    });
  }

  test("390 at 100 %: the number badge still stands beside the title", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await serveApi(page, [{ path: "/api/v1/session", body: SESSION_ANON }, { path: "/api/v1/whoami", body: SESSION_ANON }]);
    await page.goto("/how-it-works");
    const h2 = page.locator("main ol h2").first();
    await expect(h2).toBeVisible({ timeout: 20_000 });
    const beside = await h2.evaluate((el) => {
      const [badge, title] = Array.from(el.children).map((c) => c.getBoundingClientRect());
      return title.left > badge.right && Math.abs(title.top - badge.top) < 20;
    });
    expect(beside).toBe(true);
  });
});
