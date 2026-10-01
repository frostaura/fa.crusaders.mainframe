import { SESSION_ADMIN, serveApi, signIn, test, expect } from "./fixtures";

/**
 * A list that could not be read must not be rendered as a list that is empty.
 *
 * <p>
 * <b>The defect.</b> Both admin screens below initialise their collection to an empty array and
 * then render their "nothing here yet" state whenever it is empty — which is also what it is
 * when the request failed and nothing was ever assigned. The two situations looked identical on
 * screen and are opposites in meaning.
 * </p>
 *
 * <ul>
 * <li><b>Members.</b> "0 total · 0 pending" above "No members yet." A club of two hundred with
 * applications waiting, rendered as a club with neither. The only signal was a toast, and the
 * toast fades — a few seconds later nothing on the screen was true. An admin who reads
 * "0 pending" stops looking for applications to approve, and the applicant waits.</li>
 * <li><b>Webhooks.</b> The loader was <code>load().catch(() =&gt; {})</code>, so there was not
 * even a toast. The screen said "No webhook endpoints yet. Create one above to start firing
 * events." An admin who follows that instruction adds a second endpoint beside the one they
 * could not see, and every booking from then on fires the club's lights cue twice.</li>
 * </ul>
 *
 * <p>
 * <b>Why a browser test as well as a unit one.</b> The unit tests hold each component's own
 * behaviour. These hold what a person actually sees on the assembled page — the summary counts
 * live in a different card from the table body, and it is the combination ("0 pending" next to
 * "No members yet") that does the damage.
 * </p>
 */

const PROFILE = {
  full_name: "Nomsa Khumalo", email: "n@test.local", photo_url: null,
  membership_number: "P-1",
};
const COMMON = [
  { path: "/api/v1/whoami", body: SESSION_ADMIN },
  { path: "/api/v1/wallet", body: { balance_minutes: 500, entries: [], total_entries: 0, offset: 0, limit: 50 } },
  { path: "/api/v1/me/profile", body: PROFILE },
];

test("a members list that failed to load is never shown as a club with no members", async ({ page }) => {
  await signIn(page);
  await serveApi(page, [
    ...COMMON,
    { path: "/api/v1/admin/members", status: 503, body: { error: "upstream_unavailable" } },
    { path: "/api/v1/admin/biometrics/enrollments", body: [] },
  ]);

  await page.goto("/admin/members");

  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByText(/could not be read/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /try again/i })).toBeVisible();

  // The two sentences that were false, both gone.
  await expect(page.getByText("No members yet.")).toHaveCount(0);
  await expect(page.getByText(/\bpending\b/)).toHaveCount(0);
});

test("a members list that is genuinely empty still says so", async ({ page }) => {
  // The guard against fixing the above by never showing an empty state again.
  await signIn(page);
  await serveApi(page, [
    ...COMMON,
    { path: "/api/v1/admin/members", body: [] },
    { path: "/api/v1/admin/biometrics/enrollments", body: [] },
  ]);

  await page.goto("/admin/members");

  await expect(page.getByText("No members yet.")).toBeVisible();
  await expect(page.getByText("total")).toBeVisible();
  await expect(page.getByText(/could not be read/i)).toHaveCount(0);
});

test("a webhook list that failed to load does not invite the admin to create a duplicate", async ({ page }) => {
  await signIn(page);
  await serveApi(page, [
    ...COMMON,
    { path: "/api/v1/admin/webhooks", status: 503, body: { error: "upstream_unavailable" } },
  ]);

  await page.goto("/admin/webhooks");

  await expect(page.getByRole("alert")).toBeVisible();
  // The consequence, named: "couldn't load" on its own does not tell an admin why they
  // should not simply go ahead and create one.
  await expect(page.getByText(/firing every event twice/i)).toBeVisible();
  await expect(page.getByText(/No webhook endpoints yet/i)).toHaveCount(0);

  // And the button is not offered, because an instruction with a live contradiction beside
  // it is not an instruction. This is the control that would actually create the duplicate.
  await expect(page.getByRole("button", { name: /new endpoint/i })).toBeDisabled();
});

test("a webhook list that is genuinely empty still invites the admin to create one", async ({ page }) => {
  await signIn(page);
  await serveApi(page, [...COMMON, { path: "/api/v1/admin/webhooks", body: [] }]);

  await page.goto("/admin/webhooks");

  await expect(page.getByText(/No webhook endpoints yet/i)).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /new endpoint/i })).toBeEnabled();
});
