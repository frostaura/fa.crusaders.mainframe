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

function memberRoutes() {
  return [
    { path: "/api/v1/whoami", body: MEMBER },
    { path: "/api/v1/me/profile", body: PROFILE },
    { path: "/api/v1/wallet", body: { balance_minutes: 104, entries: [], total_entries: 0, offset: 0, limit: 100 } },
    { path: "/api/v1/me/door", body: { doors: true, doors_shut: "none" } },
    { path: "/api/v1/me/door/history", body: { items: [], has_more: false, retention_days: 45 } },
    { path: "/api/v1/me/webauthn/credentials", body: [] },
    { path: "/api/v1/credit/topup/options", body: { min_zar: 100, max_zar: 1000, block_zar: 100, presets_zar: [100, 200, 500, 1000], conversion_rate: 1.6 } },
    { path: "/api/v1/reports/me/wallet", body: WALLET_REPORT },
    { path: "/api/v1/reports/me/daily", body: DAYS_ME },
  ];
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`member pages at 360px, ${theme}`, () => {
    test.use({ viewport: { width: 360, height: 780 } });

    for (const [path, title] of [
      ["/wallet", "Wallet"], ["/wallet/topup", "Top up"], ["/profile", "Profile"],
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
  await expect(page.getByRole("region", { name: "Totals" })).toContainText("+160.00 cr");
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

test("the top-up amounts are a radio group: one tab stop, and every arrow key moves AND selects", async ({ page }) => {
  await signIn(page);
  await serveApi(page, memberRoutes());
  await page.goto("/wallet/topup");
  const group = page.getByRole("radiogroup", { name: "Amount" });
  const field = page.getByRole("textbox", { name: /Or enter an amount/ });
  const radio = (name: string) => group.getByRole("radio", { name, exact: true });
  await expect(radio("R100")).toBeVisible();

  await radio("R200").click();
  await expect(radio("R200")).toHaveAttribute("aria-checked", "true");
  // Roving tabindex: the checked radio is the group's one tab stop.
  const tabStops = async () => group.getByRole("radio").evaluateAll((els) => els.filter((e) => e.getAttribute("tabindex") === "0").map((e) => e.textContent));
  expect(await tabStops()).toEqual(["R200"]);

  // Right and Down move forward and select; Left and Up move back and select.
  for (const [key, name, value] of [
    ["ArrowRight", "R500", "500"], ["ArrowDown", "R1000", "1000"], ["ArrowLeft", "R500", "500"], ["ArrowUp", "R200", "200"],
  ] as const) {
    await page.keyboard.press(key);
    await expect(radio(name)).toBeFocused();
    await expect(radio(name), `${key} selects ${name}`).toHaveAttribute("aria-checked", "true");
    await expect(field).toHaveValue(value);
    expect(await tabStops()).toEqual([name]);
  }

  // Leaving and coming back by Tab lands on the chosen amount, not the first.
  await field.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(radio("R200")).toBeFocused();
});
