import type { Page } from "@playwright/test";
import { SESSION_ADMIN, serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { bigText, fontsReady, sideways } from "./layoutKit";
import { memberShellRoutes } from "./playersKit";

/**
 * Review round 7, lane FC2 (admin rail, overview, monitoring, reports, webhooks, doors, ledger
 * sheet) — what only a browser can measure: words broken mid-word and text clipped by its own box
 * at 200 % text on a 320 / 390 phone and beside the 1280 rail. Every test here was red first.
 */

test.describe.configure({ timeout: 120_000 });

const ARRIVES = { timeout: 30_000 };

function adminRoutes(extra: ApiRoute[] = []): ApiRoute[] {
  return [
    ...extra,
    ...memberShellRoutes({ admin: true }),
    { path: "/api/v1/whoami", body: SESSION_ADMIN },
    { path: "/api/v1/admin/doors", body: { doors: [], shut_together: [], shut_individually: [], timezone: "Africa/Johannesburg" } },
    { path: "/api/v1/admin/monitoring/summary", body: { open: {} } },
    { path: "/api/v1/admin/play/results/disputed/count", body: { count: 0 } },
    { path: "/api/v1/admin/members/", body: [] },
    { path: "/api/v1/admin/ledger/", body: [] },
  ];
}

async function open(page: Page, path: string, routes: ApiRoute[], width: number, height = 900) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width, height });
  await signIn(page);
  await page.addInitScript(() => {
    window.localStorage.setItem("crusaders:settings-intro-dismissed", "1");
  });
  await serveApi(page, adminRoutes(routes));
  await page.goto(path);
}

/**
 * Words under `selector` that paint on more than one line: broken mid-word. A word is a run between
 * spaces, hyphens, dashes and slashes — a line may legitimately break after "Khoza-".
 */
async function brokenWords(page: Page, selector: string): Promise<string[]> {
  return page.evaluate((sel) => {
    const out: string[] = [];
    for (const root of document.querySelectorAll(sel)) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const el = node.parentElement;
        if (!el || el.closest(".sr-only")) continue;
        const text = node.textContent ?? "";
        const re = /[^\s\-‐–—/·]+/g;
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

/** Text under `selector` that paints past the right or left edge of `boxSelector` (its nearest such ancestor). */
async function textOutsideBox(page: Page, selector: string, boxSelector: string): Promise<string[]> {
  return page.evaluate(([sel, boxSel]) => {
    const out: string[] = [];
    for (const root of document.querySelectorAll(sel)) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const el = node.parentElement;
        if (!el || el.closest(".sr-only") || !node.textContent?.trim()) continue;
        const holder = el.closest(boxSel);
        if (!holder) continue;
        const b = holder.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const r of range.getClientRects()) {
          if (r.width > 0.5 && (r.right > b.right + 1 || r.left < b.left - 1)) {
            out.push(`${node.textContent.trim().slice(0, 30)} [${Math.round(r.left)}–${Math.round(r.right)} in ${Math.round(b.left)}–${Math.round(b.right)}]`);
            break;
          }
        }
      }
    }
    return out;
  }, [selector, boxSelector] as const);
}

/* ───────────────────────── L7-6 / J7-5 — the admin rail at 1280 / 200 % ───────────────────────── */

test.describe("L7-6 / J7-5 — the admin rail keeps every section's name whole", () => {
  test.beforeEach(({ browserName }, info) => { void browserName; test.skip(info.project.name !== "desktop", "widths are set per test"); });

  for (const width of [1280, 1440, 1920]) {
    test(`at ${width} / 200 %: no "Transactio / ns", no "Fault / s"`, async ({ page }) => {
      await open(page, "/admin/ledger?from=2026-01-01&to=2026-01-31", [
        // A fault count on the rail: the badge takes room beside "Faults".
        { path: "/api/v1/admin/monitoring/summary", body: { open: { critical: 3, error: 2 } } },
      ], width);
      await expect(page.locator("[data-admin-rail] nav")).toBeVisible(ARRIVES);
      await bigText(page);
      await fontsReady(page);
      if (process.env.FC_SHOTS) await page.screenshot({ path: `${process.env.FC_SHOTS}/rail-${width}.png` });
      expect(await brokenWords(page, "[data-admin-rail] nav"), "rail labels broken mid-word").toEqual([]);
      expect(await textOutsideBox(page, "[data-admin-rail] nav a", "a"), "rail label painted outside its row").toEqual([]);
      // The rail still yields the page most of the screen (X6-5).
      const rail = (await page.locator("[data-admin-rail]").boundingBox())!;
      expect(rail.width / width, `rail is ${Math.round(rail.width)}px`).toBeLessThanOrEqual(0.3);
      expect(await sideways(page)).toBeLessThanOrEqual(1);
    });
  }
});

/* ───────────────────────── L7-2 — the control board's tiles at 320 / 200 % ───────────────────────── */

const NOW = Date.now();
const iso = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();
const person = (name: string) => ({ user_id: `u-${name}`, name, photo_url: null });

const BOARD = {
  generated_at: new Date(NOW).toISOString(),
  timezone: "Africa/Johannesburg",
  courts: [
    {
      court_id: "c-1", court_number: 1, name: "Court 1",
      lights: { state: "unknown", stale: true, as_of: iso(-30) },
      current: { booking_id: "b-1", kind: "booking", starts_at: iso(-10), ends_at: iso(35), booked_by: person("Naledi Khoza-Walker") },
      next: { booking_id: "b-2", kind: "booking", starts_at: iso(45), ends_at: iso(90), booked_by: person("Cleo Walker"), minutes_until: 45 },
      device: { device_id: "d-1", device_code: "box-af1737", link: "silent", last_seen_at: iso(-3), silent_seconds: 180 },
    },
    {
      court_id: "c-2", court_number: 2, name: "Court 2",
      lights: null,
      current: null,
      next: { booking_id: "b-3", kind: "booking", starts_at: iso(120), ends_at: iso(165), booked_by: person("Organiser Connor"), minutes_until: 120 },
      device: null,
    },
  ],
};

test.describe("L7-2 — a control-board tile at 320 / 200 %", () => {
  test.beforeEach(({ browserName }, info) => { void browserName; test.skip(info.project.name !== "mobile", "a phone"); });

  test("the state word fits its band and Booked by / Next read in words, not a letter a line", async ({ page }) => {
    await open(page, "/admin/monitoring", [
      { path: "/api/v1/admin/control-board", body: BOARD },
      { path: "/api/v1/admin/settings", body: { grace_window_minutes: 10 } },
    ], 320, 800);
    await expect(page.locator("[data-court-tiles] article").first()).toBeVisible(ARRIVES);
    await bigText(page);
    await fontsReady(page);
    const tiles = "[data-court-tiles] article";
    if (process.env.FC_SHOTS) await page.locator(tiles).first().screenshot({ path: `${process.env.FC_SHOTS}/board-320.png` });
    expect(await textOutsideBox(page, `${tiles} [data-state-band]`, "[data-state-band]"), "state word clipped").toEqual([]);
    expect(await brokenWords(page, `${tiles} dl`), "Booked by / Next broken mid-word").toEqual([]);
    expect(await textOutsideBox(page, tiles, "article"), "text past the tile's edge").toEqual([]);
    expect(await sideways(page)).toBeLessThanOrEqual(1);
  });
});
