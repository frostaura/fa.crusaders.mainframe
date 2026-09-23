import { serveApi, signIn, test, expect } from "./fixtures";

/**
 * `.no-lift` — measured, because it was inert and nothing in the repo could see it.
 *
 * <p>
 * <b>The defect.</b> <code>index.css</code> declares the hover lift on behavioural selectors:
 * <code>button:not(:disabled):not([aria-disabled="true"]):hover</code>, specificity (0,3,1). The
 * opt-out beside it was <code>.no-lift:hover</code> — (0,2,0) — which loses to it, and to
 * <code>a[href]:hover</code> (0,2,1) as well. So every control carrying the class still lifted.
 * Reproduced here before the fix, on the same control a refuter used: a hovered carousel dot on
 * <code>/reports</code> reported <code>transform: matrix(1, 0, 0, 1, 0, -1)</code> and the full
 * two-layer lift shadow. It is the same specificity bug that had already been found and fixed one
 * rule above, in the reduced-motion block, and it survived because it was never measured.
 * </p>
 *
 * <p>
 * <b>Why it has to be a browser test.</b> jsdom applies no stylesheet and computes no Tailwind —
 * <code>src/components/affordance.test.ts</code> says so in its own header — so every assertion
 * available there is about the TEXT of the rule rather than about what the cascade does with it.
 * A rule can be present, correct-looking and completely overridden, which is exactly what
 * happened twice in this file. The unit test alongside this one computes the specificity
 * arithmetic; only an engine can settle who actually wins.
 * </p>
 *
 * <p>
 * The dots are a real product control and the one the class matters most on: at 375px they are
 * the primary way to move between chart slides, and a dot that jumps a pixel under the thumb
 * reads as a mis-tap.
 * </p>
 */

const SESSION_MEMBER = {
  tenant_slug: "crusaders",
  tenant_id: "00000000-0000-0000-0000-000000000001",
  user_id: "00000000-0000-0000-0000-000000000002",
  is_authenticated: true,
  is_admin: false,
};

const DAILY = ["2026-08-30", "2026-08-31", "2026-09-01", "2026-09-02"].map((date, i) => ({
  date,
  top_ups_credits: i * 100,
  spent_credits: i * 20,
  refunds_credits: 0,
  bookings: i,
  attended: i,
  minutes_on_court: i * 60,
  balance_credits: 500 - i * 20,
}));

const WALLET_REPORT = {
  from: "2026-08-30", to: "2026-09-02",
  top_ups_credits: 1600, spent_credits: 400, refunds_credits: 0,
  penalties_credits: 0, adjustments_credits: 0, reversals_credits: 0,
  net_movement_credits: 1200, penalty_count: 0, attended_bookings: 3, minutes_on_court: 180,
};

/** Hover and read back what the engine settled on, once the transition has finished. */
async function hovered(locator: import("@playwright/test").Locator) {
  await locator.hover();
  // The base layer eases transform over 200ms. A reading taken mid-transition is a value
  // between the two states, which would make this test's verdict depend on its own speed.
  await locator.page().waitForTimeout(450);
  return await locator.evaluate((el) => {
    const s = getComputedStyle(el);
    return { transform: s.transform, boxShadow: s.boxShadow, cursor: s.cursor };
  });
}

