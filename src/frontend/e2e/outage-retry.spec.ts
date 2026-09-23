import type { Route } from "@playwright/test";
import { serveApi, signIn, test, expect } from "./fixtures";

/**
 * J-F4, second half — the outage screen's "Try again now", driven in a real browser.
 *
 * <p>
 * <b>Why a browser spec, when two vitest files already cover this button.</b> The first fix for
 * the pending state guarded its <code>setRetrying(false)</code> behind the mounted-ref idiom —
 * <code>useRef(true)</code> plus a cleanup-only effect. <code>src/main.tsx</code> mounts the app
 * inside <code>StrictMode</code>, whose mount → cleanup → mount sequence sets that ref to
 * <code>false</code> before the first paint, so the guard never let the button come back: a
 * refuter measured it reading <b>"Trying…", disabled, at +120s</b> on the dev server, which is
 * worse than the ignored-looking button the finding was written about. It was correct on a
 * production build, because StrictMode does not double-invoke effects there.
 * </p>
 *
 * <p>
 * Both unit files render inside <code>StrictMode</code> now and catch that mutant. This spec is
 * the belt to their braces: the dev server is the environment where the defect was real, and it
 * is the one every finder and refuter in this programme drives. A component-lifecycle bug that
 * only appears under the entry point's own lifecycle deserves one test that uses the entry point.
 * </p>
 *
 * <p>
 * <b>How the backend is made to misbehave.</b> The first API call is aborted, so the app reaches
 * the outage screen in milliseconds rather than after the 20s request budget. Every call after it
 * is <i>held</i> — the route object is parked, never fulfilled — which is what a backend that
 * accepts the socket and never answers looks like from the browser. The retry is then released as
 * a failure, deliberately: a retry that <i>succeeds</i> unmounts this screen, so it could never
 * show the button coming back.
 * </p>
 */

const SESSION_MEMBER = {
  tenant_slug: "crusaders",
  tenant_id: "00000000-0000-0000-0000-000000000001",
  user_id: "00000000-0000-0000-0000-000000000002",
  is_authenticated: true,
  is_admin: false,
};

test("the outage screen's retry says it is working, and comes back so it can be pressed again", async ({ page }) => {
  await signIn(page);

  // Parked routes, newest last. Nothing here ever fulfils on its own; the test decides.
  const held: Route[] = [];
  let firstCallAborted = false;

  await page.route("**/api/**", async (route) => {
    if (!firstCallAborted) {
      firstCallAborted = true;
      await route.abort("failed");
      return;
    }
    held.push(route);
  });

  await page.goto("/wallet");

  const retry = page.getByRole("button", { name: "Try again now" });
  await expect(page.getByText("Can't reach the club right now")).toBeVisible();
  await expect(retry).toBeEnabled();
  await expect(retry).not.toHaveAttribute("aria-busy", "true");

  const before = held.length;
  await retry.click();

  // Pressed: announced busy, marked unavailable, spinner showing. The finding measured one
  // unchanging button for 25.3 seconds — a member presses the only control they are given,
  // nothing happens, so they press it again. R12 (P2) moved it onto the house pending posture,
  // which retires the "Trying…" relabel and the `disabled` attribute: the label stays so the
  // width does not jump, and `aria-disabled` rather than `disabled` keeps focus on the button.
  await expect(retry).toHaveAttribute("aria-busy", "true");
  await expect(retry).toHaveAttribute("aria-disabled", "true");
  await expect(retry.locator('[data-slot="spinner"]')).toBeVisible();

  // And it STAYS busy while the probe is in flight. This is the half that catches
  // `retryConnection` going back to fire-and-forget: the button would flick back to its
  // resting state a microtask after the press, which reads exactly like the ignored button the
  // pending state exists to replace.
  await page.waitForTimeout(3_000);
  await expect(retry).toHaveAttribute("aria-busy", "true");
  await expect(retry).toBeDisabled();

  // The retry reached the network rather than being a local spinner over nothing.
  expect(held.length).toBeGreaterThan(before);

  // Let the attempt fail. The screen stays — it is still an outage — and the control has to
  // return, or the member is looking at a dead button on a screen that offers nothing else.
  // This is the assertion the mounted-ref guard never reached.
  for (const route of held.splice(0)) await route.abort("failed");

  await expect(page.getByRole("button", { name: "Try again now" })).toBeEnabled({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Try again now" })).not.toHaveAttribute("aria-busy", "true");
  await expect(page.getByText("Can't reach the club right now")).toBeVisible();
});

/**
 * The control for the spec above: with a backend that answers, the same journey ends on the
 * wallet rather than on the outage screen. Without this, "the outage screen appears" could be
 * true because the app can no longer reach anything at all.
 */
test("a club that answers never shows the outage screen in the first place", async ({ page }) => {
  await signIn(page);
  await serveApi(page, [
    { path: "/api/v1/whoami", body: SESSION_MEMBER },
    { path: "/api/v1/wallet", body: { balance_credits: 274.25, entries: [], total_entries: 0, offset: 0, limit: 50 } },
    { path: "/api/v1/me/profile", body: { full_name: "Nomsa Khumalo", email: "n@test.local", photo_url: null, membership_number: "P-1" } },
  ]);

  await page.goto("/wallet");

  await expect(page.getByText("Can't reach the club right now")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Try again now" })).toHaveCount(0);
});
