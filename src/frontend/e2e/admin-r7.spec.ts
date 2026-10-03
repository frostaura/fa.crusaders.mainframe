import type { Page } from "@playwright/test";
import { SESSION_ADMIN, serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { bigText, fontsReady, sideways, textOffScreen } from "./layoutKit";
import { memberShellRoutes } from "./playersKit";
import { deviceErrorFixture, deviceErrorPageFixture } from "../src/test/monitoringFixtures";

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
 * spaces, hyphens, dashes, slashes and dots — a line may legitimately break after "Khoza-" or
 * "booking." (a money figure has its own group test below).
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
        const re = /[^\s\-‐–—/·.]+/g;
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

const SETTINGS = {
  slice_minutes: 15, advance_booking_days: 14, day_start_minute: 360, day_end_minute: 1320,
  penalty_pct: 30, grace_window_minutes: 5, penalty_window_minutes: 15, timezone: "Africa/Johannesburg",
  button_map: ["court:A", "court:B", "court:C", "court:D", "minutes:15", "minutes:30", "minutes:45", "off"],
  operating_hours: { mon: "06:00-22:00", sat: "07:00-20:00" }, topup_block_zar: 100, topup_max_zar_per_member: 1000,
  member_per_day_max_minutes: 60, peak_hours: "16:00-19:00", peak_advance_hours_for_regular: 1,
  retention_years: 2, no_show_lookback_days: 7, walk_up_max_minutes: 90, heartbeat_seconds: 60,
  activation_forward_window_minutes: 120, activation_cue_window_minutes: 10, qr_lifetime_seconds: 60,
  roster_window_minutes: 120, device_alert_cooldown_minutes: 60, currency_symbol: "R",
};

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
    test(`at ${width}${big ? " / 200 %" : ""}: every caret sits in the same place — under its header, on one line`, async ({ page }) => {
      await open(page, "/admin/reports", reportRoutes(), width);
      const table = page.getByRole("region", { name: "Daily breakdown" }).getByRole("table");
      await expect(table).toBeVisible(ARRIVES);
      if (big) await bigText(page);
      await fontsReady(page);
      const carets = await table.evaluate((t) => [...t.querySelectorAll("thead th button")].map((b) => {
        const svg = b.querySelector("svg")!.getBoundingClientRect();
        const label = b.querySelector("span")!;
        const range = document.createRange();
        range.selectNodeContents(label);
        const lines = [...range.getClientRects()].filter((r) => r.width > 0.5);
        const bottom = Math.max(...lines.map((r) => r.bottom));
        return { name: b.textContent, under: svg.top >= bottom - 1, top: Math.round(svg.top) };
      }));
      // Under its own label, every one: never beside one header and under the next.
      expect(carets.filter((c) => !c.under).map((c) => c.name), "a caret beside its header").toEqual([]);
      // And on one line across the row (the header row is bottom-aligned).
      const tops = new Set(carets.map((c) => c.top));
      expect([...tops].length, JSON.stringify(carets)).toBeLessThanOrEqual(1);
    });
  }
});

/* ───────────────────────── L7-8 — the Overview at 320 / 200 % ───────────────────────── */

const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const ALERTS = {
  items: [
    {
      id: "n1", kind: "member.registered", title: "New membership applications", headline: "Sevenadmin Adminwell applied for membership",
      link: "/admin/members", subject_user_id: null, created_at: ago(5),
      delivery: { state: "sent", sent_at: ago(4), finished_at: ago(4), recipients: 3 },
    },
    {
      id: "n2", kind: "device.offline", title: "Court box or door stopped reporting", headline: "Door gate-598a9a stopped reporting to the administrator",
      link: "/admin/monitoring/devices", subject_user_id: null, created_at: ago(180),
      delivery: { state: "failed", sent_at: null, finished_at: ago(170), recipients: 0 },
    },
  ],
  next_cursor: null,
};

