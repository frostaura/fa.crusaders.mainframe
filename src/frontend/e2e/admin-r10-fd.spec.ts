import { type Locator, type Page } from "@playwright/test";
import { SESSION_ADMIN, serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { memberShellRoutes } from "./playersKit";
import { sideways } from "./layoutKit";

// A cold dev server compiles the admin frame on first ask, and the machine is shared.
test.describe.configure({ timeout: 90_000 });

/**
 * Review round 10, lane FD10 (monitoring and admin layout) — measured in Chromium against a mocked
 * API at 200 % text, where a viewport rule (`sm:`) or a fixed basis does not follow the words:
 * the change record's diff (L10-2), the door log's filters (L10-4), the button map (L10-5), a
 * group's title and a change's headline (L10-6).
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
    { path: "/api/v1/admin/settings/", body: { timezone: "Africa/Johannesburg", slice_minutes: 15 } },
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
 * Words cut across lines ("Cou/rt/num/bers", "administrato/r"); a break after a hyphen is a real
 * break. Strict: a word wider than its whole box counts too — that box should have stepped down.
 */
function brokenWords(el: Locator): Promise<string[]> {
  return el.evaluate((root) => {
    const out: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? "";
      if (node.parentElement?.closest(".sr-only, [aria-hidden='true']")) continue;
      for (const m of text.matchAll(/[^\s\u00a0\-\u2013]+[-\u2013]?/g)) {
        const range = document.createRange();
        range.setStart(node, m.index!);
        range.setEnd(node, m.index! + m[0].length);
        const tops = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)));
        if (tops.size > 1) out.push(m[0]);
      }
    }
    return out;
  });
}

/** Text under `el` painted past `el`'s own right or left edge (Range rects; element rects cannot see it). */
function textPastBox(el: Locator): Promise<string[]> {
  return el.evaluate((root) => {
    const box = root.getBoundingClientRect();
    const out: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim() || node.parentElement?.closest(".sr-only")) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const r of range.getClientRects()) {
        if (r.width > 0 && (r.right > box.right + 1 || r.left < box.left - 1)) out.push(node.textContent.trim().slice(0, 30));
      }
    }
    return out;
  });
}

/** A Select's value cut short — "Al", "La", "Select c". */
function clippedValues(scope: Locator): Promise<string[]> {
  return scope.locator("[data-slot='select-value']").evaluateAll((values) => values
    .filter((v) => v.scrollWidth > v.clientWidth + 1 || v.scrollHeight > v.clientHeight + 1)
    .map((v) => `${v.textContent} ${v.clientWidth}/${v.scrollWidth}`));
}

/* ───────────────────────── L10-2 / L10-6 — the change record at 320 and 390 / 200 % ───────────────────────── */

const CHANGES = {
  rows: [
    {
      id: "ch-1", occurred_at: "2026-10-03T13:20:00Z", actor: { name: "Crusaders Admin" }, area: "devices", action: "updated",
      headline: "Removed a member's administrator rights — D10 Adm a2", subject: { kind: "member", label: "D10 Adm a2" },
      changes: [
        { field: "court_numbers", label: "Court numbers", before: "1, 2", after: "1, 2, 3, 4" },
        { field: "name", label: "Name", before: "box-af1737", after: "Back courts box" },
        { field: "location_note", label: "Location note", before: null, after: "Behind the squash courts, on the left" },
      ],
    },
  ],
  total: 1, cursor: null, timezone: "Africa/Johannesburg",
};

test.describe("L10-2 / L10-6 — the change record at 200 % text", () => {
  for (const width of [320, 390]) {
    test(`at ${width}: "Show what changed" stacks label over value, and the headline keeps its words`, async ({ page }) => {
      await open(page, "/admin/monitoring/changes", adminRoutes([{ path: "/api/v1/admin/changes", body: CHANGES }]), width);
      const row = page.locator("[data-change-row]").first();
      await expect(row).toBeVisible({ timeout: 30_000 });
      await big(page);
      await row.locator("summary").click();
      const diff = row.locator("[data-change-diff]");
      await expect(diff).toBeVisible();
      if (process.env.FD_SHOTS) await row.screenshot({ path: `${process.env.FD_SHOTS}/changes-${width}.png` });

      // L10-6: "administrato/r".
      expect(await brokenWords(row.locator("p").nth(0)), "the headline broke a word").toEqual([]);
      // L10-2: "Cou/rt/num/bers", one letter of a value per line, After past the box.
      expect(await brokenWords(diff), "a label or value broke mid-word").toEqual([]);
      expect(await textPastBox(diff), "text painted past the diff's box").toEqual([]);
      // Every value has a reading width: at least as wide as its box's text, never a 0\u20134px column.
      const narrow = await diff.locator("dd").evaluateAll((cells) => cells
        .filter((c) => c.getBoundingClientRect().width > 0 && c.getBoundingClientRect().width < 64)
        .map((c) => `${c.textContent} ${Math.round(c.getBoundingClientRect().width)}`));
      expect(narrow, "a value squeezed to a sliver").toEqual([]);
      // Stacked, each value still says which side it is — Before / After — to the eye.
      await expect(diff.locator("dd > span").filter({ hasText: /^Before/ }).first()).toBeVisible();
      await expect(diff.locator("dd > span").filter({ hasText: /^After/ }).first()).toBeVisible();
      expect(await sideways(page)).toBeLessThanOrEqual(1);
    });
  }

  test("at 1280 / 100 % the before/after table keeps its three columns", async ({ page }) => {
    await open(page, "/admin/monitoring/changes", adminRoutes([{ path: "/api/v1/admin/changes", body: CHANGES }]), 1280);
    const row = page.locator("[data-change-row]").first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.locator("summary").click();
    const table = row.locator("[data-change-diff] dl").first();
    const tops = await table.locator("dt, dd").evaluateAll((cells) => cells
      .filter((c) => c.getBoundingClientRect().width > 0)
      .map((c) => Math.round(c.getBoundingClientRect().top)));
    // Header row (3) + three lines of three cells, each row on one line.
    expect(new Set(tops.slice(0, 3)).size, "the header is one row").toBe(1);
    expect(new Set(tops.slice(3, 6)).size, "a line is one row").toBe(1);
  });
});

