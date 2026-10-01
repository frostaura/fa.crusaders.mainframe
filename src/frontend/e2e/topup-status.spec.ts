import { signIn, test, expect } from "./fixtures";

/**
 * H-F2, the half that survived the first fix — driven the way the refuter found it.
 *
 * <p>
 * The error branch of this page was one sentence in a bare card: no Check again, no View
 * wallet, no link, not even the page's own layout. Nothing used to walk a member into it. The
 * Check again button added in the previous round does, in one press — a refuter aborted the
 * status request on a live Pending purchase, pressed the button, and the page became
 * "Couldn't load the status." with <code>buttons: [""]</code> and no way out but a reload.
 * </p>
 *
 * <p>
 * <b>Why a browser spec on top of the three vitest cases.</b> The defect is a sequence of page
 * states reached by a real press against a real network failure, and the finding was written
 * from exactly that. A component test asserts what the branch renders; only the page can show
 * that pressing the one control it offers leads somewhere a member can leave from.
 * </p>
 */

const SESSION_MEMBER = {
  tenant_slug: "crusaders",
  tenant_id: "00000000-0000-0000-0000-000000000001",
  user_id: "00000000-0000-0000-0000-000000000002",
  is_authenticated: true,
  is_admin: false,
};

const ID = "aaaa1111-0000-0000-0000-00000000000e";
const PENDING = {
  id: ID, status: "Pending", package_id: "p-5", package_name: "5 hours", minutes: 300, list_price_zar: 500, discount_bps: 0,
  amount_zar: 500, failure_code: null, created_at: "2026-10-01T12:05:00Z", expires_at: "2026-10-01T13:05:00Z",
};

test("pressing Check again against a club that stops answering is not a dead end", async ({ page }) => {
  await signIn(page);

  // Flipped by the test, mid-journey: everything works, then the status endpoint stops
  // answering — which is what an aborted request looks like from the page's side.
  let statusReachable = true;

  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

    if (path.startsWith("/api/v1/minutes/purchase/")) {
      if (!statusReachable) return route.abort("failed");
      return json(PENDING);
    }
    if (path.startsWith("/api/v1/whoami")) return json(SESSION_MEMBER);
    if (path.startsWith("/api/v1/wallet")) return json({ balance_minutes: 18, entries: [], total_entries: 0, offset: 0, limit: 50 });
    if (path.startsWith("/api/v1/me/profile")) {
      return json({ full_name: "Nomsa Khumalo", email: "n@test.local", photo_url: null, membership_number: "P-1" });
    }
    return route.fulfill({ status: 501, contentType: "application/json", body: "{}" });
  });

  // The old return URL: the page itself until the route table moves, a redirect to
  // `/wallet/buy/{id}` after it (§12.14) — a PayFast return in flight at deploy time lands here.
  await page.goto(`/wallet/topup/${ID}`);
  await expect(page).toHaveURL(new RegExp(`/wallet/(topup|buy)/${ID}$`));

  // The live Pending page the refuter started from.
  await expect(page.getByText("Waiting for confirmation from PayFast…")).toBeVisible();
  await expect(page.getByText("5 hours for R500.00")).toBeVisible();
  const checkAgain = page.getByRole("button", { name: "Check again" });
  await expect(checkAgain).toBeVisible();

  statusReachable = false;
  await checkAgain.click();

  // What the member is left holding. Every one of these was absent in the measured run.
  await expect(page.getByRole("alert")).toContainText(/may be out of date|Nothing here cancels/);
  await expect(page.getByRole("button", { name: "Check again" })).toBeEnabled();
  await expect(page.getByRole("link", { name: "View wallet" })).toBeVisible();
  // The status that had already been read is still on screen rather than discarded.
  await expect(page.getByText("Waiting", { exact: true })).toBeVisible();
  await expect(page.getByText("5 hours for R500.00")).toBeVisible();

  // And the way out is a real one: the club answers, the page catches up without a reload.
  statusReachable = true;
  await page.getByRole("button", { name: "Check again" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("Waiting for confirmation from PayFast…")).toBeVisible();
});