test.describe("L7-8 — the Overview at 320 / 200 %", () => {
  test.beforeEach(({ browserName }, info) => { void browserName; test.skip(info.project.name !== "mobile", "a phone"); });

  test("the Faults card's words and the alert headlines are whole and inside their boxes", async ({ page }) => {
    await open(page, "/admin", [
      { path: "/api/v1/admin/notifications", body: ALERTS },
      // 34 faults: a two-digit count takes the room "attention" needed beside it.
      { path: "/api/v1/admin/monitoring/summary", body: { open: { critical: 13, error: 12, warning: 9 } } },
    ], 320, 800);
    await expect(page.locator("[data-alert]").first()).toBeVisible(ARRIVES);
    await bigText(page);
    await fontsReady(page);
    if (process.env.FC_SHOTS) {
      await page.locator("[data-attention-card='faults']").screenshot({ path: `${process.env.FC_SHOTS}/overview-faults-320.png` }).catch(() => null);
      await page.locator("[data-alert]").first().screenshot({ path: `${process.env.FC_SHOTS}/overview-alert-320.png` });
    }
    expect(await textOutsideBox(page, "[data-attention-card]", "[data-attention-card]"), "a card's words past its edge").toEqual([]);
    expect(await brokenWords(page, "[data-attention-card]"), "a card's words broken").toEqual([]);
    expect(await brokenWords(page, "[data-alert]"), "an alert headline broken mid-word").toEqual([]);
    expect(await textOutsideBox(page, "[data-alert]", "[data-alert]"), "an alert past its row").toEqual([]);
    expect(await sideways(page)).toBeLessThanOrEqual(1);
  });
});

/* ───────────────────────── L7-9 — the Boards page's device-key card at 320 / 200 % ───────────────────────── */

test.describe("L7-9 — the device-key card at 320 / 200 %", () => {
  test.beforeEach(({ browserName }, info) => { void browserName; test.skip(info.project.name !== "mobile", "a phone"); });

  test("its boxes give the words a reading width and break no word mid-word", async ({ page }) => {
    await open(page, "/admin/monitoring/devices", [
      { path: "/api/v1/admin/devices/api-key", body: { api_key: "cmk_9F2Kq7Xd4bTn6Ls0", regenerated_at: "2026-09-01T08:30:00Z" } },
      { path: "/api/v1/admin/devices/", body: [] },
      { path: "/api/v1/admin/settings/", body: SETTINGS },
      { path: "/api/v1/admin/courts/", body: [] },
    ], 320, 800);
    const card = page.locator("[data-device-key-card]");
    await expect(card.getByText("How to pair a board")).toBeVisible(ARRIVES);
    await bigText(page);
    await fontsReady(page);
    if (process.env.FC_SHOTS) await card.screenshot({ path: `${process.env.FC_SHOTS}/device-key-320.png` });
    // The key itself breaks anywhere by design (it is one token); every sentence keeps its words.
    const broken = (await brokenWords(page, "[data-device-key-card] :is(p, li, h3, span, button)")).filter((w) => !w.startsWith("cmk_") && !w.startsWith("•"));
    expect(broken, "words broken mid-word").toEqual([]);
    const steps = await card.locator("ol").evaluate((ol) => Math.round(ol.getBoundingClientRect().width));
    expect(steps, "the pairing steps' column").toBeGreaterThanOrEqual(200);
    expect(await textOutsideBox(page, "[data-device-key-card]", "[data-device-key-card]")).toEqual([]);
    expect(await sideways(page)).toBeLessThanOrEqual(1);
  });
});

test.describe("L7-9 — the device-key card at a desk, at 100 % text", () => {
  test.beforeEach(({ browserName }, info) => { void browserName; test.skip(info.project.name !== "desktop", "a desk"); });

  for (const width of [390, 1280]) {
    test(`at ${width} it keeps its insets and the pairing note its box`, async ({ page }) => {
      await open(page, "/admin/monitoring/devices", [
        { path: "/api/v1/admin/devices/api-key", body: { api_key: "cmk_9F2Kq7Xd4bTn6Ls0", regenerated_at: "2026-09-01T08:30:00Z" } },
        { path: "/api/v1/admin/devices/", body: [] },
        { path: "/api/v1/admin/settings/", body: SETTINGS },
        { path: "/api/v1/admin/courts/", body: [] },
      ], width);
      const card = page.locator("[data-device-key-card]");
      await expect(card.getByText("How to pair a board")).toBeVisible(ARRIVES);
      const shape = await card.evaluate((c) => {
        const content = c.querySelector("[data-slot='card-content']")!;
        const note = c.querySelector("ol")!.parentElement!;
        return { pad: getComputedStyle(content).paddingLeft, border: getComputedStyle(note).borderTopWidth, notePad: getComputedStyle(note).paddingLeft };
      });
      expect(shape).toEqual({ pad: width >= 640 ? "24px" : "16px", border: "1px", notePad: "16px" });
    });
  }
});

