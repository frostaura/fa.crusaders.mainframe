import { type Locator, type Page } from "@playwright/test";
import { SESSION_ADMIN, serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { memberShellRoutes } from "./playersKit";
import { PAYMENT_CHOICES, SELL_COPY, TAKE_BACK_LINK } from "../src/lib/deskMinutesCopy";
import { formatMoney } from "../src/lib/utils";

// A cold dev server compiles the admin frame on first ask, and the machine is shared.
test.describe.configure({ timeout: 90_000 });

/**
 * Review round 10, lane FB10 (money & desk) — measured in Chromium against a mocked API: what jsdom
 * cannot see. L10-1: "Take minutes back instead" was a 415 px nowrap button clipped at 320/390 and
 * 200 % text. J10-4 / X10-2: after a 409 `package_price_changed` the notice sat out of view at
 * 390 / 200 % while "Money received" changed, and focus fell to the dialog container.
 */

const USER = "00000000-0000-4000-8000-000000001001";
const BIG = "html { font-size: 32px; }";

const member = {
  user_id: USER, membership_id: "00000000-0000-4000-8000-000000001011", full_name: "Bea Nkosi",
  email: "bea@r10.review.test", membership_number: "MEM-1001", status: "Active", email_verified: true,
  balance_minutes: 120, created_at: "2026-09-01T08:00:00Z", photo_url: null, is_admin: false, admin_source: null, groups: [],
};
const detail = {
  ...member, account_status: "active", last_login_at: null, passkey_count: 0,
  fingerprints: { count: 0, enrolments: [] }, next_bookings: [], counts_30d: { bookings: 0, no_shows: 0, sessions_played: 0 },
};

const shelfItem = (id: string, name: string, minutes: number, list: number, bps: number, price: number) => ({
  id, name, minutes, list_price_zar: list, discount_bps: bps, price_zar: price, saving_zar: null, saving_pct: null, source: "club", group: null,
});
const HOUR = shelfItem("00000000-0000-0000-0000-0000000000a1", "1 hour", 60, 120, 1000, 108);
const HOUR_NOW = { ...HOUR, discount_bps: 2000, price_zar: 96 };
const LEAGUE = { id: "g1", name: "League" };

function routes(extra: ApiRoute[] = []): ApiRoute[] {
  return [
    ...extra,
    ...memberShellRoutes({ admin: true }),
    { path: "/api/v1/whoami", body: SESSION_ADMIN },
    { path: "/api/v1/admin/doors", body: { doors: [], shut_together: [], shut_individually: [], timezone: "Africa/Johannesburg" } },
    { path: "/api/v1/admin/monitoring/summary", body: { open: {} } },
    { path: "/api/v1/admin/play/results/disputed/count", body: { count: 0 } },
    { path: "/api/v1/admin/biometric/enrollments", body: [] },
    { path: "/api/v1/admin/member-groups", body: { groups: [] } },
    { path: "/api/v1/admin/ledger/", body: [] },
    { path: `/api/v1/admin/members/${USER}`, body: detail },
    { path: "/api/v1/admin/members/", body: [member] },
  ];
}

async function openSheet(page: Page, width: number, item: string, extra: ApiRoute[] = []) {
  await page.setViewportSize({ width, height: 844 });
  await signIn(page);
  await serveApi(page, routes(extra));
  // The member's page offers Adjust in its ⋯; Sell lives on the list's card (in its ⋯ below 48rem).
  await page.goto(item === "Sell package" ? "/admin/members" : `/admin/members/${USER}`);
  const more = page.getByRole("button", { name: "More actions for Bea Nkosi" });
  await expect(more).toBeVisible({ timeout: 30_000 });
  await more.click();
  await page.getByRole("menuitem", { name: item, exact: true }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  return sheet;
}

async function big(page: Page) {
  await page.addStyleTag({ content: BIG });
  await page.evaluate(() => document.fonts.ready);
  await settled(page);
}

/** Once the sheet has finished sliding in, not mid-animation. */
function settled(page: Page) {
  return page.evaluate(() => Promise.all(document.getAnimations()
    .filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => null))));
}

