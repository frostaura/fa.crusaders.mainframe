import type { Page } from "@playwright/test";
import { SESSION_ANON, serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { LOGIN, PASSWORD_TOGGLE } from "../src/lib/authCopy";
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

test.describe("L7-13 — every page title steps down rather than break a word", () => {
  test.beforeEach(({ browserName }, info) => { void browserName; test.skip(info.project.name !== "desktop", "widths are set per test"); });

  test('Transactions at 320 / 200 % paints whole (was "Transaction / s")', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 320, height: 700 });
    await signIn(page);
    await serveApi(page, memberShellRoutes({ admin: true }));
    await page.goto("/admin/transactions");
    const h1 = page.getByRole("heading", { level: 1, name: "Transactions" });
    await expect(h1).toBeVisible({ timeout: 20_000 });
    await bigText(page);
    await fontsReady(page);
    expect(await brokenWords(page, "main h1")).toEqual([]);
  });
});

/* ───────────────────────── L8-9 — the admin app bar's crest ───────────────────────── */

async function crest(page: Page, path: string, width: number, height: number, big: boolean) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width, height });
  await signIn(page);
  await serveApi(page, memberShellRoutes({ admin: true }));
  await page.goto(path);
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout: 20_000 });
  if (big) await bigText(page);
  await fontsReady(page);
  await page.waitForTimeout(200);
  return page.locator("[data-crest-link]").evaluate((link) => {
    const mark = link.querySelector("svg")!.getBoundingClientRect();
    const name = link.querySelector("span") as HTMLElement;
    const shown = getComputedStyle(name).display !== "none";
    return { x: Math.round(mark.left), shown, cut: shown ? name.scrollWidth - name.clientWidth : 0 };
  });
}

test.describe("L8-9 — the admin bar's crest: the club's name whole or not at all, and where the member bar has it", () => {
  test.beforeEach(({ browserName }, info) => { void browserName; test.skip(info.project.name !== "desktop", "widths are set per test"); });

  test('1280 / 200 %: never "Crusader…" over the rail', async ({ page }) => {
    const admin = await crest(page, "/admin", 1280, 800, true);
    expect(admin.cut, "the name is truncated").toBeLessThanOrEqual(0);
  });

  for (const [width, height, big] of [[1280, 800, true], [1280, 800, false], [1920, 1080, false]] as const) {
    test(`${width}${big ? " / 200 %" : ""}: the crest stands where it does on a member page`, async ({ page }) => {
      const member = await crest(page, "/how-it-works", width, height, big);
      const admin = await crest(page, "/admin", width, height, big);
      expect(Math.abs(admin.x - member.x), `admin ${admin.x} vs member ${member.x}`).toBeLessThanOrEqual(1);
    });
  }

  test("1280 at 100 %: the name still shows over the rail", async ({ page }) => {
    const admin = await crest(page, "/admin", 1280, 800, false);
    expect(admin.shown).toBe(true);
    expect(admin.cut).toBeLessThanOrEqual(0);
  });
});

/* ───────────────────────── L8-11 / L6-16 — callouts at large text ───────────────────────── */

async function refusedSignIn(page: Page, width: number, big: boolean) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width, height: 800 });
  await serveApi(page, [
    { path: "/api/v1/session", body: SESSION_ANON },
    { path: "/api/v1/whoami", body: SESSION_ANON },
    { method: "POST", path: "/api/v1/auth/login", status: 403, body: { error: "email_not_verified" } },
  ]);
  await page.goto("/login");
  await page.getByLabel(LOGIN.email, { exact: true }).fill("someone@example.com");
  await page.getByLabel(LOGIN.password, { exact: true }).fill("not-it");
  await page.getByRole("button", { name: LOGIN.submit, exact: true }).click();
  const alert = page.getByRole("alert").filter({ hasText: /./ }).first();
  await expect(alert).toBeVisible({ timeout: 20_000 });
  if (big) await bigText(page);
  await fontsReady(page);
  return alert.evaluate((p) => {
    const box = p.getBoundingClientRect();
    const icon = p.querySelector("svg")!.getBoundingClientRect();
    const lines: { left: number; top: number }[] = [];
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const r of Array.from(range.getClientRects())) if (r.width > 0) lines.push({ left: r.left - box.left, top: r.top });
    }
    lines.sort((a, b) => a.top - b.top);
    const textLeft = Math.min(...lines.slice(1).map((l) => l.left));
    return { icon: icon.width, gutter: lines.length > 1 ? textLeft : null, lines: lines.length, iconRight: icon.right - box.left, firstLine: lines[0].left, iconBottom: icon.bottom, firstTop: lines[0].top };
  });
}