/* ───────────────────────── L7-10 — Faults at 320 / 200 % ───────────────────────── */

test.describe("L7-10 — Faults at 320 / 200 %", () => {
  test.beforeEach(({ browserName }, info) => { void browserName; test.skip(info.project.name !== "mobile", "a phone"); });

  test("the filters show their whole values and a fault's title keeps its words", async ({ page }) => {
    const rows = [
      deviceErrorFixture({ id: "e1", device_name: "box-af1737", code: "heartbeat_missing", severity: "critical", headline: "The box stopped reporting" }),
      deviceErrorFixture({ id: "e2", device_name: "box-3a3703", code: "scanner_timeout", headline: "The scanner stopped answering" }),
    ];
    await open(page, "/admin/monitoring/faults", [
      { path: "/api/v1/admin/monitoring/errors", body: deviceErrorPageFixture(rows) },
      { path: "/api/v1/admin/devices/", body: [] },
    ], 320, 800);
    await expect(page.locator("[data-fault-text]").first()).toBeVisible(ARRIVES);
    await bigText(page);
    await fontsReady(page);
    if (process.env.FC_SHOTS) await page.screenshot({ path: `${process.env.FC_SHOTS}/faults-320.png` });
    const clipped = await page.locator("[data-slot='select-value']").evaluateAll((values) => values
      .filter((v) => v.scrollWidth > v.clientWidth + 1 || v.scrollHeight > v.clientHeight + 1)
      .map((v) => `${v.textContent} ${v.clientWidth}/${v.scrollWidth}`));
    expect(clipped, "a filter's value cut short").toEqual([]);
    expect(await brokenWords(page, "[data-fault-text] p"), "a fault's words broken mid-word").toEqual([]);
    expect(await textOffScreen(page), "text past the screen").toEqual([]);
    expect(await sideways(page)).toBeLessThanOrEqual(1);
  });
});

/* ───────────────────────── L7-11 — Webhooks at 320 / 200 % ───────────────────────── */

const HOOKS = ["a", "b"].map((x, i) => ({
  id: `00000000-0000-4000-8000-00000000072${i}`, owner_kind: "Tenant", description: null,
  url_template: `https://hook-${x}.e7-r7.review.test/{event}`, event_filter: "booking.created,minutes.refunded", enabled: i === 0,
  failure_count: i, last_success_at: null, last_failure_at: null, secret: null,
}));

test.describe("L7-11 — a webhook row at 320 / 200 %", () => {
  test.beforeEach(({ browserName }, info) => { void browserName; test.skip(info.project.name !== "mobile", "a phone"); });

  test("its badge says \"enabled\" whole and Deliveries stays inside the row", async ({ page }) => {
    await open(page, "/admin/webhooks", [{ path: "/api/v1/admin/webhooks/", body: HOOKS }], 320, 800);
    const row = page.getByRole("listitem").filter({ hasText: "hook-a.e7-r7" }).first();
    await expect(row).toBeVisible(ARRIVES);
    await bigText(page);
    await fontsReady(page);
    if (process.env.FC_SHOTS) await row.screenshot({ path: `${process.env.FC_SHOTS}/webhook-320.png` });
    const badges = await brokenWords(page, "li [data-slot='badge']");
    expect(badges, "a badge broken mid-word").toEqual([]);
    const outside = await row.evaluate((li) => {
      const box = li.getBoundingClientRect();
      return [...li.querySelectorAll("button")].map((b) => b.getBoundingClientRect())
        .filter((r) => r.left < box.left - 1 || r.right > box.right + 1).map((r) => `${Math.round(r.left)}–${Math.round(r.right)} in ${Math.round(box.left)}–${Math.round(box.right)}`);
    });
    expect(outside, "a button past the row's edge").toEqual([]);
    expect(await textOffScreen(page), "text past the screen").toEqual([]);
    expect(await sideways(page)).toBeLessThanOrEqual(1);
  });
});
