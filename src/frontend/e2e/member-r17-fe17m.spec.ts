import { type Page } from "@playwright/test";
import { expect, serveApi, signIn, test, type ApiRoute } from "./fixtures";
import { BOOKING, CLUB_ZONE, PEOPLE, SAM, detailFixture, memberShellRoutes, seat } from "./playersKit";
import { DETAIL_ACTIONS, PICKER } from "../src/lib/playersCopy";

/**
 * Review round 17, lane FE17m — measured in Chromium.
 *
 * <ul>
 *   <li><b>X17-3</b> — the day strip's radios were 39×56 at 320: each is now a 44px target and
 *   seven still fit (the row reaches into the gutters). The cap banner's "Try …" is a `sm` button,
 *   36px to the eye and 44px to the finger (its `after:` box) — measured where a tap lands.</li>
 *   <li><b>L17-1</b> — the picker's lists were auto-column grids 33px wider than the sheet at
 *   320 / 200 %: nothing in the sheet is wider than the sheet.</li>
 *   <li><b>L17-6</b> — an invite refused at the daily limit said so under the floating Invite bar
 *   while the keyboard went back to Invite: the refusal is focused and clear of the bar.</li>
 * </ul>
 */

test.describe.configure({ timeout: 120_000 });

const inDays = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const DAY = inDays(2);
const COURTS = [{ id: "aaaaaaaa-0000-4000-8000-00000000000a", courtNumber: 1, name: "Court 1" }];

function capped() {
  return {
    date: DAY, timezone: CLUB_ZONE, sliceMinutes: 15, dayStartMinute: 8 * 60, dayEndMinute: 20 * 60,
    advanceBookingDays: 14, penaltyPct: 30, penaltyWindowMinutes: 15, courts: COURTS, slots: [],
    rules: { clubDay: DAY, maxSlotsPerDay: 2, bookedSlotsToday: 2, remainingToday: 0, adminExempt: false },
  };
}

async function large(page: Page, root: number) {
  if (root !== 16) await page.addStyleTag({ content: `html { font-size: ${root}px; }` });
  await page.evaluate(() => document.fonts.ready);
}

/** The longest vertical run of points through the element's middle column that hit it. */
async function tapRun(page: Page, name: string) {
  return page.getByRole("button", { name }).first().evaluate((button) => {
    const box = button.getBoundingClientRect();
    const x = box.left + box.width / 2;
    let run = 0;
    let best = 0;
    for (let y = Math.max(0, box.top - 20); y < Math.min(window.innerHeight, box.bottom + 20); y += 1) {
      const el = document.elementFromPoint(x, y);
      run = el !== null && (el === button || button.contains(el)) ? run + 1 : 0;
      best = Math.max(best, run);
    }
    return { best, eye: box.height };
  });
}

async function openSchedule(page: Page, width: number, root: number) {
  await page.setViewportSize({ width, height: 900 });
  await signIn(page);
  await serveApi(page, [
    { path: "/api/v1/schedule", body: capped() },
    { path: "/api/v1/me/bookings/upcoming", body: { timezone: CLUB_ZONE, items: [] } },
    { path: "/api/v1/me/bookings/recent", body: { timezone: CLUB_ZONE, items: [] } },
    ...memberShellRoutes(),
  ]);
  await page.goto(`/bookings?date=${DAY}`, { timeout: 90_000 });
  await page.waitForSelector('[role="grid"]');
  await large(page, root);
}

for (const [width, root] of [[320, 16], [360, 16], [390, 16], [320, 32], [1280, 16]] as const) {
  test(`X17-3 — every day in the strip is a 44px target at ${width} / ${root * 100 / 16} %, and the page does not scroll sideways`, async ({ page }) => {
    await openSchedule(page, width, root);
    const days = page.locator("[data-week-strip] [role=radio]");
    await expect(days).toHaveCount(7);
    const boxes = await days.evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { w: r.width, h: r.height, top: r.top }; }));
    console.log(`X17-3 ${width}/${root}: ${boxes.map((b) => `${b.w.toFixed(1)}×${b.h.toFixed(0)}`).join(" ")}`);
    for (const b of boxes) {
      expect(b.w, "a day is at least 44px wide").toBeGreaterThanOrEqual(44);
      expect(b.h, "a day is at least 44px tall").toBeGreaterThanOrEqual(44);
    }
    // At the ordinary size seven still fit one row.
    if (root === 16) expect(new Set(boxes.map((b) => Math.round(b.top))).size, "seven days in one row").toBe(1);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, "no sideways scroll").toBeLessThanOrEqual(0);

    const action = page.getByRole("button", { name: /^Try / });
    await expect(action).toBeVisible();
    await action.scrollIntoViewIfNeeded();
    const label = (await action.textContent())!.trim();
    const run = await tapRun(page, label);
    console.log(`X17-3 cap action ${width}/${root}: eye ${run.eye.toFixed(0)}, tap run ${run.best}`);
    expect(run.best, "a 44px run taps the cap banner's action").toBeGreaterThanOrEqual(44);
  });
}