/** Words cut across lines ("Ta/ke"): a run of non-space characters whose line boxes sit on two lines. */
function brokenWords(el: Locator): Promise<string[]> {
  return el.evaluate((root) => {
    const out: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? "";
      if (node.parentElement?.closest(".sr-only")) continue;
      for (const m of text.matchAll(/[^\s\u00a0-]+-?/g)) {
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

test.describe("L10-1 — Take minutes back instead wraps inside the sheet at 200 % text", () => {
  for (const width of [320, 390]) {
    test(`at ${width} / 200 %`, async ({ page }) => {
      const sheet = await openSheet(page, width, "Adjust minutes");
      await big(page);
      const flip = sheet.getByRole("button", { name: TAKE_BACK_LINK });
      await expect(flip).toBeVisible();
      const body = (await sheet.locator("[data-slot='dialog-body']").boundingBox())!;
      const box = (await flip.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(body.x - 1);
      expect(box.x + box.width, "the button runs past the sheet's body").toBeLessThanOrEqual(body.x + body.width + 1);
      expect(await flip.evaluate((el) => el.scrollWidth > el.clientWidth + 1), "the label is clipped").toBe(false);
      expect(await brokenWords(flip)).toEqual([]);
    });
  }
});

test.describe("J10-4 / X10-2 — a moved price is seen, and the keyboard lands on Sell", () => {
  test("at 390 / 200 %", async ({ page }) => {
    const sheet = await openSheet(page, 390, "Sell package", [
      { path: `/api/v1/admin/minutes/${USER}/packages`, body: { discount: { bps: 1000, group: LEAGUE }, packages: [HOUR] } },
      { method: "POST", path: `/api/v1/admin/minutes/${USER}/sell`, status: 409, body: { error: "package_price_changed", package: HOUR_NOW, discount: { bps: 2000, group: LEAGUE } } },
    ]);
    await big(page);
    await sheet.getByRole("radio", { name: /1 hour/ }).click();
    await sheet.getByRole("button", { name: SELL_COPY.next }).click();
    await sheet.getByRole("combobox", { name: SELL_COPY.paymentLabel }).click();
    await page.getByRole("option", { name: PAYMENT_CHOICES[0].label }).click();
    await sheet.getByLabel(SELL_COPY.detailLabel).fill("Receipt 7");
    await sheet.getByRole("button", { name: SELL_COPY.next }).click();
    // Scrolled to the bottom of the check, where the admin is when they press Sell.
    await sheet.locator("[data-slot='dialog-body']").evaluate((el) => { el.scrollTop = el.scrollHeight; });
    const sell = sheet.getByRole("button", { name: /^Sell / });
    await sell.focus();
    await page.keyboard.press("Enter");
    await page.locator("[data-confirm='go']").focus();
    await page.keyboard.press("Enter");
    const notice = sheet.locator("[data-sale-notice]");
    await expect(notice).toContainText(SELL_COPY.priceChanged(formatMoney(96), formatMoney(108)));
    await settled(page);
    const body = (await sheet.locator("[data-slot='dialog-body']").boundingBox())!;
    const seen = (await notice.boundingBox())!;
    expect(seen.y, "the notice is above the body's top edge").toBeGreaterThanOrEqual(body.y - 1);
    expect(seen.y, "the notice starts below the body's bottom edge").toBeLessThan(body.y + body.height);
    await expect.poll(() => page.evaluate(() => {
      const el = document.activeElement;
      return el?.closest("[data-sale-confirm]") !== null && el?.tagName === "BUTTON" && !el.hasAttribute("data-confirm");
    }), { message: "focus is on Sell" }).toBe(true);
  });
});