/* ───────────────────────── L10-4 — the door log's filters ───────────────────────── */

const DOOR_ID = "99999999-9999-9999-9999-999999999999";

function doorLogRoutes(): ApiRoute[] {
  const device = {
    id: DOOR_ID, device_code: "gate-0a1b2c", name: "Side door", kind: "Gate", hardware: "Esp32", court_numbers: [],
    gate_key: "side-door", mac_address: "5ccf7f0a1b2c", enabled: true, last_seen_at: new Date().toISOString(),
    last_ip_address: "192.168.68.160", running_version: "1.0.0", mega_version: null, created_at: new Date().toISOString(),
    auto_registered: false, effective_heartbeat_seconds: 60, location_note: null, power_loss_behaviour: "not_established",
    out_of_service_since: null,
  };
  return adminRoutes([
    {
      path: "/api/v1/admin/doors/activity",
      body: {
        items: [{
          at: new Date(Date.now() - 600_000).toISOString(), action: "gate.denied_no_booking", reason: "no_booking", offline: false,
          member: { id: "00000000-0000-0000-0000-0000000000aa", name: "Ada Lovelace" }, fingerprint: "1f2e3d4c",
          door: { id: DOOR_ID, name: "Side door", gate_key: "side-door" },
        }],
        next_cursor: null, retention_days: 90,
      },
    },
    {
      path: "/api/v1/admin/doors",
      body: {
        day_started_at: new Date(new Date().setHours(0, 0, 0, 0)).toISOString(), timezone: "Africa/Johannesburg",
        shut_all_active: false, shut_together: [], shut_individually: [],
        doors: [{ device, today: { released: 4, refused: 1 }, signals: [] }],
      },
    },
  ]);
}

test.describe("L10-4 — the door log's Door / When / Outcome at 200 % text", () => {
  for (const [width, height] of [[390, 844], [768, 1024], [1280, 800]] as const) {
    test(`at ${width}: every filter shows its whole value`, async ({ page }) => {
      await open(page, "/admin/monitoring/doors/log", doorLogRoutes(), width, height);
      const filters = page.locator("fieldset").filter({ has: page.getByLabel("Outcome", { exact: true }) });
      await expect(filters).toBeVisible({ timeout: 30_000 });
      await big(page);
      if (process.env.FD_SHOTS) await filters.screenshot({ path: `${process.env.FD_SHOTS}/doorlog-${width}.png` });
      expect(await clippedValues(filters), "a filter's value cut short").toEqual([]);
      expect(await sideways(page)).toBeLessThanOrEqual(1);
    });
  }

  test("at 1280 / 100 % the three filters still share one row", async ({ page }) => {
    await open(page, "/admin/monitoring/doors/log", doorLogRoutes(), 1280);
    const filters = page.locator("fieldset").filter({ has: page.getByLabel("Outcome", { exact: true }) });
    await expect(filters).toBeVisible({ timeout: 30_000 });
    const tops = await filters.locator("[data-slot='select-trigger']").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
    expect(tops.length).toBe(3);
    expect(new Set(tops).size, `tops ${tops}`).toBe(1);
    expect(await clippedValues(filters)).toEqual([]);
  });
});

/* ───────────────────────── L10-5 — the button map at 390 / 200 % ───────────────────────── */

