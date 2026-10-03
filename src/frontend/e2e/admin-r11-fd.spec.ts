import { type Locator, type Page } from "@playwright/test";
import { SESSION_ADMIN, serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { memberShellRoutes } from "./playersKit";
import { sideways } from "./layoutKit";

// A cold dev server compiles the admin frame on first ask, and the machine is shared.
test.describe.configure({ timeout: 90_000 });

/**
 * Review round 11, lane FD11 (monitoring and admin layout), at 320 and 390 with 200 % text — the
 * sizes the round-10 spec did not reach:
 *
 * - L11-3 / L10-5: a BOX's own button map, inside its board card. Four nested insets (card,
 *   panel, list frame, row) left each select 90px with a 16px value at 320; "Unused" ran under the
 *   caret and the minutes input cut "15" to "1". The club-wide map (round 10's test) sits one
 *   card shallower and never showed it.
 * - L10-4: the door log's filters at 320 — "Last / 24 / hours" a word a line and "outcomes"
 *   under the caret.
 */

function adminRoutes(extra: ApiRoute[] = []): ApiRoute[] {
  return [
    ...extra,
    ...memberShellRoutes({ admin: true }),
    { path: "/api/v1/whoami", body: SESSION_ADMIN },
    { path: "/api/v1/admin/doors", body: { doors: [], shut_together: [], shut_individually: [], timezone: "Africa/Johannesburg" } },
    { path: "/api/v1/admin/monitoring/summary", body: { open: {} } },
    { path: "/api/v1/admin/play/results/disputed/count", body: { count: 0 } },
    { path: "/api/v1/admin/biometric/enrollments", body: [] },
    { path: "/api/v1/admin/member-groups", body: { groups: [] } },
    { path: "/api/v1/admin/members/", body: [] },
  ];
}

async function open(page: Page, path: string, routes: ApiRoute[], width: number, height = 800) {
  await page.setViewportSize({ width, height });
  await signIn(page);
  await serveApi(page, routes);
  await page.goto(path);
}

async function big(page: Page) {
  await page.addStyleTag({ content: "html { font-size: 32px; }" });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))));
}

/**
 * Every select under `scope` whose value is not whole and clear of its caret: text painted past the
 * caret's left edge, a word broken across lines, or more lines than `maxLines`.
 */
function selectFaults(scope: Locator, maxLines: number): Promise<string[]> {
  return scope.locator("[data-slot='select-trigger']").evaluateAll((triggers, most) => {
    const out: string[] = [];
    for (const trigger of triggers) {
      const value = trigger.querySelector<HTMLElement>("[data-slot='select-value']");
      const caret = trigger.querySelector("svg");
      if (!value || !caret || trigger.getBoundingClientRect().width === 0) continue;
      const text = value.textContent ?? "";
      const caretLeft = caret.getBoundingClientRect().left;
      const walker = document.createTreeWalker(value, NodeFilter.SHOW_TEXT);
      const lines = new Set<number>();
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        for (const m of (node.textContent ?? "").matchAll(/\S+/g)) {
          const range = document.createRange();
          range.setStart(node, m.index!);
          range.setEnd(node, m.index! + m[0].length);
          const rects = [...range.getClientRects()].filter((r) => r.width > 0);
          const tops = new Set(rects.map((r) => Math.round(r.top)));
          if (tops.size > 1) out.push(`${text}: "${m[0]}" broken`);
          if (rects.some((r) => r.right > caretLeft + 1)) out.push(`${text}: "${m[0]}" under the caret`);
          tops.forEach((t) => lines.add(t));
        }
      }
      if (lines.size > most) out.push(`${text}: ${lines.size} lines`);
    }
    return out;
  }, maxLines);
}

/* ───────────────────────── L11-3 / L10-5 — a box's own map, inside its card ───────────────────────── */

