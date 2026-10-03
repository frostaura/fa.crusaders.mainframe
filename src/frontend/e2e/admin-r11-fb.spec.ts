import { type Locator, type Page } from "@playwright/test";
import { SESSION_ADMIN, serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { memberShellRoutes } from "./playersKit";
import { ADD_LINK, TAKE_BACK_LINK } from "../src/lib/deskMinutesCopy";

// A cold dev server compiles the admin frame on first ask, and the machine is shared.
test.describe.configure({ timeout: 90_000 });

/**
 * Review round 11, lane FB11 — L10-1 re-checked after the primitive fix (L11-2). Round 10 pinned
 * that "Take minutes back instead" stays inside the sheet's width; round 11 found the column-flex
 * body SHRANK the wrapping button to its 44 px minimum, so a two-line label spilled out of its box
 * downwards. Both labels of the flip are measured here in both directions, in Chromium.
 */

const USER = "00000000-0000-4000-8000-000000001101";
const BIG = "html { font-size: 32px; }";

const member = {
  user_id: USER, membership_id: "00000000-0000-4000-8000-000000001111", full_name: "Bea Nkosi",
  email: "bea@r11.review.test", membership_number: "MEM-1101", status: "Active", email_verified: true,
  balance_minutes: 120, created_at: "2026-09-01T08:00:00Z", photo_url: null, is_admin: false, admin_source: null, groups: [],
};
const detail = {
  ...member, account_status: "active", last_login_at: null, passkey_count: 0,
  fingerprints: { count: 0, enrolments: [] }, next_bookings: [], counts_30d: { bookings: 0, no_shows: 0, sessions_played: 0 },
};

function routes(): ApiRoute[] {
  return [
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

async function openAdjust(page: Page, width: number) {
  await page.setViewportSize({ width, height: 640 });
  await signIn(page);
  await serveApi(page, routes());
  await page.goto(`/admin/members/${USER}`);
  const more = page.getByRole("button", { name: "More actions for Bea Nkosi" });
  await expect(more).toBeVisible({ timeout: 30_000 });
  await more.click();
  await page.getByRole("menuitem", { name: "Adjust minutes", exact: true }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  await page.addStyleTag({ content: BIG });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => Promise.all(document.getAnimations()
    .filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => null))));
  return sheet;
}

/** The label's own text boxes against the button's box, and the body's width. */
async function fits(button: Locator, body: Locator) {
  await button.scrollIntoViewIfNeeded();
  const b = (await body.boundingBox())!;
  return button.evaluate((el, bodyBox) => {
    const r = el.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(el);
    const text = [...range.getClientRects()].filter((x) => x.width > 0);
    const bottom = Math.max(...text.map((x) => x.bottom));
    const top = Math.min(...text.map((x) => x.top));
    return {
      insideWidth: r.left >= bodyBox.x - 1 && r.right <= bodyBox.x + bodyBox.width + 1,
      textInsideBox: top >= r.top - 1 && bottom <= r.bottom + 1,
      clipped: el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1,
    };
  }, b);
}

test.describe("L10-1 / L11-2 — the flip button holds its label at 200 % text", () => {
  for (const width of [320, 390]) {
    test(`at ${width} / 200 %, both directions`, async ({ page }) => {
      const sheet = await openAdjust(page, width);
      const body = sheet.locator("[data-slot='dialog-body']");
      const take = sheet.getByRole("button", { name: TAKE_BACK_LINK });
      expect(await fits(take, body)).toEqual({ insideWidth: true, textInsideBox: true, clipped: false });
      await take.click();
      const add = sheet.getByRole("button", { name: ADD_LINK });
      expect(await fits(add, body)).toEqual({ insideWidth: true, textInsideBox: true, clipped: false });
      await page.screenshot({ path: test.info().outputPath(`flip-${width}.png`) });
    });
  }
});
