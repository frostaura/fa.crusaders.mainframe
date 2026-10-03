import { signIn, test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

/**
 * P13 — `/wallet/buy`, the package shelf, in a real browser at a phone and a desktop width (the
 * mobile and desktop projects). The shelf uses the width it has: on a desktop the cards stand in
 * columns with the purchase summary as a rail beside them; on a phone they stack and the price with
 * Continue is docked in thumb reach. The open purchases (review round 5, M5-2) each carry a Cancel,
 * and nothing anywhere scrolls sideways.
 *
 * <p>
 * It opens `/wallet/topup`: until the route table moves that IS the page, and after it the old
 * path redirects to `/wallet/buy` (§12.14) — either way the member lands on the shelf.
 * </p>
 */

const SESSION_MEMBER = {
  tenant_slug: "crusaders",
  tenant_id: "00000000-0000-0000-0000-000000000001",
  user_id: "00000000-0000-0000-0000-000000000002",
  is_authenticated: true,
  is_admin: false,
};

const A = "aaaa0000-0000-0000-0000-0000000000a1";
const B = "bbbb0000-0000-0000-0000-0000000000b2";
const pkg = (id: string, name: string, minutes: number, price: number, saving: [number, number] | null) => ({
  id, name, minutes, list_price_zar: price, discount_bps: 0, price_zar: price,
  saving_zar: saving ? saving[0] : null, saving_pct: saving ? saving[1] : null, source: "club", group: null,
});
const PACKAGES = [
  pkg("p-1", "1 hour", 60, 120, null),
  pkg("p-5", "5 hours", 300, 550, [50, 8]),
  pkg("p-10", "10 hours", 600, 1000, [200, 16]),
];
const OPEN = [
  { id: B, package_name: "10 hours", minutes: 600, amount_zar: 1000, created_at: "2026-10-01T12:40:00Z", expires_at: "2026-10-01T13:40:00Z" },
  { id: A, package_name: "1 hour", minutes: 60, amount_zar: 120, created_at: "2026-10-01T12:05:00Z", expires_at: "2026-10-01T13:05:00Z" },
];

async function stubShelf(page: Page, open: typeof OPEN, cancelled: Set<string>) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    const cancel = /\/api\/v1\/minutes\/purchase\/([^/]+)\/cancel$/.exec(path);
    if (cancel && route.request().method() === "POST") {
      cancelled.add(cancel[1]);
      const row = OPEN.find((o) => o.id === cancel[1])!;
      return json({ ...row, status: "Cancelled", package_id: "p-1", list_price_zar: row.amount_zar, discount_bps: 0, failure_code: "cancelled_at_return" });
    }
    if (path === "/api/v1/minutes/packages") {
      return json({ discount: null, packages: PACKAGES, open_checkouts: open.filter((o) => !cancelled.has(o.id)) });
    }
    if (path.startsWith("/api/v1/whoami")) return json(SESSION_MEMBER);
    if (path.startsWith("/api/v1/wallet")) return json({ balance_minutes: 0, entries: [], total_entries: 0, offset: 0, limit: 50 });
    if (path.startsWith("/api/v1/me/profile")) {
      return json({ full_name: "Nomsa Khumalo", email: "n@test.local", photo_url: null, membership_number: "P-1" });
    }
    return route.fulfill({ status: 501, contentType: "application/json", body: "{}" });
  });
}

async function sideways(page: Page): Promise<number> {
  return page.evaluate(() => {
    const main = document.getElementById("main-content");
    return Math.max(...[document.documentElement, main].filter(Boolean).map((el) => el!.scrollWidth - el!.clientWidth));
  });
}

test("the shelf uses the width it has, and one Cancel closes an open purchase", async ({ page }, info) => {
  const width = page.viewportSize()?.width ?? 0;
  await signIn(page);
  const cancelled = new Set<string>();
  await stubShelf(page, OPEN, cancelled);

  await page.goto("/wallet/topup");
  await expect(page).toHaveURL(/\/wallet\/(topup|buy)$/);
  const cards = page.getByRole("radio");
  await expect(cards).toHaveCount(3);
  await expect(page.getByRole("radio", { name: "10 hours" })).toContainText("Saves R200.00 (16%)");
  await expect(page.getByRole("radio", { name: "10 hours" })).toContainText("10 h");
  await expect(page.getByText(/credit|top up|limit/i)).toHaveCount(0);

  const tops = await Promise.all((await cards.all()).map(async (c) => Math.round((await c.boundingBox())!.y)));
  if (width >= 1024) {
    // Columns, not a centred narrow stack: at least two cards share a row, and the summary is a rail.
    expect(new Set(tops).size, `card tops ${tops.join(",")}`).toBeLessThan(3);
    const rail = page.getByRole("complementary", { name: "Your purchase" });
    await expect(rail).toBeVisible();
    const railBox = (await rail.boundingBox())!;
    const cardBox = (await cards.first().boundingBox())!;
    expect(railBox.x).toBeGreaterThan(cardBox.x + cardBox.width - 1);
  } else {
    // A clean stack, and the one verb docked in thumb reach.
    expect(new Set(tops).size).toBe(3);
    await expect(page.locator("[data-context-bar='bottom']")).toBeVisible();
  }

  await page.getByRole("radio", { name: "5 hours" }).click();
  await expect(page.getByRole("button", { name: /Continue to PayFast/ }).first()).toBeEnabled();

  const cancels = page.getByRole("button", { name: /^Cancel the / });
  await expect(cancels).toHaveCount(2);
  for (const button of await cancels.all()) {
    expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  expect(await sideways(page)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: info.outputPath(`shelf-${width}.png`), fullPage: true });

  await page.getByRole("button", { name: /^Cancel the 1 hour \(1 h\) for R120\.00 purchase/ }).click();
  await expect(page.getByText("Cancelled. Nothing was charged.")).toBeVisible();
  await expect(cancels).toHaveCount(1);
  expect(cancelled.has(A)).toBe(true);
  await page.screenshot({ path: info.outputPath(`after-${width}.png`), fullPage: true });
});

/** X5-11 — at 320px with 200% text nothing on the shelf scrolls sideways, open purchases showing. */
test("nothing scrolls sideways at 320px with 200% text", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await signIn(page);
  await stubShelf(page, [OPEN[1]], new Set());
  await page.goto("/wallet/topup");
  await page.addStyleTag({ content: "html { font-size: 32px; }" });
  await expect(page.getByRole("radio", { name: "5 hours" })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const wide = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const main = document.getElementById("main-content");
    return [...(main ?? document.body).querySelectorAll("*")]
      .filter((el) => el.getBoundingClientRect().right > vw + 1 && !el.closest(".sr-only"))
      .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)} @${Math.round(el.getBoundingClientRect().right)}`)
      .slice(0, 12);
  });
  expect(wide, "laid out past the right edge").toEqual([]);
  expect(await sideways(page), "sideways scroll").toBeLessThanOrEqual(1);
});
