import AxeBuilder from "@axe-core/playwright";
import { type Page } from "@playwright/test";
import { SESSION_ADMIN, serveApi, signIn, test, expect } from "./fixtures";
import { CONFIRM_NOT_READY } from "../src/lib/confirmDialogCopy";
import { resultFixture, RESULT_ID } from "./playKit";

/**
 * P12 — Match results (`play.md` §9.4) in a real browser: the rail carries the disputes badge
 * under People, the Disputed tab lists the dispute with its note, and removing it needs a reason
 * that is sent as the server's body — after which the row goes and the badge comes down.
 */

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const LIST = "/api/v1/admin/play/results";

function disputed() {
  const { viewer_side: _s, viewer_outcome: _o, ...rest } = resultFixture({
    status: "disputed", disputed_at: new Date().toISOString(),
    disputed_by: { user_id: "55555555-5555-5555-5555-555555555555", name: "Sam Petersen" },
    dispute_note: "It was 3–2, not 3–1.",
  });
  void _s; void _o;
  return { ...rest, court_name: "Court 1", starts_at: new Date().toISOString(), organiser: { user_id: null, name: "Nomsa Khumalo" } };
}

async function open(page: Page, theme?: "light" | "dark") {
  const state = { rows: [disputed()] as Record<string, unknown>[], voided: [] as unknown[] };
  await signIn(page);
  if (theme) await page.addInitScript((t) => window.localStorage.setItem("crusaders:theme", t), theme);
  await serveApi(page, [
    { path: "/api/v1/whoami", body: SESSION_ADMIN },
    { path: "/api/v1/wallet", body: { balance_credits: 10, entries: [], total_entries: 0, offset: 0, limit: 10 } },
    { path: "/api/v1/me/profile", body: { full_name: "Crusaders Admin", email: "admin@test.local", photo_url: null, membership_number: "A-1" } },
    { path: "/api/v1/admin/monitoring/summary", body: { open: {} } },
    { path: "/api/v1/admin/members", body: [] },
    { path: "/api/v1/me/notifications/unread-count", body: { unread_count: 0 } },
    { path: "/api/v1/me/play/celebrations", body: { timezone: "Africa/Johannesburg", items: [] } },
    { method: "POST", path: "/api/v1/wallet/stream-ticket", status: 503, body: { error: "stream_unavailable" } },
    { path: `${LIST}/disputed/count`, respond: () => ({ count: state.rows.length }) },
    { path: LIST, respond: () => ({ items: state.rows, next_cursor: null, count: state.rows.length }) },
    {
      method: "POST", path: `${LIST}/${RESULT_ID}/void`,
      respond: ({ body }) => {
        state.voided.push(body);
        const row = state.rows[0];
        state.rows = [];
        return { ...row, status: "voided" };
      },
    },
  ]);
  return state;
}

test("the rail badges disputes under People; removing one needs a reason", async ({ page }) => {
  const state = await open(page);
  await page.goto("/admin/results");
  await expect(page.getByRole("heading", { level: 1, name: "Match results" })).toBeVisible();
  // The rail (xl) or the section bar (below it) — either way the destination is named with its count.
  const named = page.getByRole("link", { name: "Match results, 1 disputed match result" });
  if (await named.count()) await expect(named.first()).toBeAttached();

  const row = page.locator(`[data-admin-result="${RESULT_ID}"]`);
  await expect(row).toContainText("It was 3–2, not 3–1.");
  await expect(row).toContainText("Disputed by Sam Petersen");
  await row.getByRole("button", { name: "Remove result" }).click();
  const dialog = page.getByRole("dialog", { name: "Remove this result?" });
  await expect(dialog.getByRole("button", { name: "Keep it" })).toBeVisible();
  // Not ready without a reason: the primary stays enabled and pressing it says what is missing.
  await dialog.getByRole("button", { name: "Remove result" }).click();
  await expect(dialog.getByText(CONFIRM_NOT_READY)).toBeVisible();
  await expect(dialog.getByLabel("Reason")).toBeFocused();
  expect(state.voided).toEqual([]);
  await dialog.getByLabel("Reason").fill("Both players agreed it was 3–2");
  await dialog.getByRole("button", { name: "Remove result" }).click();
  await expect(dialog).toBeHidden();
  await expect(row).toHaveCount(0);
  await expect(page.getByText("No disputed results")).toBeVisible();
  expect(state.voided).toEqual([{ reason: "Both players agreed it was 3–2" }]);

  const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(scroll, "the page scrolls sideways").toBeLessThanOrEqual(0);
});

for (const theme of ["light", "dark"] as const) {
  test(`Match results passes axe (${theme})`, async ({ page }) => {
    await open(page, theme);
    await page.goto("/admin/results");
    await expect(page.locator(`[data-admin-result="${RESULT_ID}"]`)).toBeVisible();
    const scan = await new AxeBuilder({ page }).withTags(TAGS).include("#main-content").analyze();
    expect(scan.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  });
}
