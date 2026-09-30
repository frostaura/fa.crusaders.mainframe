import { type Page } from "@playwright/test";
import { serveApi, signIn, test, expect } from "./fixtures";
import { memberShellRoutes } from "./playersKit";
import { myPlayFixture } from "./playKit";
import { GOAL_SHEET, RING_COPY } from "../src/lib/playCopy";

/**
 * Review round 1, lane F4, in a real browser with a real keyboard.
 *
 * <ul>
 *   <li><b>F4.5</b> — a dialog opened from a control that is not a `DialogTrigger` (almost all of
 *   them) gave focus back to `<body>` on close. The vitest suite proves it for every dialog one by
 *   one (`ui/__tests__/dialog-focus-return.test.tsx`); this proves the same thing with Enter,
 *   Escape and Tab, which jsdom only imitates.</li>
 *   <li><b>F4.7</b> — Save on the name form dropped focus on `<body>` once the name was saved.</li>
 *   <li><b>F4.11</b> — the monthly-goal card squeezed its words into a narrow column on a phone.</li>
 * </ul>
 */
async function openProfile(page: Page) {
  await signIn(page);
  await serveApi(page, [
    { path: "/api/v1/me/play", body: myPlayFixture() },
    { path: "/api/v1/me/webauthn/credentials", body: [] },
    { path: "/api/v1/me/preferences", body: { findable: false, show_in_leaderboards: false } },
    { path: "/api/v1/me/door/history", body: { items: [], next_cursor: null } },
    { method: "PUT", path: "/api/v1/me/profile", body: { full_name: "Nomsa Keyboard" } },
    ...memberShellRoutes(),
  ]);
  await page.goto("/profile");
  // A cold dev server compiles Profile's chunk on first ask; under a loaded runner that alone has
  // taken most of a default timeout.
  await expect(page.getByRole("region", { name: "My game" })).toBeVisible({ timeout: 45_000 });
}

test.describe.configure({ timeout: 90_000 });

/** What has focus, described well enough to fail readably. */
const focused = (page: Page) => page.evaluate(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return "BODY";
  return el.getAttribute("aria-label") ?? el.textContent?.trim() ?? el.tagName;
});

test("F4.5: a dialog opened with the keyboard gives focus back to what opened it, by Escape and by its close ×", async ({ page }) => {
  await openProfile(page);
  const edit = page.getByRole("button", { name: RING_COPY.editGoal });
  await edit.focus();

  await page.keyboard.press("Enter");
  const sheet = page.getByRole("dialog", { name: GOAL_SHEET.title });
  await expect(sheet).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  // Radix returns focus as its exit settles, a frame or two after the node leaves.
  await expect.poll(() => focused(page)).toBe(RING_COPY.editGoal);

  // Again, closed from inside with the keyboard: Tab to the close × and press it.
  await page.keyboard.press("Enter");
  await expect(sheet).toBeVisible();
  const close = sheet.locator("[data-slot=dialog-close]");
  for (let i = 0; i < 12 && !(await close.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(sheet).toHaveCount(0);
  // Radix returns focus as its exit settles, a frame or two after the node leaves.
  await expect.poll(() => focused(page)).toBe(RING_COPY.editGoal);
});

test("F4.7: saving a name with the keyboard leaves focus on Save", async ({ page }) => {
  await openProfile(page);
  const name = page.getByLabel("Full name");
  await name.fill("Nomsa Keyboard");
  await page.keyboard.press("Tab");
  const save = page.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(save).toHaveAttribute("aria-disabled", "true");
  await expect(save).not.toHaveAttribute("aria-busy", "true");
  await expect(save).toBeFocused();
  expect(await focused(page)).not.toBe("BODY");
});

for (const width of [320, 390]) {
  test(`F4.11: the monthly-goal card gives its words a real width at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await openProfile(page);
    const words = page.locator("[data-ring-words]");
    await expect(words).toBeVisible();
    const box = (await words.boundingBox())!;
    const card = (await page.locator("[data-ring]").boundingBox())!;
    // The words take the card's whole width under the ring, not the sliver beside it.
    expect(box.width, "the words' column").toBeGreaterThanOrEqual(card.width - 1);
    const edit = (await page.getByRole("button", { name: RING_COPY.editGoal }).boundingBox())!;
    expect(edit.x + edit.width).toBeLessThanOrEqual(card.x + card.width + 1);
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(scroll).toBeLessThanOrEqual(0);
  });
}