test.describe("L10-5 — the club button map at 200 % text", () => {
  for (const width of [320, 390]) {
    test(`at ${width}: every action and court select shows its whole value`, async ({ page }) => {
      await open(page, "/admin/devices", adminRoutes([
        { path: "/api/v1/admin/devices/api-key", body: { api_key: "cmk_9F2Kq7Xd4bTn6Ls0", regenerated_at: "2026-09-01T08:30:00Z" } },
        { path: "/api/v1/admin/devices/", body: [] },
        { path: "/api/v1/admin/courts/", body: [] },
        {
          path: "/api/v1/admin/settings/",
          body: {
            timezone: "Africa/Johannesburg", slice_minutes: 15, walk_up_max_minutes: 90,
            button_map: ["court:A", "court:B", "court:C", "court:D", "minutes:15", "minutes:30", "minutes:45", "off"],
          },
        },
      ]), width, 900);
      const map = page.getByRole("combobox", { name: /^Button 1 action$/ });
      await expect(map).toBeVisible({ timeout: 30_000 });
      await big(page);
      const editor = map.locator("xpath=ancestor::div[contains(@class,'divide-y')][1]");
      if (process.env.FD_SHOTS) await editor.screenshot({ path: `${process.env.FD_SHOTS}/buttonmap-${width}.png` });
      expect(await clippedValues(editor), "a select's value cut short").toEqual([]);
      expect(await sideways(page)).toBeLessThanOrEqual(1);
    });
  }

  test("at 1280 / 100 % a row keeps its label and selects on one line", async ({ page }) => {
    await open(page, "/admin/devices", adminRoutes([
      { path: "/api/v1/admin/devices/api-key", body: { api_key: "cmk_9F2Kq7Xd4bTn6Ls0", regenerated_at: "2026-09-01T08:30:00Z" } },
      { path: "/api/v1/admin/devices/", body: [] },
      { path: "/api/v1/admin/courts/", body: [] },
      { path: "/api/v1/admin/settings/", body: { timezone: "Africa/Johannesburg", slice_minutes: 15, walk_up_max_minutes: 90, button_map: ["court:A", "off", "off", "off", "off", "off", "off", "off"] } },
    ]), 1280, 900);
    const action = page.getByRole("combobox", { name: /^Button 1 action$/ });
    await expect(action).toBeVisible({ timeout: 30_000 });
    const court = page.getByRole("combobox", { name: /^Button 1 court$/ });
    const [a, c] = await Promise.all([action.boundingBox(), court.boundingBox()]);
    expect(Math.abs(a!.y - c!.y)).toBeLessThanOrEqual(1);
  });
});

/* ───────────────────────── L10-6 — a group's title at 320 / 200 % ───────────────────────── */

const group = (id: string, name: string) => ({
  id, name, description: null, status: "active", member_count: 0, system_key: null, is_system_default: true,
  package_discount_bps: null, peak_priority: null, windows: [], caps: {}, created_at: "2026-09-01T08:00:00Z",
});

test.describe("L10-6 — a group card's title at 200 % text", () => {
  for (const width of [320, 390]) {
    test(`at ${width}: "Non-league members" breaks between words, never "membe/rs"`, async ({ page }) => {
      await open(page, "/admin/groups", adminRoutes([
        { path: "/api/v1/admin/member-groups", body: { groups: [group("g-1", "Non-league members")] } },
        { path: "/api/v1/admin/packages", body: { packages: [] } },
      ]), width);
      const card = page.locator("[data-group-card='g-1']");
      await expect(card).toBeVisible({ timeout: 30_000 });
      await big(page);
      if (process.env.FD_SHOTS) await card.screenshot({ path: `${process.env.FD_SHOTS}/group-${width}.png` });
      expect(await brokenWords(card.locator("h2")), "the title broke a word").toEqual([]);
      // The ⋯ is still there, and still inside the card.
      const menu = card.locator("[data-slot='card-action'] button");
      await expect(menu).toBeVisible();
      const [m, c] = await Promise.all([menu.boundingBox(), card.boundingBox()]);
      expect(m!.x + m!.width).toBeLessThanOrEqual(c!.x + c!.width + 1);
      expect(await sideways(page)).toBeLessThanOrEqual(1);
    });
  }

  test("at 1280 / 100 % the ⋯ sits beside the title, top right", async ({ page }) => {
    await open(page, "/admin/groups", adminRoutes([
      { path: "/api/v1/admin/member-groups", body: { groups: [group("g-1", "Non-league members")] } },
      { path: "/api/v1/admin/packages", body: { packages: [] } },
    ]), 1280);
    const card = page.locator("[data-group-card='g-1']");
    await expect(card).toBeVisible({ timeout: 30_000 });
    if (process.env.FD_SHOTS) await card.screenshot({ path: `${process.env.FD_SHOTS}/group-1280.png` });
    const [title, menu] = await Promise.all([card.locator("h2").boundingBox(), card.locator("[data-slot='card-action'] button").boundingBox()]);
    expect(menu!.x).toBeGreaterThan(title!.x + title!.width - 1);
    expect(menu!.y).toBeLessThan(title!.y + title!.height);
  });
});