test.describe("L8-11 / L6-16 — a callout's icon grows with its words, and its gutter steps down at large text", () => {
  test.beforeEach(({ browserName }, info) => { void browserName; test.skip(info.project.name !== "desktop", "widths are set per test"); });

  test("320 / 200 %: the icon is drawn at twice its size, and the lines under the first take the callout's width", async ({ page }) => {
    const m = await refusedSignIn(page, 320, true);
    test.info().annotations.push({ type: "callout", description: JSON.stringify(m) });
    expect(m.icon, "the icon stayed 16px").toBeGreaterThanOrEqual(28);
    expect(m.lines, "precondition: the refusal wraps").toBeGreaterThan(1);
    // Was a 72px gutter (pl-9) down every line for a 16px icon.
    expect(m.gutter!, "the lines under the first keep the icon's gutter").toBeLessThanOrEqual(32);
    // R15 L15-4 — under a 14rem callout the icon takes its own line, so the first line clears it by
    // starting BELOW it (a floated icon split "Bartholomew" on the shortened first line).
    expect(m.firstLine >= m.iconRight || m.firstTop >= m.iconBottom - 1, `the first line clears the icon ${JSON.stringify(m)}`).toBe(true);
  });

  test("320 at 100 %: the words still hang clear of the icon on every line", async ({ page }) => {
    const m = await refusedSignIn(page, 320, false);
    test.info().annotations.push({ type: "callout", description: JSON.stringify(m) });
    expect(m.icon).toBe(16);
    expect(m.lines, "precondition: the refusal wraps at 320").toBeGreaterThan(1);
    expect(m.firstLine).toBeGreaterThanOrEqual(m.iconRight);
    expect(m.gutter ?? m.firstLine).toBeGreaterThanOrEqual(m.iconRight);
  });
});

/* ───────────────────────── L8-11 — no orphan separators in the Overview's alerts ───────────────────────── */

const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const ALERTS = {
  items: [
    {
      id: "n1", kind: "device.offline", title: "Court box or door stopped reporting", headline: "Court 2 box stopped reporting",
      link: "/admin/monitoring/devices", subject_user_id: null, created_at: ago(5),
      delivery: { state: "sent", sent_at: ago(4), finished_at: ago(4), recipients: 3 },
    },
    {
      id: "n2", kind: "member.registered", title: "New membership applications", headline: "Thandi Mokoena applied to join",
      link: "/admin/members", subject_user_id: null, created_at: ago(180),
      delivery: { state: "sent", sent_at: ago(170), finished_at: ago(170), recipients: 3 },
    },
  ],
  next_cursor: null,
};

/** Painted "·" separators in the alerts' meta lines, and those that start a line (nothing painted left of them on it). */
async function orphanDots(page: Page): Promise<{ orphans: number; shown: number }> {
  return page.locator("[data-recent-alerts]").evaluate((list) => {
    const rectOf = (node: Node) => { const range = document.createRange(); range.selectNodeContents(node); return range.getBoundingClientRect(); };
    const clipped = (el: Element, r: DOMRect) => {
      for (let at: Element | null = el; at && at !== list; at = at.parentElement) {
        if (getComputedStyle(at).overflowX !== "visible") {
          const box = at.getBoundingClientRect();
          if (r.right <= box.left + 1 || r.left >= box.right - 1) return true;
        }
      }
      return false;
    };
    let orphans = 0;
    let shown = 0;
    const walker = document.createTreeWalker(list, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.textContent?.trim() !== "·") continue;
      const dot = rectOf(node);
      if (dot.width === 0 || clipped(node.parentElement!, dot)) continue;
      shown += 1;
      const meta = node.parentElement!.closest("[id]")!;
      const inner = document.createTreeWalker(meta, NodeFilter.SHOW_TEXT);
      let before = false;
      for (let t = inner.nextNode(); t; t = inner.nextNode()) {
        if (t === node || !t.textContent?.trim() || t.parentElement!.closest(".sr-only")) continue;
        const range = document.createRange();
        range.selectNodeContents(t);
        for (const r of Array.from(range.getClientRects())) {
          if (r.width > 0 && Math.abs(r.top - dot.top) < dot.height && r.right <= dot.left + 1) before = true;
        }
      }
      if (!before) orphans += 1;
    }
    return { orphans, shown };
  });
}

async function openOverview(page: Page, width: number, height: number, big: boolean) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width, height });
  await signIn(page);
  await serveApi(page, [...memberShellRoutes({ admin: true }), { path: "/api/v1/admin/notifications", body: ALERTS }]);
  await page.goto("/admin");
  await expect(page.locator("[data-recent-alerts]")).toBeVisible({ timeout: 20_000 });
  if (big) await bigText(page);
  await fontsReady(page);
  await page.waitForTimeout(200);
}

test.describe("L8-11 — an alert's kind and its time: a dot between them, never a dot starting a line", () => {
  test.beforeEach(({ browserName }, info) => { void browserName; test.skip(info.project.name !== "desktop", "widths are set per test"); });

  for (const width of [320, 390]) {
    test(`${width} / 200 %: the time wraps under the kind without a leading "·"`, async ({ page }) => {
      await openOverview(page, width, 800, true);
      const m = await orphanDots(page);
      expect(m.orphans).toBe(0);
    });
  }

  test("1280 at 100 %: the dot still stands between the kind and the time", async ({ page }) => {
    await openOverview(page, 1280, 800, false);
    const m = await orphanDots(page);
    expect(m.shown).toBeGreaterThanOrEqual(2);
    expect(m.orphans).toBe(0);
  });
});
