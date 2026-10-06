import type { Page } from "@playwright/test";
import { SESSION_ADMIN, SESSION_ANON, memberCodeRoutes, serveApi, signIn, test, expect } from "./fixtures";
import { bigText } from "./layoutKit";

/**
 * R10 lane FA10 — the primitives at 200 % text, measured in a real engine.
 *
 * - L6-16 rest + sweep: a glyph beside words grows with them. At 200 % (32px root) the member
 *   combobox's caret, a field error's mark, the checkbox tick, the calendar's chevrons, the time
 *   select's clock, the info button's "i", a text link's caret and the refresh age's mark stayed
 *   14–20px. Every glyph the gallery draws in these sections is now at least 24px (0.75 × 32).
 * - The switch's track was 2.75rem (88px at 200 %) around a 22px thumb that travels 18px, so
 *   "on" left the thumb a quarter of the way along. Its track is pixels like the rest of it.
 * - L10-3: My Code's pass is `min(100vw - 32px, 360px)` wide (D7: the QR never shrinks with the
 *   text) and was centred by `mx-auto`; at 200 % the gutter is 32px, the column narrower than the
 *   card, the auto margin floored at zero, and the card ran to the screen's right edge, off-centre,
 *   corners and shadow cut. It is centred on the screen with room on both sides, QR unchanged.
 */

const SECTIONS = ["buttons", "fields", "datetime", "overlays", "shell"] as const;

async function gallery(page: Page, section: string) {
  await serveApi(page, [
    { path: "/api/v1/whoami", body: SESSION_ANON },
    { path: "/api/v1/session", body: SESSION_ANON },
  ]);
  await page.goto(`/dev/primitives?section=${section}&theme=light`);
  await expect(page.locator(`[data-gallery-section="${section}"]`)).toBeVisible();
  await bigText(page);
}

for (const section of SECTIONS) {
  test(`every glyph in the ${section} gallery grows with 200 % text`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await gallery(page, section);
    const small = await page.evaluate(() => [...document.querySelectorAll("main svg")].flatMap((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0) return [];
      const slot = el.closest("[data-slot]")?.getAttribute("data-slot") ?? el.parentElement?.tagName ?? "?";
      return r.width < 24 ? [`${slot} ${Math.round(r.width)}px`] : [];
    }));
    expect(small).toEqual([]);
  });
}

test("the switch's thumb reaches the end of its track at 200 % text", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await gallery(page, "fields");
  const on = page.locator("[data-slot=switch][data-state=checked]").first();
  await expect(on).toBeVisible();
  const gap = await on.evaluate((track) => {
    const thumb = track.querySelector("[data-slot=switch-thumb]")!.getBoundingClientRect();
    const box = track.getBoundingClientRect();
    return box.right - thumb.right;
  });
  // The 2px border is the only room between the thumb and the track's end.
  expect(gap).toBeLessThanOrEqual(4);
});

const TZ = "Africa/Johannesburg";

for (const width of [320, 390]) {
  test(`My Code's pass sits inside the gutter, centred, at ${width} px and 200 % text (L10-3)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await signIn(page);
    await serveApi(page, [
      { path: "/api/v1/whoami", body: { ...SESSION_ADMIN, is_admin: false } },
      { path: "/api/v1/me/profile", body: { full_name: "Lerato Mokoena", email: "lerato@sample.local", photo_url: null, membership_number: "M-0001" } },
      { path: "/api/v1/wallet", body: { balance_minutes: 500, entries: [], total_entries: 0, offset: 0, limit: 50 } },
      ...memberCodeRoutes(),
      {
        path: "/api/v1/me/door",
        body: {
          doors: true, doors_shut: "none", timezone: TZ, policy: "booking_window",
          membership: "active", membership_detail: "active", is_club_admin: false, next_booking: null,
          early_entry_minutes: 30, roster_max_entries: 48,
          contact: { phone: "021 555 0134", email: "info@crusaders.co.za" },
          door_log_retention_days: 90, last_decision: null,
        },
      },
      { path: "/api/v1/me/door/history", body: { items: [], next_cursor: null, retention_days: 90, timezone: TZ } },
    ]);
    await page.goto("/my-code");
    await expect(page.locator("[data-member-code]")).toBeAttached();
    await bigText(page);
    const fit = await page.locator("[data-pass-card]").evaluate((card) => {
      const r = card.getBoundingClientRect();
      return { left: r.left, edge: window.innerWidth - r.right, width: r.width };
    });
    // Centred on the glass, with room for the rounded corners and the shadow on both sides.
    expect(Math.abs(fit.left - fit.edge), JSON.stringify(fit)).toBeLessThanOrEqual(1);
    expect(fit.left, JSON.stringify(fit)).toBeGreaterThanOrEqual(15);
    // D7 still holds: the card (and so the QR) is the width it is at 100 % text.
    expect(fit.width, JSON.stringify(fit)).toBe(Math.min(width - 32, 360));
  });
}

/*
  The member combobox at 320 / 200 %: the row had ~90px for the name beside a 64px avatar and a
  no-shrink balance, so names truncated to nothing, the balance ran under the caret, and the row's
  min-content pushed the page sideways. Names now wrap whole and the balance drops under them.
*/
test("the member combobox shows whole names and its balance clear of the caret at 320 px and 200 % text", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await gallery(page, "fields");
  const trigger = page.locator("[data-slot=member-combobox-trigger]").first();
  await expect(trigger).toBeVisible();
  const read = async () => trigger.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const caret = el.querySelector(":scope > svg")!.getBoundingClientRect();
    const name = el.querySelector(".font-medium.text-sm")!;
    const range = document.createRange();
    range.selectNodeContents(name);
    const text = range.getBoundingClientRect();
    const figure = el.querySelector(".ml-auto")!.getBoundingClientRect();
    const main = document.querySelector("main")!;
    return {
      nameInside: text.left >= box.left - 0.5 && text.right <= caret.left + 0.5 && text.width > 60,
      figureClearOfCaret: figure.right <= caret.left + 0.5 && figure.left >= box.left,
      sideways: main.scrollWidth - main.clientWidth,
    };
  });
  expect(await read()).toEqual({ nameInside: true, figureClearOfCaret: true, sideways: 0 });

  // And every row in the phone's list sheet, the same row component.
  await trigger.click();
  const rows = page.locator("[data-slot=command-item]");
  await expect(rows.first()).toBeVisible();
  const cut = await rows.evaluateAll((all) => all.flatMap((row) => {
    const box = row.getBoundingClientRect();
    const name = row.querySelector(".font-medium.text-sm")!;
    const range = document.createRange();
    range.selectNodeContents(name);
    const text = range.getBoundingClientRect();
    return text.width > 0 && text.right <= box.right + 0.5 && text.left >= box.left - 0.5 ? [] : [name.textContent];
  }));
  expect(cut).toEqual([]);
});
