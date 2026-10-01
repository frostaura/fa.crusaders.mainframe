import { type Page } from "@playwright/test";
import { SESSION_ADMIN, serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { CLUB_ZONE, inviteFixture, memberShellRoutes } from "./playersKit";
import { resultFixture, RESULT_ID } from "./playKit";
import { INBOX_COPY, INVITES_COPY, askedAgainLine } from "../src/lib/playersCopy";
import { ADMIN_RESULT_UNSURE, ADMIN_RESULTS } from "../src/lib/playCopy";

/**
 * Review round 4, lane F2 — the behaviour fixes in a real browser, on a phone at 200 % text
 * (390 and 320 wide): the asked-again heading (M4-8), the share-cap day in words (X4-9), Mark all
 * read's focus and announcement (X4-5), and a lost reply said inside the admin's Remove dialog
 * with the typed reason kept (I4-6 / ConfirmDialog `describe`).
 */

const WIDTHS = [390, 320] as const;
const SEAT = "p0000000-0000-0000-0000-000000000003";

async function phone(page: Page, width: number, routes: ApiRoute[], path: string) {
  await page.setViewportSize({ width, height: 844 });
  await signIn(page);
  await serveApi(page, routes);
  await page.goto(path);
  await page.addStyleTag({ content: "html { font-size: 32px; }" });
}

/** Nothing on the page scrolls sideways. */
async function noSideways(page: Page) {
  const wide = await page.evaluate(() => [...document.querySelectorAll("main, main *")]
    .some((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== "visible" && getComputedStyle(el).overflowX !== "hidden"));
  expect(wide, "something scrolls sideways").toBe(false);
}

for (const width of WIDTHS) {
  test.describe(`at ${width} px with 200 % text`, () => {
    test("a partner asked again reads \"Your share went up\", and a cap names its day in words (M4-8, X4-9)", async ({ page }) => {
      const asked = inviteFixture({
        participant_id: SEAT, status: "accepted", needs_consent: true, share_minutes: 30, to_pay_minutes: 5,
        cap: { cap: "slots", cap_slots: 4, booked_slots: 4, attempted_slots: 3, club_day: "2030-09-10" },
      });
      await phone(page, width, [
        { path: "/api/v1/me/invites", body: { items: [asked], count: 1, timezone: CLUB_ZONE } },
        ...memberShellRoutes(),
      ], `/invites/${SEAT}`);
      await expect(page.getByRole("heading", { level: 1, name: INVITES_COPY.askedAgainTitle })).toBeVisible();
      await expect(page.getByText(askedAgainLine("Nomsa", 30))).toBeVisible();
      await expect(page.getByRole("heading", { level: 1, name: INVITES_COPY.linkTitle })).toHaveCount(0);
      await expect(page.getByText(/a day on Tue 10 Sep\./).first()).toBeVisible();
      await expect(page.getByText(/2030-09-10/)).toHaveCount(0);
      await noSideways(page);
      await page.screenshot({ path: test.info().outputPath(`asked-again-${width}.png`) });
    });

    test("Mark all read moves focus to the list and says \"All read\" (X4-5)", async ({ page }) => {
      let unread = 2;
      const at = new Date(Date.now() - 5 * 60_000).toISOString();
      const items = () => [
        { id: "n1", kind: "players.share_moved", headline: "Sam paid their 25.00 cr share", link: null, booking_id: "b1", created_at: at, read_at: unread ? null : at },
        { id: "n2", kind: "players.reminder", headline: "Your share for Friday is still open", link: null, booking_id: "b2", created_at: at, read_at: unread ? null : at },
      ];
      await phone(page, width, [
        { path: "/api/v1/me/notifications/unread-count", respond: () => ({ unread_count: unread }) },
        { path: "/api/v1/me/notifications", respond: () => ({ items: items(), unread_count: unread, next_cursor: null }) },
        { method: "POST", path: "/api/v1/me/notifications/read-all", respond: () => { const marked = unread; unread = 0; return { marked }; } },
        ...memberShellRoutes({ unread: 2 }),
      ], "/inbox");
      const button = page.getByRole("button", { name: INBOX_COPY.markAll });
      await button.click();
      await expect(button).toHaveCount(0);
      await expect(page.locator("[data-inbox-said]")).toHaveText(INBOX_COPY.allRead);
      const focused = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
      expect(focused).toBe(INBOX_COPY.listLabel);
    });
  });
}

test("an admin's Remove whose reply was lost says so in its dialog and keeps the reason (I4-6)", async ({ page }) => {
  const LIST = "/api/v1/admin/play/results";
  const { viewer_side: _s, viewer_outcome: _o, ...rest } = resultFixture({ status: "disputed", dispute_note: "It was 3–2." });
  void _s; void _o;
  const row = { ...rest, court_name: "Court 1", starts_at: new Date().toISOString(), organiser: { user_id: null, name: "Nomsa Khumalo" } };
  await phone(page, 390, [
    { path: "/api/v1/whoami", body: SESSION_ADMIN },
    { path: "/api/v1/wallet", body: { balance_minutes: 10, entries: [], total_entries: 0, offset: 0, limit: 10 } },
    { path: "/api/v1/me/profile", body: { full_name: "Crusaders Admin", email: "admin@test.local", photo_url: null, membership_number: "A-1" } },
    { path: "/api/v1/admin/monitoring/summary", body: { open: {} } },
    { path: "/api/v1/admin/members", body: [] },
    { path: "/api/v1/me/notifications/unread-count", body: { unread_count: 0 } },
    { path: "/api/v1/me/play/celebrations", body: { timezone: CLUB_ZONE, items: [] } },
    { method: "POST", path: "/api/v1/wallet/stream-ticket", status: 503, body: { error: "stream_unavailable" } },
    { path: `${LIST}/disputed/count`, body: { count: 1 } },
    // The removal never lands: the read-back (?status=voided) finds this row still disputed.
    { path: LIST, body: { items: [row], next_cursor: null, count: 1 } },
    { method: "POST", path: `${LIST}/${RESULT_ID}/void`, status: 504, body: { error: "gateway_timeout" } },
  ], "/admin/results");
  await page.getByRole("button", { name: ADMIN_RESULTS.remove }).first().click();
  const dialog = page.getByRole("dialog", { name: ADMIN_RESULTS.removeTitle });
  await dialog.getByLabel(ADMIN_RESULTS.reasonLabel).fill("Wrong score");
  await dialog.getByRole("button", { name: ADMIN_RESULTS.remove }).click();
  await expect(dialog.getByText(ADMIN_RESULT_UNSURE.void.checked)).toBeVisible();
  await expect(dialog.getByLabel(ADMIN_RESULTS.reasonLabel)).toHaveValue("Wrong score");
  await expect(dialog).not.toContainText("Couldn't");
  await page.screenshot({ path: test.info().outputPath("remove-lost-390.png") });
});