test("a control marked .no-lift really does not lift, and one that is not marked does", async ({ page }) => {
  await signIn(page);
  await serveApi(page, [
    { path: "/api/v1/whoami", body: SESSION_MEMBER },
    { path: "/api/v1/reports/me/daily", body: DAILY },
    { path: "/api/v1/reports/me/wallet", body: WALLET_REPORT },
    { path: "/api/v1/wallet", body: { balance_credits: 500, entries: [], total_entries: 0, offset: 0, limit: 50 } },
    { path: "/api/v1/me/profile", body: { full_name: "Nomsa Khumalo", email: "n@test.local", photo_url: null, membership_number: "P-1", member_class: "Regular" } },
  ]);

  await page.goto("/reports");
  // The lift lives inside `@media (hover: hover)`: on a touch screen :hover sticks after a tap,
  // so a phone never lifts BY DESIGN and this measurement has nothing to read there.
  test.skip(!(await page.evaluate(() => matchMedia("(hover: hover)").matches)), "touch device: no hover lift by design");

  const dot = page.getByTestId("carousel-dot").first();
  await expect(dot).toBeVisible();
  await expect(dot).toHaveClass(/no-lift/);

  // The control, first, and it is not optional: "no transform" is also what a page whose
  // stylesheet never loaded reports, so without a surface that DOES lift under the same
  // measurement this test would pass on a broken build.
  // P3: the range presets became `ui/toggle`s, which are `no-lift` (a toggle is set, not
  // pressed), so the lifting control is the page's CSV download — an ordinary button.
  const plain = page.getByRole("button", { name: "Download CSV" });
  await expect(plain).toBeVisible();
  const control = await hovered(plain);
  expect(control.transform, "the base lift rule is not reaching this page, so the reading below would be vacuous")
    .toBe("matrix(1, 0, 0, 1, 0, -1)");
  expect(control.boxShadow).not.toBe("none");

  // And the thing under test. Before the fix this reported the control's exact values.
  const marked = await hovered(dot);
  expect(marked.transform, "`.no-lift` is losing the specificity fight against the base lift rule")
    .toBe("none");
  // The shadow is the other half of the lift; removing one and leaving the other reads as a
  // rendering fault rather than as a hover state.
  expect(marked.boxShadow, "`.no-lift` dropped the motion but kept the lift's shadow").toBe("none");
  // What it must keep: the parts that say "this can be pressed". Opting out of the motion is
  // not opting out of the affordance.
  expect(marked.cursor).toBe("pointer");
});

/**
 * The focus ring's colour, read off a real focused control.
 *
 * <p>
 * <b>The defect.</b> <code>index.css</code> set the ring to
 * <code>2px solid var(--accent-strong, #0369A1)</code>, and <code>--accent-strong</code> has
 * never been defined — the variable this product declares is <code>--accent-strong-rgb</code>,
 * in channels. So the fallback was not a fallback, it was the value: every focus ring on every
 * control in the product rendered <code>#0369A1</code>, the sky-blue the palette was moved off
 * when the club's crest colours landed. It was also the one accent surface a per-tenant override
 * could never have reached, because it was not reading the variable an override sets.
 * </p>
 *
 * <p>
 * <b>Why it has to be a browser test.</b> An undefined custom property resolves silently to its
 * fallback; no build step, linter or type checker sees a difference between a var() that hits
 * and a var() that misses. <code>src/tokens.test.ts</code> can assert the text of the rule and
 * that every <code>--accent*</code> name it references is one the module declares — which is
 * what stops the typo recurring — but only an engine can report the colour that was painted.
 * </p>
 */
test("the focus ring is the product's accent, not an undefined variable's fallback", async ({ page }) => {
  await signIn(page);
  await serveApi(page, [
    { path: "/api/v1/whoami", body: SESSION_MEMBER },
    { path: "/api/v1/wallet", body: { balance_credits: 500, entries: [], total_entries: 0, offset: 0, limit: 50 } },
    { path: "/api/v1/me/profile", body: { full_name: "Nomsa Khumalo", email: "n@test.local", photo_url: null, membership_number: "P-1", member_class: "Regular" } },
  ]);

  await page.goto("/wallet");

  // Keyboard focus specifically: the rule is :focus-visible, which a mouse click does not match.
  const focused = page.locator("button:visible").first();
  await expect(focused).toBeVisible();
  await focused.evaluate((el: HTMLElement) => el.focus());
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");

  const ring = await focused.evaluate((el) => {
    const s = getComputedStyle(el);
    return { color: s.outlineColor, width: s.outlineWidth, style: s.outlineStyle };
  });

  // #00498D. Chromium reports outline-color resolved, so a var() that missed would report
  // rgb(3, 105, 161) here — which is exactly what it did before the fix.
  expect(ring.color, "the focus ring is painting a colour that is not the accent token").toBe("rgb(0, 73, 141)");
  expect(ring.style).toBe("solid");
  expect(ring.width).toBe("2px");
});