const BOX = {
  id: "11111111-1111-1111-1111-111111111111", device_code: "box-a1b2c3", name: "Back courts box", kind: "CourtBox",
  hardware: "Esp8266", court_numbers: [1], gate_key: null, mac_address: "5ccf7f1a2b3c", enabled: true,
  last_seen_at: new Date().toISOString(), last_ip_address: "192.168.68.151", running_version: "2.0.0",
  mega_version: "1.4.0", created_at: new Date().toISOString(), auto_registered: false, effective_heartbeat_seconds: 60,
  button_map: ["court:A", "off", "off", "off", "minutes:15", "minutes:30", "minutes:45", "minutes:60"],
};

function deviceRoutes(): ApiRoute[] {
  return adminRoutes([
    { path: "/api/v1/admin/devices/api-key", body: { api_key: "cmk_9F2Kq7Xd4bTn6Ls0", regenerated_at: "2026-09-01T08:30:00Z" } },
    { path: "/api/v1/admin/devices/", body: [BOX] },
    { path: "/api/v1/admin/courts/", body: [] },
    {
      path: "/api/v1/admin/settings/",
      body: { timezone: "Africa/Johannesburg", slice_minutes: 15, walk_up_max_minutes: 90, button_map: BOX.button_map },
    },
  ]);
}

test.describe("L11-3 — a box's own button map at 200 % text", () => {
  for (const width of [320, 390]) {
    test(`at ${width}: values whole and clear of the caret, minutes whole, Save and Cancel inside the panel`, async ({ page }) => {
      await open(page, "/admin/devices", deviceRoutes(), width, 900);
      const card = page.locator("[data-board-card]").filter({ hasText: "Back courts box" });
      await expect(card).toBeVisible({ timeout: 30_000 });
      await card.getByRole("button", { name: "Edit buttons" }).click();
      const action = page.getByRole("combobox", { name: "Back courts box button 1 action" });
      await expect(action).toBeVisible();
      await big(page);
      if (process.env.FD_SHOTS) await card.screenshot({ path: `${process.env.FD_SHOTS}/r11-boxmap-${width}.png` });

      expect(await selectFaults(card, 2), "a select's value").toEqual([]);
      const clipped = await card.locator("input[type=number]").evaluateAll((inputs) => inputs
        .filter((i) => (i as HTMLInputElement).scrollWidth > (i as HTMLInputElement).clientWidth)
        .map((i) => `${(i as HTMLInputElement).value} ${(i as HTMLInputElement).clientWidth}/${(i as HTMLInputElement).scrollWidth}`));
      expect(clipped, "a minutes figure cut").toEqual([]);

      const save = card.getByRole("button", { name: "Save buttons" });
      const panel = save.locator("xpath=ancestor::div[contains(@class,'bg-bg-muted')][1]");
      const [s, c, p] = await Promise.all([save.boundingBox(), card.getByRole("button", { name: "Cancel" }).boundingBox(), panel.boundingBox()]);
      for (const b of [s!, c!]) expect(b.x + b.width, "a button past its panel").toBeLessThanOrEqual(p!.x + p!.width + 0.5);
      expect(await sideways(page)).toBeLessThanOrEqual(1);
    });
  }
});

/* ───────────────────────── L10-4 — the door log's filters at 320 ───────────────────────── */

test.describe("L10-4 — the door log's filters at 320 / 200 % text", () => {
  test("no value is a word a line or runs under its caret; Download CSV stays in the gutter", async ({ page }) => {
    await open(page, "/admin/monitoring/doors/log", adminRoutes([
      { path: "/api/v1/admin/doors/activity", body: { items: [], next_cursor: null, retention_days: 90 } },
    ]), 320, 640);
    const filters = page.locator("fieldset").filter({ has: page.getByLabel("Outcome", { exact: true }) });
    await expect(filters).toBeVisible({ timeout: 30_000 });
    await big(page);
    if (process.env.FD_SHOTS) await filters.screenshot({ path: `${process.env.FD_SHOTS}/r11-doorlog-320.png` });
    // "Last 24 hours" may take two lines at this size; three was a word a line.
    expect(await selectFaults(filters, 2), "a filter's value").toEqual([]);

    const csv = page.getByRole("button", { name: /Download CSV/ });
    await csv.scrollIntoViewIfNeeded();
    const box = await csv.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(320);
    expect(await sideways(page)).toBeLessThanOrEqual(1);
  });
});
