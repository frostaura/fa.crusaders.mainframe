import { expect, serveApi, SESSION_ADMIN, signIn, test } from "./fixtures";

/**
 * The member pages after the P2 shell work (R11 / R12 / R16 / D7), in a real browser.
 *
 * <ul>
 *   <li>Each page is one page shell — one h1, no sideways scroll at 360px — in both themes.</li>
 *   <li>The reports split: a member's `/reports` is their own activity (the wallet's second
 *   view), an admin's is the club's; neither asks for the other's figures.</li>
 *   <li>The charts repaint when the theme does. jsdom can only prove the palette is READ at
 *   render; this is where the painted fill is measured before and after.</li>
 * </ul>
 */

const MEMBER = { ...SESSION_ADMIN, is_admin: false };
const PROFILE = { full_name: "Nomsa Khumalo", email: "n@club.review.test", photo_url: null, membership_number: "P-1" };
const DAYS_ME = [
  { date: "2026-09-01", top_ups_minutes: 160, spent_minutes: 24, refunds_minutes: 8, bookings: 1, attended: 1, minutes_on_court: 45, balance_minutes: 136 },
  { date: "2026-09-02", top_ups_minutes: 0, spent_minutes: 24, refunds_minutes: -8, bookings: 1, attended: 0, minutes_on_court: 0, balance_minutes: 104 },
];
const WALLET_REPORT = {
  from: "", to: "", top_ups_minutes: 160, spent_minutes: 48, refunds_minutes: 0, penalties_minutes: 0,
  adjustments_minutes: 0, reversals_minutes: 0, net_movement_minutes: 112, penalty_count: 0, attended_bookings: 1, minutes_on_court: 45, count: 3,
};

const pkg = (id: string, name: string, minutes: number, price: number, saving: [number, number] | null) => ({
  id, name, minutes, list_price_zar: price, discount_bps: 0, price_zar: price,
  saving_zar: saving ? saving[0] : null, saving_pct: saving ? saving[1] : null, source: "club", group: null,
});
const PACKAGES = [pkg("p-1", "1 hour", 60, 120, null), pkg("p-5", "5 hours", 300, 550, [50, 8]), pkg("p-10", "10 hours", 600, 1000, [200, 16])];

function memberRoutes() {
  return [
    { path: "/api/v1/whoami", body: MEMBER },
    { path: "/api/v1/me/profile", body: PROFILE },
    { path: "/api/v1/wallet", body: { balance_minutes: 104, entries: [], total_entries: 0, offset: 0, limit: 100 } },
    { path: "/api/v1/me/door", body: { doors: true, doors_shut: "none" } },
    { path: "/api/v1/me/door/history", body: { items: [], has_more: false, retention_days: 45 } },
    { path: "/api/v1/me/webauthn/credentials", body: [] },
    { path: "/api/v1/minutes/packages", body: { discount: null, packages: PACKAGES, open_checkouts: [] } },
    { path: "/api/v1/reports/me/wallet", body: WALLET_REPORT },
    { path: "/api/v1/reports/me/daily", body: DAYS_ME },
  ];
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`member pages at 360px, ${theme}`, () => {
    test.use({ viewport: { width: 360, height: 780 } });

    for (const [path, title] of [
      ["/wallet", "Wallet"], ["/wallet/buy", "Buy minutes"], ["/profile", "Profile"],
      ["/reports", "Wallet activity"], ["/how-it-works", "How it works"],
    ] as const) {
      test(`${path} is one page, with one h1 and no sideways scroll`, async ({ page }) => {
        await page.addInitScript((t) => { window.localStorage.setItem("crusaders:theme", t); }, theme);
        await signIn(page);
        await serveApi(page, memberRoutes());
        await page.goto(path);

        const h1 = page.getByRole("heading", { level: 1 });
        await expect(h1).toHaveText(title);
        await expect(h1).toHaveCount(1);
        await expect(page.locator("html")).toHaveClass(theme === "dark" ? /dark/ : /^(?!.*dark).*$/);
        // Never "Loading…" as the answer, once the page has settled.
        await expect(page.getByText(/Loading…/)).toHaveCount(0);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, "the document scrolls sideways").toBeLessThanOrEqual(1);
      });
    }
  });
}

test("a member's /reports is their own activity, and never asks for the club's figures", async ({ page }) => {
  const asked: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/api/")) asked.push(new URL(r.url()).pathname); });
  await signIn(page);
  await serveApi(page, memberRoutes());
  await page.goto("/reports?from=2026-09-01&to=2026-09-02");

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Wallet activity");
  await expect(page.getByRole("region", { name: "Totals" })).toContainText("+2 h 40 min");
  // The wallet's second view, reachable from the first.
  await expect(page.getByRole("navigation", { name: "Wallet views" }).getByRole("link", { name: "Overview" })).toHaveAttribute("href", "/wallet");
  expect(asked.filter((p) => p.startsWith("/api/v1/admin/"))).toEqual([]);
});

test("the charts repaint in the new theme's colours without a reload", async ({ page }) => {
  await page.addInitScript(() => { window.localStorage.setItem("crusaders:theme", "light"); });
  await signIn(page);
  await serveApi(page, memberRoutes());
  await page.goto("/reports");

  // The balance area's stroke is the accent role: navy in light, the light-blue accent in dark.
  const stroke = () => page.locator("[data-testid=chart-frame] .recharts-area-curve").first().getAttribute("stroke");
  await expect.poll(stroke).toBe("#00498D");

  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await expect.poll(stroke).toBe("#8CBAF2");
  // And the axis text follows too — not a light-theme grey left on a dark card.
  const tick = await page.locator("[data-testid=chart-frame] .recharts-cartesian-axis-tick-value").first().getAttribute("fill");
  expect(tick).toBe("#90A0B8");
});

test("the packages are a radio group: one tab stop, and every arrow key moves AND selects", async ({ page }) => {
  await signIn(page);
  await serveApi(page, memberRoutes());
  await page.goto("/wallet/buy");
  const group = page.getByRole("radiogroup", { name: "Packages" });
  const radios = group.getByRole("radio");
  await expect(radios).toHaveCount(3);

  await radios.nth(1).click();
  await expect(radios.nth(1)).toHaveAttribute("aria-checked", "true");
  // Roving tabindex: the checked radio is the group's one tab stop.
  const tabStops = async () => radios.evaluateAll((els) => els.flatMap((e, i) => (e.getAttribute("tabindex") === "0" ? [i] : [])));
  expect(await tabStops()).toEqual([1]);

  // Right and Down move forward and select; Left and Up move back and select.
  for (const [key, index] of [["ArrowRight", 2], ["ArrowLeft", 1], ["ArrowUp", 0], ["ArrowDown", 1]] as const) {
    // Held, as a finger holds it: Radix moves focus in a 0 ms timeout and checks the radio only
    // while the arrow is still down — Playwright's press() releases it before that timeout runs.
    await page.keyboard.down(key);
    await expect(radios.nth(index)).toBeFocused();
    await page.keyboard.up(key);
    await expect(radios.nth(index), `${key} selects package ${index}`).toHaveAttribute("aria-checked", "true");
    expect(await tabStops()).toEqual([index]);
  }
});
