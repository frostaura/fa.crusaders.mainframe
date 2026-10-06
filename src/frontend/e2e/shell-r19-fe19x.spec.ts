import type { Page } from "@playwright/test";
import { SESSION_ADMIN, SESSION_ANON, serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";

test.describe.configure({ timeout: 120_000 });

/**
 * Review round 19, lane FE19x — measured in Chromium at the sizes the reviewers used.
 *
 * <ul>
 *   <li><b>L19-6</b> — the printable door card's padding was `p-6` (rem): 48px a side at 200 % text,
 *   leaving a 158px text column on a 320px phone. Capped, the column keeps at least ~70 % of the
 *   screen at 320 and 390 / 200 %, and the paper look is unchanged at normal text.</li>
 *   <li><b>X19-3</b> — the toasts' polite live region is in the page before any toast, empty, and a
 *   toast's words arrive in it; the toast is not a live region of its own; its × is a named button
 *   that dismisses it.</li>
 * </ul>
 */

const ARRIVES = { timeout: 45_000 };

async function bigText(page: Page, px = 32) {
  await page.addInitScript((size) => document.addEventListener("DOMContentLoaded", () => {
    document.documentElement.style.fontSize = `${size}px`;
  }), px);
}

const DOOR_ID = "99999999-9999-9999-9999-999999999999";

function doorRoutes(): ApiRoute[] {
  const door = {
    id: DOOR_ID, device_code: "gate-0a1b2c", name: "Side door", kind: "Gate", hardware: "Esp32", court_numbers: [],
    gate_key: "side-door", mac_address: "5ccf7f0a1b2c", enabled: true, last_seen_at: new Date().toISOString(),
    last_ip_address: "192.168.68.160", running_version: "1.0.0", mega_version: null, created_at: new Date().toISOString(),
    auto_registered: false, effective_heartbeat_seconds: 60,
    location_note: "In the cupboard above the fuse board, behind the squash racquet rack",
    power_loss_behaviour: "released", out_of_service_since: null,
  };
  return [
    { path: "/api/v1/whoami", body: SESSION_ADMIN },
    { path: "/api/v1/me/profile", body: { full_name: "Crusaders Admin", email: "admin@sample.local", photo_url: null, membership_number: "ADMIN-0001" } },
    { path: "/api/v1/wallet", body: { balance_minutes: 0, entries: [], count: 0 } },
    { path: "/api/v1/admin/members", body: [] },
    { path: "/api/v1/admin/settings/", body: {
      timezone: "Africa/Johannesburg", club_contact_phone: "076 226 1390", club_contact_email: "desk@crusaders.review.test",
    } },
    { path: "/api/v1/admin/doors", body: {
      day_started_at: new Date().toISOString(), timezone: "Africa/Johannesburg", shut_all_active: false,
      shut_together: [], shut_individually: [], doors: [{ device: door, today: { released: 0, refused: 0 }, signals: [] }],
    } },
  ];
}

/** The card's content box (inside its padding) and its padding, in px. */
async function sheetBox(page: Page) {
  const sheet = page.locator("[data-print-sheet]");
  await expect(sheet).toBeVisible(ARRIVES);
  await expect(page.getByText(/In the cupboard above the fuse board/)).toBeVisible(ARRIVES);
  return sheet.evaluate((el) => {
    const cs = getComputedStyle(el);
    const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const border = parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
    return { column: el.getBoundingClientRect().width - pad - border, padLeft: parseFloat(cs.paddingLeft), viewport: window.innerWidth };
  });
}

for (const width of [320, 390]) {
  test(`L19-6 — the door card's text column at ${width} / 200 % keeps at least ~70 % of the screen`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await signIn(page);
    await serveApi(page, doorRoutes());
    await bigText(page);
    await page.goto(`/admin/doors/${DOOR_ID}/card`);
    const box = await sheetBox(page);
    expect(box.column / box.viewport, `column ${box.column}px of ${box.viewport}px (padding ${box.padLeft}px a side)`).toBeGreaterThanOrEqual(0.7);
  });
}

test("L19-6 — at normal text on a desktop the card keeps its 24px paper margin", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page);
  await serveApi(page, doorRoutes());
  await page.goto(`/admin/doors/${DOOR_ID}/card`);
  const box = await sheetBox(page);
  expect(box.padLeft).toBe(24);
});

test("X19-3 — the toast region is there and empty before a toast, the toast's words arrive in it, and × dismisses", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await serveApi(page, [
    { path: "/api/v1/whoami", body: SESSION_ANON },
    { path: "/api/v1/session", body: SESSION_ANON },
  ]);
  await page.goto("/dev/primitives?section=feedback&theme=light");
  await expect(page.locator('[data-gallery-section="feedback"]')).toBeVisible(ARRIVES);
  const region = page.locator("[data-toast-viewport]");
  await expect(region).toHaveAttribute("aria-live", "polite");
  await expect(region).toHaveText("");
  await expect(page.locator("[data-toast]")).toHaveCount(0);

  await page.getByRole("button", { name: "Toast: success" }).first().click();
  const toast = region.locator("[data-toast]");
  await expect(toast).toHaveCount(1);
  await expect(region).not.toHaveText("");
  await expect(toast).not.toHaveAttribute("role", /.+/);
  await expect(toast).not.toHaveAttribute("aria-label", /.+/);
  // Nothing inside the region is a live region of its own (C10: nested regions announced twice).
  await expect(region.locator("[aria-live], [role=status], [role=alert]")).toHaveCount(0);
  const dismiss = toast.getByRole("button", { name: "Dismiss" });
  await expect(dismiss).toBeVisible();
  const box = (await dismiss.boundingBox())!;
  expect(box.width, "the × is a 24px mark").toBeGreaterThanOrEqual(24);
  await dismiss.focus();
  await page.keyboard.press("Enter");
  await expect(toast).toHaveCount(0, { timeout: 5_000 });
});
