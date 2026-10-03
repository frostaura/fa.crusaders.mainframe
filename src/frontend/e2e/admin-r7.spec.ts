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

/* ───────────────────────── L7-7 / X5-4 / L7-17 — Reports at 200 % ───────────────────────── */

// 15,630 min = "10 d 20 h 30 min": the figure the review found nowrap 250px in a 212px box.
const BIG_DAY = (i: number) => ({
  date: `2026-09-${String(i + 1).padStart(2, "0")}`, top_ups_minutes: 600 + i, booking_charges_minutes: 540, refunds_minutes: -45,
  penalties_minutes: 13, adjustments_minutes: i === 0 ? 15630 : 0, reversals_minutes: -60, share_transfers_minutes: 0, net_movement_minutes: -122,
  bookings: 12, no_shows: 2,
});
const reportRoutes = (): ApiRoute[] => [
  { path: "/api/v1/admin/reports/revenue", body: { from: "", to: "", gross_topups_zar: 2025, reversals_zar: 0, net_zar: 2025, gross_topups_minutes: 1800, reversals_minutes: 0, net_minutes: 1800, zar_per_minute_sold: 1.125 } },
  { path: "/api/v1/admin/reports/utilisation", body: { from: "", to: "", by_court: [{ court_id: "c-1", court_name: "Court 1", bookings: 4, booked_minutes: 180, sold_minutes: 180, kept_minutes: 135 }] } },
  { path: "/api/v1/admin/reports/no-shows", body: { from: "", to: "", total: 24, no_show: 2, no_show_pct: 8.3 } },
  { path: "/api/v1/admin/reports/daily", body: Array.from({ length: 3 }, (_, i) => BIG_DAY(i)) },
];

test.describe("L7-7 / X5-4 — a report's figures at 200 % text", () => {
  test.beforeEach(({ browserName }, info) => { void browserName; test.skip(info.project.name !== "mobile", "a phone"); });

  for (const width of [320, 390]) {
    test(`at ${width}: no figure breaks inside a number or between a number and its unit, and none leaves its box`, async ({ page }) => {
      await open(page, "/admin/reports", reportRoutes(), width, 800);
      await expect(page.locator("[data-stat-tiles]")).toBeVisible(ARRIVES);
      await bigText(page);
      await fontsReady(page);
      const figures = "#main-content dl dd";
      // A figure may wrap only between whole groups: "10 d 20 h" / "30 min", never "R2025.0 / 0" or "10 / d".
      const split = await page.evaluate((sel) => {
        const out: string[] = [];
        for (const dd of document.querySelectorAll(sel)) {
          const shown = [...dd.querySelectorAll(":scope *:not(.sr-only)")].length ? dd : dd;
          const walker = document.createTreeWalker(shown, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (node.parentElement?.closest(".sr-only")) continue;
            const text = node.textContent ?? "";
            // A group: a signed number with its unit ("−10 d", "30 min", "R2025.00", "8.3%").
            const re = /[−+-]?R?\d[\d.,]*(?:\s(?:d|h|min))?%?/g;
            for (let m = re.exec(text); m; m = re.exec(text)) {
              const range = document.createRange();
              range.setStart(node, m.index);
              range.setEnd(node, m.index + m[0].length);
              const tops = new Set([...range.getClientRects()].filter((r) => r.width > 0.5).map((r) => Math.round(r.top)));
              if (tops.size > 1) out.push(m[0]);
            }
          }
        }
        return out;
      }, figures);
      expect(split, "a figure broken inside a group").toEqual([]);
      expect(await textOutsideBox(page, figures, "dd"), "a figure past its box").toEqual([]);
      expect(await sideways(page)).toBeLessThanOrEqual(1);
    });
  }
});

test.describe("L7-17 — the daily table's sort carets", () => {
  test.beforeEach(({ browserName }, info) => { void browserName; test.skip(info.project.name !== "desktop", "widths are set per test"); });

  for (const [width, big] of [[1280, false], [1280, true], [1920, false]] as const) {
    test(`at ${width}${big ? " / 200 %" : ""}: every caret sits beside its header's last word, never under it`, async ({ page }) => {
      await open(page, "/admin/reports", reportRoutes(), width);
      const table = page.getByRole("region", { name: "Daily breakdown" }).getByRole("table");
      await expect(table).toBeVisible(ARRIVES);
      if (big) await bigText(page);
      await fontsReady(page);
      const misplaced = await table.evaluate((t) => [...t.querySelectorAll("thead th button")].flatMap((b) => {
        const svg = b.querySelector("svg")!.getBoundingClientRect();
        // The header's last word, from its own text node (an element's rect would include the caret).
        const texts: Text[] = [];
        const walker = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent?.trim()) texts.push(n as Text);
        const node = texts[texts.length - 1];
        const text = node.textContent!.trimEnd();
        const range = document.createRange();
        range.setStart(node, text.lastIndexOf(" ") + 1);
        range.setEnd(node, text.length);
        const rects = [...range.getClientRects()].filter((r) => r.width > 0.5);
        const last = rects[rects.length - 1];
        const mid = svg.top + svg.height / 2;
        const beside = mid >= last.top - 1 && mid <= last.bottom + 1 && svg.left >= last.right - 1;
        return beside ? [] : [`${b.textContent}: caret ${Math.round(svg.left)},${Math.round(svg.top)} last word ${Math.round(last.left)}–${Math.round(last.right)},${Math.round(last.top)}–${Math.round(last.bottom)}`];
      }));
      expect(misplaced).toEqual([]);
    });
  }
});
