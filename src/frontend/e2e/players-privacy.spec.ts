import { expect, serveApi, signIn, test, type ApiRoute } from "./fixtures";
import { SESSION_MEMBER, memberShellRoutes } from "./playersKit";
import { GET_STARTED } from "../src/lib/onboardingCopy";
import { PRIVACY_COPY } from "../src/lib/playersCopy";

/**
 * P11 / D13 — the social switches: the welcome wizard ends on them, both off; flipping one is
 * a PUT of that one field; Profile shows the same two switches.
 */

type Recorder = { puts: unknown[] };

function privacyRoutes(recorder: Recorder, prefs: Record<string, unknown> = {}): ApiRoute[] {
  const stored = { findable: false, show_in_leaderboards: false, ...prefs };
  return [
    { path: "/api/v1/me/preferences", body: stored },
    { method: "PUT", path: "/api/v1/me/preferences", respond: (r) => { recorder.puts.push(r.body); return { ...stored, ...(r.body as object) }; } },
    { method: "PUT", path: "/api/v1/me/onboarding/member/step", respond: (r) => r.body },
    { path: "/api/v1/me/webauthn/credentials", body: [] },
    { path: "/api/v1/me/door/history", body: { items: [], has_more: false } },
    { path: "/api/v1/session", body: SESSION_MEMBER },
    ...memberShellRoutes(),
  ];
}

test.describe("P11: privacy, off until the member says otherwise", () => {
  // The first visit of a worker compiles the wizard and Profile on the dev server.
  test.setTimeout(60_000);
  test("the welcome wizard ends on the privacy choice, and a flip is saved", async ({ page }) => {
    const recorder: Recorder = { puts: [] };
    await signIn(page);
    await serveApi(page, privacyRoutes(recorder));
    await page.goto("/get-started?step=install");
    await expect(page.getByRole("heading", { level: 2, name: GET_STARTED.steps.install.title })).toBeVisible();

    await page.getByRole("button", { name: GET_STARTED.next, exact: true }).click();
    await expect(page.getByRole("heading", { level: 2, name: GET_STARTED.steps.privacy.title })).toBeVisible();
    await expect(page.getByText(GET_STARTED.stepOf(8, 8))).toBeVisible();

    const findable = page.getByRole("switch", { name: PRIVACY_COPY.findableLabel });
    const boards = page.getByRole("switch", { name: PRIVACY_COPY.leaderboardsLabel });
    await expect(findable).toHaveAttribute("aria-checked", "false");
    await expect(boards).toHaveAttribute("aria-checked", "false");

    await findable.click();
    await expect(findable).toHaveAttribute("aria-checked", "true");
    await expect.poll(() => recorder.puts).toEqual([{ findable: true }]);
    await expect(page.getByRole("button", { name: GET_STARTED.finish })).toBeVisible();
  });

  test("a refused save puts the switch back and says so", async ({ page }) => {
    await signIn(page);
    await serveApi(page, [
      { method: "PUT", path: "/api/v1/me/preferences", status: 500, body: { error: "server_error" } },
      ...privacyRoutes({ puts: [] }),
    ]);
    await page.goto("/get-started?step=privacy");
    const boards = page.getByRole("switch", { name: PRIVACY_COPY.leaderboardsLabel });
    await boards.click();
    await expect(page.getByRole("alert").filter({ hasText: PRIVACY_COPY.saveFailed(PRIVACY_COPY.leaderboardsLabel) })).toBeVisible();
    await expect(boards).toHaveAttribute("aria-checked", "false");
  });

  test("Profile shows the same two switches, reading what the server holds", async ({ page }) => {
    const recorder: Recorder = { puts: [] };
    await signIn(page);
    await serveApi(page, privacyRoutes(recorder, { findable: true }));
    await page.goto("/profile");

    const card = page.getByRole("region", { name: PRIVACY_COPY.title });
    await expect(card).toBeVisible();
    await expect(card.getByRole("switch", { name: PRIVACY_COPY.findableLabel })).toHaveAttribute("aria-checked", "true");
    const boards = card.getByRole("switch", { name: PRIVACY_COPY.leaderboardsLabel });
    await expect(boards).toHaveAttribute("aria-checked", "false");
    await boards.click();
    await expect.poll(() => recorder.puts).toEqual([{ show_in_leaderboards: true }]);
  });
});
