import { expect, serveApi, signIn, test, type ApiRoute } from "./fixtures";
import { SESSION_MEMBER, memberShellRoutes } from "./playersKit";
import { GET_STARTED } from "../src/lib/onboardingCopy";
import { PRIVACY_COPY } from "../src/lib/playersCopy";

/**
 * P11 / D13 — the social switch: the welcome wizard ends on it, off; flipping it is a PUT of that
 * one field; Profile shows the same switch. "Show me on leaderboards" is hidden until leaderboards
 * exist, and its stored value is never sent.
 */

type Recorder = { puts: unknown[] };

function privacyRoutes(recorder: Recorder, prefs: Record<string, unknown> = {}): ApiRoute[] {
  const stored = { findable: true, show_in_leaderboards: false, ...prefs };
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

test.describe("P11: findable by default, off when the member says so", () => {
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
    await expect(page.getByText(GET_STARTED.stepOf(7, 7))).toBeVisible();

    const findable = page.getByRole("switch", { name: PRIVACY_COPY.findableLabel });
    await expect(findable).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("switch", { name: PRIVACY_COPY.leaderboardsLabel })).toHaveCount(0);

    await findable.click();
    await expect(findable).toHaveAttribute("aria-checked", "false");
    await expect.poll(() => recorder.puts).toEqual([{ findable: false }]);
    await expect(page.getByRole("button", { name: GET_STARTED.finish })).toBeVisible();
  });

  test("a refused save puts the switch back and says so", async ({ page }) => {
    await signIn(page);
    await serveApi(page, [
      { method: "PUT", path: "/api/v1/me/preferences", status: 500, body: { error: "server_error" } },
      ...privacyRoutes({ puts: [] }),
    ]);
    await page.goto("/get-started?step=privacy");
    const findable = page.getByRole("switch", { name: PRIVACY_COPY.findableLabel });
    await findable.click();
    // R19 X19-2: a plain 500 is the club's system answering with an error, not a bare refusal.
    await expect(page.getByRole("alert").filter({ hasText: PRIVACY_COPY.saveError(PRIVACY_COPY.findableLabel) })).toBeVisible();
    await expect(findable).toHaveAttribute("aria-checked", "true");
  });

  test("Profile shows the same switch, reading what the server holds, and never sends leaderboards", async ({ page }) => {
    const recorder: Recorder = { puts: [] };
    await signIn(page);
    await serveApi(page, privacyRoutes(recorder, { findable: true, show_in_leaderboards: true }));
    await page.goto("/profile?tab=account");

    const card = page.getByRole("region", { name: PRIVACY_COPY.title });
    await expect(card).toBeVisible();
    const findable = card.getByRole("switch", { name: PRIVACY_COPY.findableLabel });
    await expect(findable).toHaveAttribute("aria-checked", "true");
    await expect(card.getByRole("switch", { name: PRIVACY_COPY.leaderboardsLabel })).toHaveCount(0);
    await findable.click();
    await expect.poll(() => recorder.puts).toEqual([{ findable: false }]);
  });
});
