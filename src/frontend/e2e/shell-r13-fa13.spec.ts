import { type Page } from "@playwright/test";
import { serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { memberShellRoutes } from "./playersKit";

/**
 * Review round 13 (FA13) — the shell and the select list at large text, measured in Chromium.
 *
 * <ul>
 *   <li><b>L13-1</b> — a select's list was sized by its longest option and ran off a phone at
 *   200 % text (the door log's "All doors" 674 px wide on a 390 screen); a removed unnamed gate
 *   was listed by its device id.</li>
 *   <li><b>L13-2</b> — the account menu's Wallet figure ran past the menu at 320 / 200 %.</li>
 *   <li><b>L13-3</b> — the admin's top bar wrapped at 1536–1920 px / 200 % (1280 / 150 %) and left
 *   the bell alone top-right, the chip and avatar on a second row.</li>
 * </ul>
 */

async function open(page: Page, path: string, width: number, routes: ApiRoute[], root: number) {
  await page.setViewportSize({ width, height: 900 });
  await signIn(page);
  await serveApi(page, routes);
  await page.goto(path);
  if (root !== 16) await page.addStyleTag({ content: `html { font-size: ${root}px; }` });
  await expect(page.locator("nav[data-primary-nav]")).toBeAttached();
  await expect(page.getByRole("button", { name: "Account menu" })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

/** An admin with a three-digit count, unread notices and a long balance — the widest bar. */
function adminRoutes(extra: ApiRoute[] = []): ApiRoute[] {
  return [
    // First: the routes match by longest prefix, and a tie goes to the earlier one.
    ...extra,
    { path: "/api/v1/admin/doors", body: { doors: [], shut_together: [], shut_individually: [], timezone: "Africa/Johannesburg" } },
    { path: "/api/v1/admin/monitoring/summary", body: { open: { critical: 140 } } },
    { path: "/api/v1/admin/play/results/disputed/count", body: { count: 0 } },
    { path: "/api/v1/admin/play/results", body: { items: [], next_cursor: null, count: 0 } },
    { path: "/api/v1/admin/members/", body: [] },
    ...memberShellRoutes({ admin: true, unread: 12, wallet: { balance_minutes: 5325, spendable_minutes: 5325, held_minutes: 0 } }),
  ];
}

/** The bar's rows: every in-flow item (and the bell, chip and avatar) by its vertical centre. */
async function bar(page: Page) {
  return page.evaluate(() => {
    const row = document.querySelector<HTMLElement>("header[data-app-header] > div")!;
    const mid = (el: Element) => { const r = el.getBoundingClientRect(); return Math.round((r.top + r.bottom) / 2); };
    const shown = (el: Element) => el.getBoundingClientRect().width > 0 && getComputedStyle(el).position !== "fixed";
    const items = [...row.children, ...row.querySelectorAll("[data-app-header-actions] > *")].filter(shown);
    const mids = items.map(mid);
    const bell = document.querySelector("[data-notification-bell]")!.getBoundingClientRect();
    const avatar = document.querySelector("header button[data-account-menu]")!.getBoundingClientRect();
    return {
      spread: Math.max(...mids) - Math.min(...mids),
      inline: getComputedStyle(document.querySelector("nav[data-primary-nav]")!).position !== "fixed",
      over: row.scrollWidth - row.clientWidth,
      bellToAvatar: avatar.left - bell.right,
    };
  });
}

test.describe("L13-3 — the admin's top bar is one row at every text size", () => {
  for (const [width, root] of [[1920, 32], [1800, 30], [1536, 32], [1280, 24], [1366, 23], [1920, 31]] as const) {
    test(`/admin at ${width} px, ${root} px text: one row, tabs at the bottom, bell beside the chip and avatar`, async ({ page }) => {
      await open(page, "/admin", width, adminRoutes(), root);
      const m = await bar(page);
      expect(m.spread, "the bar wrapped").toBeLessThanOrEqual(4);
      expect(m.over).toBeLessThanOrEqual(0);
      expect(m.inline, "the admin's tabs cannot fit the row here").toBe(false);
      expect(m.bellToAvatar, "the bell is in the group with the chip and the avatar").toBeLessThan(width / 2);
    });
  }

  for (const [path, width, root] of [["/admin", 1024, 16], ["/admin", 1920, 16], ["/admin", 1440, 22], ["/my-code", 1440, 20]] as const) {
    test(`${path} at ${width} px, ${root} px text: the tabs sit inline and the row still fits`, async ({ page }) => {
      await open(page, path, width, adminRoutes(), root);
      const m = await bar(page);
      expect(m.inline).toBe(true);
      expect(m.spread, "the bar wrapped").toBeLessThanOrEqual(4);
      expect(m.over).toBeLessThanOrEqual(0);
    });
  }

  for (const [width, root] of [[320, 32], [390, 32], [1280, 24], [1024, 16]] as const) {
    test(`a member's bar at ${width} px, ${root} px text is one row`, async ({ page }) => {
      await open(page, "/my-code", width, memberShellRoutes({ unread: 3 }), root);
      const m = await bar(page);
      expect(m.spread, "the bar wrapped").toBeLessThanOrEqual(4);
      expect(m.over).toBeLessThanOrEqual(0);
    });
  }
});

test.describe("L13-2 — the account menu's Wallet figure stays in the menu", () => {
  for (const [width, minutes] of [[320, 165], [320, 5325], [390, 5325]] as const) {
    test(`at ${width} px / 200 % with ${minutes} minutes`, async ({ page }) => {
      await open(page, "/my-code", width, memberShellRoutes({ wallet: { balance_minutes: minutes, spendable_minutes: minutes, held_minutes: 0 } }), 32);
      await page.getByRole("button", { name: "Account menu" }).click();
      const item = page.getByRole("menuitem", { name: /^Wallet/ });
      await expect(item).toBeVisible();
      const m = await item.evaluate((el) => {
        const menu = el.closest("[role=menu]")!.getBoundingClientRect();
        // The DRAWN figure: the sr-only words beside it are clipped to nothing and measure anywhere.
        const figure = el.querySelector("[data-wallet-figure] [aria-hidden=true]")!;
        const range = document.createRange();
        range.selectNodeContents(figure);
        const rects = [...range.getClientRects()].filter((r) => r.width > 0);
        return {
          menu: { left: menu.left, right: menu.right },
          text: { left: Math.min(...rects.map((r) => r.left)), right: Math.max(...rects.map((r) => r.right)) },
          lines: new Set(rects.map((r) => Math.round(r.top))).size,
          vw: window.innerWidth,
        };
      });
      expect(m.menu.right).toBeLessThanOrEqual(m.vw);
      expect(m.text.right, "the figure runs past the menu").toBeLessThanOrEqual(m.menu.right);
      expect(m.text.left).toBeGreaterThanOrEqual(m.menu.left);
      expect(m.lines, "the figure is one unbroken run").toBe(1);
    });
  }
});

const LONG_DOOR = "Upstairs viewing gallery fire escape door beside the squash courts";
const REMOVED_ID = "5b9d3c1e-2f4a-4b6c-8d7e-9f0a1b2c3d4e";

function doorLogRoutes(): ApiRoute[] {
  const device = {
    id: "99999999-9999-9999-9999-999999999999", device_code: "gate-0a1b2c", name: LONG_DOOR, kind: "Gate",
    hardware: "Esp32", court_numbers: [], gate_key: "upstairs-gallery-fire-escape", mac_address: "5ccf7f0a1b2c", enabled: true,
    last_seen_at: new Date().toISOString(), last_ip_address: null, running_version: "1.0.0", mega_version: null,
    created_at: new Date().toISOString(), auto_registered: false, effective_heartbeat_seconds: 60, location_note: null,
    power_loss_behaviour: "not_established", out_of_service_since: null,
  };
  return adminRoutes([
    {
      path: "/api/v1/admin/doors",
      body: {
        day_started_at: new Date().toISOString(), timezone: "Africa/Johannesburg", shut_all_active: false,
        shut_together: [], shut_individually: [], doors: [{ device, today: { released: 1, refused: 0 }, signals: [] }],
      },
    },
    {
      path: "/api/v1/admin/doors/activity",
      body: {
        items: [], next_cursor: null, retention_days: 90, total: 0, timezone: "Africa/Johannesburg",
        // A deleted gate nobody named: the server sends the placeholder and no key.
        removed_doors: [{ key: REMOVED_ID, name: "Door gate", gate_key: null }],
      },
    },
  ]);
}

test.describe("L13-1 — a select's list never runs off the screen", () => {
  for (const width of [320, 390]) {
    test(`the door log's door picker at ${width} px / 200 %`, async ({ page }) => {
      await open(page, "/admin/doors/log", width, doorLogRoutes(), 32);
      await page.getByLabel("Door", { exact: true }).click();
      const list = page.locator("[data-slot=select-content]");
      await expect(list).toBeVisible();
      await expect(list.getByRole("option", { name: "Unnamed scanner" })).toBeVisible();
      await expect(list).not.toContainText(REMOVED_ID);
      const m = await list.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const texts = [...el.querySelectorAll("[role=option]")].flatMap((option) => {
          const range = document.createRange();
          range.selectNodeContents(option);
          return [...range.getClientRects()].filter((r) => r.width > 0).map((r) => ({ left: r.left, right: r.right }));
        });
        const long = [...el.querySelectorAll("[role=option]")].find((o) => o.textContent?.includes("Upstairs"))!;
        const range = document.createRange();
        range.selectNodeContents(long);
        return {
          box: { left: box.left, right: box.right },
          textLeft: Math.min(...texts.map((t) => t.left)),
          textRight: Math.max(...texts.map((t) => t.right)),
          longLines: new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top))).size,
          vw: window.innerWidth,
        };
      });
      expect(m.box.left).toBeGreaterThanOrEqual(0);
      expect(m.box.right, "the list runs off the screen").toBeLessThanOrEqual(m.vw);
      expect(m.textRight, "an option's words run past the list").toBeLessThanOrEqual(m.box.right);
      expect(m.textLeft).toBeGreaterThanOrEqual(m.box.left);
      expect(m.longLines, "the long door name wraps").toBeGreaterThan(1);
    });
  }
});
