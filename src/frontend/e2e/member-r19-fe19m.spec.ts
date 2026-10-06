import { type Locator, type Page } from "@playwright/test";
import { expect, serveApi, signIn, test, type ApiRoute } from "./fixtures";
import { PEOPLE, inviteFixture, memberShellRoutes, tomorrowAt } from "./playersKit";

/**
 * Review round 19, lane FE19m — measured in Chromium.
 *
 * <ul>
 *   <li><b>L19-2</b> — the chip's flyout ("+1 h · 15 min back to Sam") was centred over the chip and
 *   nowrap: at 1024 / 150 % it ran 37px past the screen (the page scrolled sideways), over the
 *   avatar, at y &lt; 0. It now hangs under the chip from its right edge and wraps.</li>
 *   <li><b>L19-8</b> — the bell's "9+" was 46px wide at 200 % and lay 31px over the chip (15px over
 *   the avatar on a phone). It stays inside the bell's own 44px box.</li>
 *   <li><b>L19-3</b> — "3 / players", "10 / min", "9 h 10 / min", "8 / hours", "15 / minutes": a
 *   figure never ends a line without its unit.</li>
 * </ul>
 */

test.describe.configure({ timeout: 120_000 });

type Box = { left: number; right: number; top: number; bottom: number };

async function large(page: Page, root: number) {
  if (root !== 16) await page.addStyleTag({ content: `html { font-size: ${root}px; }` });
  await page.evaluate(() => document.fonts.ready);
}

async function box(target: Locator): Promise<Box | null> {
  return target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom } : null;
  });
}

function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
}

/** Text the browser broke between a figure and the word after it (a Range over "15 min" on two lines). */
async function splitFigures(target: Locator): Promise<string[]> {
  return target.evaluate((root) => {
    const out: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || parent.closest(".sr-only")) continue;
      const text = node.textContent ?? "";
      const re = /\d[\d:.,]*[\s\u00a0]+\p{L}+/gu;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        const range = document.createRange();
        range.setStart(node, m.index);
        range.setEnd(node, m.index + m[0].length);
        const tops = new Set([...range.getClientRects()].filter((r) => r.width > 0.5).map((r) => Math.round(r.top)));
        if (tops.size > 1) out.push(m[0]);
      }
    }
    return out;
  });
}

/** A fake wallet stream the test pushes frames into (as R18's X18-2 spec does). */
async function fakeStream(page: Page) {
  await page.addInitScript(() => {
    class FakeSource extends EventTarget {
      url: string; readyState = 1; onopen: ((e: Event) => void) | null = null; onmessage: ((e: MessageEvent) => void) | null = null; onerror: ((e: Event) => void) | null = null;
      constructor(url: string) {
        super();
        this.url = url;
        (window as unknown as { __streams: FakeSource[] }).__streams.push(this);
        setTimeout(() => this.onopen?.(new Event("open")), 0);
      }
      close() { this.readyState = 2; }
      push(frame: unknown) { this.dispatchEvent(new MessageEvent("balance", { data: JSON.stringify(frame) })); }
    }
    (window as unknown as { __streams: FakeSource[] }).__streams = [];
    (window as unknown as { EventSource: unknown }).EventSource = FakeSource;
  });
  return (frame: unknown) => page.evaluate((f) => {
    const s = (window as unknown as { __streams: { push: (x: unknown) => void; readyState: number }[] }).__streams.filter((x) => x.readyState === 1);
    s[s.length - 1].push(f);
  }, frame);
}

function inboxRoutes(unread: number): ApiRoute[] {
  return [
    { method: "POST", path: "/api/v1/wallet/stream-ticket", body: { ticket: "t", expires_in_seconds: 60 } },
    { path: "/api/v1/me/notifications", body: { items: [], unread_count: unread, next_cursor: null } },
    ...memberShellRoutes({ unread, wallet: { balance_minutes: 155, held_minutes: 15, spendable_minutes: 140 } }),
  ];
}

