import { type Page } from "@playwright/test";
import { SESSION_ADMIN, serveApi, signIn, test, expect } from "./fixtures";
import { memberShellRoutes } from "./playersKit";
import { MEMBERS_PAGE } from "../src/lib/membersCopy";

// A cold dev server compiles the admin frame on first ask, and the machine is shared.
test.describe.configure({ timeout: 90_000 });

/**
 * R15 L15-2 — a search field bound to the URL keeps every key typed at a person's pace.
 *
 * <p>
 * The members search (`?q=`) and the ledger's name search read their value from the URL and wrote
 * it on every key: a key landing before the router committed the last write was typed into the old
 * value, then reset — "bartholomew" at ~80 ms a key came out "brtholomew". The field now keeps what
 * was typed and writes the URL once typing pauses. Typed here at 30 ms and 80 ms a key, both pages.
 * </p>
 */
const WORD = "bartholomew";
/** A club's worth of rows, and a phone's CPU: the race is between a key and a slow commit. */
const ROWS = 400;
const THROTTLE = 6;

function ledgerRow(i: number) {
  const name = i === 0 ? "Bartholomew Fitzwilliam" : `Member ${i}`;
  return {
    id: String(i + 1), at: "2026-01-15T10:00:00Z", from: "Club treasury", to: name,
    amountMinutes: 30, signedAmountMinutes: 30, type: "AdminTopUp", comment: "Desk sale",
    subjectUserId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, subjectName: name,
    actorUserId: "00000000-0000-0000-0000-00000000000a", actorName: "Desk Volunteer", relatedBookingId: null,
  };
}

function member(i: number, name: string) {
  return {
    user_id: `00000000-0000-4000-8000-0000000002${String(i).padStart(2, "0")}`,
    membership_id: `00000000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`,
    full_name: name, email: `member.${i}@url-search-r15.review.test`,
    membership_number: `MEM-10${String(i).padStart(2, "0")}`, status: "Active", email_verified: true,
    balance_minutes: 120, created_at: "2026-09-05T08:00:00Z", photo_url: null,
    is_admin: false, admin_source: null, groups: [],
  };
}

async function open(page: Page, path: string) {
  await signIn(page);
  await serveApi(page, [
    ...memberShellRoutes({ admin: true }),
    { path: "/api/v1/whoami", body: SESSION_ADMIN },
    { path: "/api/v1/admin/monitoring/summary", body: { open: {} } },
    { path: "/api/v1/admin/play/results/disputed/count", body: { count: 0 } },
    { path: "/api/v1/admin/members/", body: Array.from({ length: ROWS }, (_, i) => member(i, i === 0 ? "Bartholomew Fitzwilliam" : `Member ${i}`)) },
    { path: "/api/v1/admin/ledger/", body: Array.from({ length: ROWS }, (_, i) => ledgerRow(i)) },
  ]);
  await page.goto(path);
  await expect(page.locator("nav[data-primary-nav]")).toBeVisible({ timeout: 30_000 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
}

for (const delay of [30, 80]) {
  test(`members: "${WORD}" typed at ${delay} ms a key arrives whole, and the URL follows (${delay} ms)`, async ({ page }) => {
    await open(page, "/admin/members");
    const search = page.getByRole("searchbox", { name: MEMBERS_PAGE.searchLabel }).or(page.getByLabel(MEMBERS_PAGE.searchLabel)).first();
    await search.click();
    await search.pressSequentially(WORD, { delay });
    await expect(search).toHaveValue(WORD);
    await expect(page).toHaveURL(new RegExp(`[?&]q=${WORD}(?:&|$)`));
    await expect(search).toHaveValue(WORD);
  });

  test(`ledger: "${WORD}" typed at ${delay} ms a key arrives whole, and the URL follows (${delay} ms)`, async ({ page }) => {
    await open(page, "/admin/ledger?from=2026-01-01&to=2026-01-31");
    const search = page.getByLabel("Search (name)");
    const folded = page.getByRole("button", { name: /^Filters/ });
    await expect(search.or(folded).first()).toBeVisible({ timeout: 30_000 });
    // On a phone the filters fold behind one button.
    if (!(await search.isVisible())) await folded.click();
    await search.click();
    await search.pressSequentially(WORD, { delay });
    await expect(search).toHaveValue(WORD);
    await expect(page).toHaveURL(new RegExp(`[?&]q=${WORD}(?:&|$)`));
    await expect(search).toHaveValue(WORD);
  });
}