function detailRoutes(extra: ApiRoute[] = []): ApiRoute[] {
  const d = detailFixture({
    players: [
      seat(),
      seat({ participant_id: "p0000000-0000-0000-0000-000000000002", seat: 2, kind: "member", user_id: SAM, name: PEOPLE.sam.name,
        status: "accepted", consented_minutes: 25, paid_minutes: 25, target_minutes: 25 }),
    ],
  });
  const pia = { user_id: "88888888-8888-8888-8888-888888888888", name: "Pia van Partner-Oosthuizen", photo_url: null, played_with_you: 0, member_since: "2026-10-01", member_ref: "K7Q2" };
  return [
    ...extra,
    { path: `/api/v1/bookings/${BOOKING}`, body: d },
    { path: "/api/v1/me/partners/favourites", body: { items: [pia, { ...PEOPLE.sam, played_with_you: 3 }] } },
    { path: "/api/v1/me/partners/recent", body: { items: [] } },
    { path: "/api/v1/members/directory", body: { items: [
      { user_id: "99999999-9999-9999-9999-999999999991", name: "Chiamaka Okafor", photo_url: null, played_with_you: 0, member_since: "2026-10-01", member_ref: "K7Q2" },
      { user_id: "99999999-9999-9999-9999-999999999992", name: "Chiamaka Okafor", photo_url: null, played_with_you: 0, member_since: "2026-10-05", member_ref: "M3X9" },
    ] } },
    ...memberShellRoutes(),
  ];
}

for (const [width, root] of [[320, 32], [390, 32], [320, 16]] as const) {
  test(`L17-1 — nothing in the picker is wider than its sheet at ${width} / ${root * 100 / 16} %`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await signIn(page);
    await serveApi(page, detailRoutes());
    await page.goto(`/bookings/${BOOKING}`, { timeout: 90_000 });
    await large(page, root);
    await page.getByRole("button", { name: DETAIL_ACTIONS.invite }).first().click();
    const sheet = page.getByRole("dialog");
    // The reviewer's case: the Members tab, a search, two namesakes who never played with you.
    await sheet.getByRole("tab", { name: PICKER.members }).click();
    await sheet.getByLabel(PICKER.searchLabel).fill("Chiamaka");
    await expect(sheet.getByRole("button", { name: PICKER.add("Chiamaka Okafor") }).first()).toBeVisible();
    const m = await sheet.evaluate((dialog) => {
      const edge = dialog.getBoundingClientRect().right;
      // The tab row scrolls sideways by design (its fade and caret say so); nothing else may.
      const inScroller = (e: Element) => e.closest("[role=tablist]") !== null;
      const past = [...dialog.querySelectorAll("*")]
        .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !inScroller(e); })
        .map((e) => ({ e, over: e.getBoundingClientRect().right - edge }))
        .sort((a, b) => b.over - a.over)[0];
      return { widest: past?.over ?? 0, what: past ? `${past.e.tagName}.${(past.e.getAttribute("class") ?? "").slice(0, 60)}` : "", scroll: dialog.scrollWidth - dialog.clientWidth };
    });
    console.log(`L17-1 ${width}/${root}: furthest past the sheet's edge ${m.widest.toFixed(1)}px (${m.what}), sideways scroll ${m.scroll}`);
    expect(m.widest, "nothing runs past the sheet").toBeLessThanOrEqual(0.5);
    expect(m.scroll, "the sheet does not scroll sideways").toBeLessThanOrEqual(0);
  });
}

for (const [width, root] of [[320, 32], [390, 16]] as const) {
  test(`L17-6 — a refused invite is focused and clear of the floating bar at ${width} / ${root * 100 / 16} %`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await signIn(page);
    await serveApi(page, detailRoutes([{
      method: "POST", path: `/api/v1/bookings/${BOOKING}/players`, status: 409,
      body: { error: "at_daily_limit", user_id: "88888888-8888-8888-8888-888888888888", name: "Pia van Partner-Oosthuizen" },
    }]));
    await page.goto(`/bookings/${BOOKING}`, { timeout: 90_000 });
    await large(page, root);
    await page.getByRole("button", { name: DETAIL_ACTIONS.invite }).first().click();
    await page.getByRole("dialog").getByRole("button", { name: PICKER.add("Pia van Partner-Oosthuizen") }).click();
    const notice = page.locator("[data-detail-notice]");
    await expect(notice).toContainText("Pia van Partner-Oosthuizen");
    await expect(notice).toBeFocused();
    const geo = await notice.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const bars = [...document.querySelectorAll<HTMLElement>(".z-actionbar")].map((b) => b.getBoundingClientRect()).filter((b) => b.height > 0);
      const covered = bars.some((b) => b.top < r.bottom && b.bottom > r.top && b.left < r.right && b.right > r.left
        // a bar only covers what is under it; the notice's middle must be visible
        && document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 20)) !== el
        && !el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 20))));
      return { top: r.top, bottom: r.bottom, vh: window.innerHeight, covered };
    });
    console.log(`L17-6 ${width}/${root}: notice ${geo.top.toFixed(0)}–${geo.bottom.toFixed(0)} of ${geo.vh}, covered ${geo.covered}`);
    expect(geo.top, "the notice's top is on screen").toBeGreaterThanOrEqual(0);
    expect(geo.top, "the notice starts above the fold").toBeLessThan(geo.vh);
    expect(geo.covered, "the floating bar does not cover the notice's first line").toBe(false);
  });
}