for (const [width, root] of [[1024, 24], [1440, 16], [768, 16], [1920, 32], [768, 32]] as const) {
  test(`L19-2 — the flyout stays under the chip, on the screen, clear of the bell and the avatar at ${width} / ${root * 100 / 16} %`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const push = await fakeStream(page);
    await signIn(page);
    await serveApi(page, inboxRoutes(3));
    await page.goto("/inbox", { timeout: 90_000 });
    await large(page, root);
    await page.waitForFunction(() => (window as unknown as { __streams: unknown[] }).__streams.length > 0);
    const chip = page.locator("[data-minutes-chip]");
    await expect(chip).toBeVisible();
    await push({ balance_minutes: 155, held_minutes: 15, spendable_minutes: 140 });
    await push({
      balance_minutes: 200, delta_minutes: 45, reason: "cancellation_refund", held_minutes: 0, spendable_minutes: 200,
      parts: [{ reason: "cancellation_refund", delta_minutes: 60 }, { reason: "share_transfer", delta_minutes: -15, counterparty_name: "Sam Naidoo" }],
    });
    const flyout = page.locator("[data-balance-flyout]");
    await expect(flyout).toContainText(/back to Sam/);
    const header = (await box(page.locator("[data-app-header]")))!;
    const chipBox = (await box(chip))!;
    const bell = (await box(page.locator("[data-notification-bell]")))!;
    const avatar = (await box(page.locator("[data-account-menu]")))!;
    // Sampled across the rise (900 ms): the box moves 14px over its life.
    for (let i = 0; i < 6; i++) {
      const f = await box(flyout);
      if (!f) break;
      const vw = await page.evaluate(() => window.innerWidth);
      expect(f.right, "inside the screen's right edge").toBeLessThanOrEqual(vw);
      expect(f.left, "inside the screen's left edge").toBeGreaterThanOrEqual(0);
      expect(f.top, "never above the bar").toBeGreaterThanOrEqual(header.top);
      expect(f.top, "under the chip's row").toBeGreaterThanOrEqual(chipBox.bottom);
      expect(overlaps(f, bell), "never over the bell").toBe(false);
      expect(overlaps(f, avatar), "never over the avatar").toBe(false);
      expect(Math.abs(f.right - chipBox.right), "anchored to the chip's right edge").toBeLessThanOrEqual(1);
      expect(await splitFigures(flyout)).toEqual([]);
      const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(sideways, "no page scroll sideways").toBeLessThanOrEqual(0);
      await page.waitForTimeout(140);
    }
  });
}

for (const [width, root] of [[320, 32], [390, 32], [1920, 32], [1440, 16], [390, 16]] as const) {
  test(`L19-8 — the bell's "9+" stays inside the bell at ${width} / ${root * 100 / 16} %`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await signIn(page);
    await serveApi(page, inboxRoutes(12));
    await page.goto("/inbox", { timeout: 90_000 });
    await large(page, root);
    const badge = page.locator("[data-unread-badge]");
    await expect(badge).toHaveText("9+");
    const b = (await box(badge))!;
    const bell = (await box(page.locator("[data-notification-bell]")))!;
    const avatar = (await box(page.locator("[data-account-menu]")))!;
    expect(b.right, "the badge's right edge is the bell's").toBeLessThanOrEqual(bell.right + 0.5);
    expect(b.top, "not cut by the top of the screen").toBeGreaterThanOrEqual(0);
    expect(overlaps(b, avatar), "clear of the avatar").toBe(false);
    const chip = page.locator("[data-minutes-chip]");
    if (await chip.isVisible()) expect(overlaps(b, (await box(chip))!), "clear of the chip").toBe(false);
    // The count is still readable: whole, and not clipped by its own box.
    expect(await badge.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  });
}

for (const [width, root] of [[320, 32], [390, 32], [320, 24], [768, 32]] as const) {
  test(`L19-3 — figures stay whole on the invite card, the wallet's figure and an inbox notice at ${width} / ${root * 100 / 16} %`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await signIn(page);
    const notice = {
      id: "n1", kind: "players.share_moved", link: null, booking_id: null, created_at: new Date().toISOString(), read_at: null,
      headline: "Sam paid you 15 minutes for their share of Court 1 · Wed 30 Sep, and 25 minutes more came back to you on 3 Oct",
    };
    await serveApi(page, [
      { path: "/api/v1/me/notifications", body: { items: [notice], unread_count: 1, next_cursor: null } },
      ...memberShellRoutes({
        unread: 1,
        invites: [inviteFixture({ players: 3, share_minutes: 10, organiser: PEOPLE.sam })],
        // Held minutes too: the card's held line ("You can spend 8 hours 45 minutes", "held until Wed 7 Oct").
        wallet: { balance_minutes: 550, held_minutes: 25, spendable_minutes: 525, held_until: tomorrowAt(20, 45) },
      }),
    ]);
    for (const [path, target] of [["/invites", "[data-invite]"], ["/wallet", "[data-balance-level]"], ["/inbox", "[data-notification]"]] as const) {
      await page.goto(path, { timeout: 90_000 });
      await large(page, root);
      const found = page.locator(target).first();
      await expect(found).toBeVisible();
      expect(await splitFigures(found), `${path}: no figure parted from its unit`).toEqual([]);
    }
  });
}
