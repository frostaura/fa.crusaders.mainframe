import type { Page } from "@playwright/test";
import { MEMBER_CODE, SESSION_ANON, memberCodeSecretB64, serveApi, signIn, test, expect, type ApiRoute, singleTap } from "./fixtures";
import { PROFILE_ME, memberShellRoutes } from "./playersKit";
import { BOOK_SHEET } from "../src/lib/bookingsCopy";
import { CONFLICT_UNSURE_TEXT, UNSURE_TEXT } from "../src/lib/bookingErrors";
import { ADMIN_TOUR, ADMIN_TOUR_PATH } from "../src/lib/onboardingCopy";
import { MY_CODE } from "../src/lib/myCodeCopy";

test.describe.configure({ timeout: 120_000 });

/**
 * Review round 17, lane FE17s — shell, errors and admin, measured in Chromium.
 *
 * <ul>
 *   <li><b>X17-1 / L17-5</b> — a booking answered `503 conflict_retry` is re-read, and the sheet then
 *   says someone else was changing that court, "try again now" — never "the club's system didn't
 *   answer". A silent 503 beside it keeps its own words.</li>
 *   <li><b>L17-3</b> — the member combobox's input ring is not cut by the Command root's edge.</li>
 *   <li><b>L17-4</b> — the QR button's ring on the white plate is brand navy in the dark theme.</li>
 *   <li><b>L17-7</b> — the admin tour's mark stays on screen when the rail scrolls its anchor away.</li>
 * </ul>
 */

const COURT = "aaaaaaaa-0000-4000-8000-00000000000c";
const ADMIN_ID = "00000000-0000-0000-0000-000000000002";

function tomorrow(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const day = () => ({
  date: tomorrow(), timezone: "UTC", sliceMinutes: 15, dayStartMinute: 7 * 60, dayEndMinute: 20 * 60, advanceBookingDays: 14,
  penaltyPct: 30, penaltyWindowMinutes: 15, courts: [{ id: COURT, courtNumber: 1, name: "Court 1" }], slots: [],
});

/* ─────────────────────────────── X17-1 ─────────────────────────────── */

const OUTCOMES = [
  { label: "conflict_retry", answer: { error: "conflict_retry" }, said: CONFLICT_UNSURE_TEXT.book.checked },
  { label: "a silent 503", answer: {}, said: UNSURE_TEXT.book.checked },
] as const;

for (const o of OUTCOMES) {
  test(`X17-1 — a member's booking answered ${o.label} is read back and said truly`, async ({ page }) => {
    await signIn(page);
    let posts = 0;
    await serveApi(page, [
      ...memberShellRoutes(),
      { path: "/api/v1/schedule", body: day() },
      { method: "POST", path: "/api/v1/bookings/", status: 503, respond: () => { posts++; return o.answer; } },
    ]);
    await page.goto("/bookings", { timeout: 90_000 });
    await singleTap(page);
    await page.getByRole("button", { name: /^Book Court 1 at / }).first().click();
    const sheet = page.getByRole("dialog", { name: BOOK_SHEET.title(1) });
    await sheet.getByRole("button", { name: BOOK_SHEET.next }).click();
    await page.waitForTimeout(350); // the sheet's own double-tap guard after a step change
    await sheet.getByRole("button", { name: /^Book · / }).click();
    await expect(sheet.getByText(o.said)).toBeVisible();
    expect(posts).toBe(1);
    if (o.label === "conflict_retry") await expect(sheet.getByText(/didn't answer/)).toHaveCount(0);
  });
}

/* ─────────────────────────────── L17-3 ─────────────────────────────── */

const member = (id: string, n: string) => ({
  membership_id: `m-${id}`, user_id: id, email: `pia${n}@club.review.test`, full_name: "Pia van Partner", membership_number: n,
  photo_url: null, status: "Active", created_at: "2024-01-01T00:00:00Z", rejection_reason: null, balance_minutes: 200,
});

/** How far the focused element's ring reaches past the box that clips it, per side (≤ 0 is uncut). */
async function ringPastClip(page: Page, clipSelector: string) {
  return page.evaluate((selector) => {
    const el = document.activeElement as HTMLElement;
    const clip = el.closest(selector)!.getBoundingClientRect();
    const style = getComputedStyle(el);
    const reach = parseFloat(style.outlineOffset) + parseFloat(style.outlineWidth);
    const r = el.getBoundingClientRect();
    return {
      style: style.outlineStyle,
      top: clip.top - (r.top - reach), left: clip.left - (r.left - reach),
      right: (r.right + reach) - clip.right, bottom: (r.bottom + reach) - clip.bottom,
    };
  }, clipSelector);
}

for (const width of [320, 1280]) {
  test(`L17-3 — the member combobox's search ring is whole at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await signIn(page);
    await serveApi(page, [
      { path: "/api/v1/whoami", body: { tenant_slug: "crusaders", tenant_id: "00000000-0000-0000-0000-000000000001", user_id: ADMIN_ID, is_authenticated: true, is_admin: true } },
      { path: "/api/v1/wallet", body: { balance_minutes: 10, entries: [], total_entries: 0, offset: 0, limit: 10 } },
      { path: "/api/v1/me/profile", body: { full_name: "Crusaders Admin", email: "admin@club.review.test", photo_url: null, membership_number: "A-1" } },
      { path: "/api/v1/admin/members", body: [member("bbbbbbbb-0000-4000-8000-00000000000a", "1042"), member("bbbbbbbb-0000-4000-8000-00000000000b", "2210")] },
      { path: "/api/v1/schedule", body: day() },
    ]);
    await page.goto("/bookings", { timeout: 90_000 });
    await singleTap(page);
    await page.getByRole("button", { name: /^Book Court 1 at / }).first().click();
    const sheet = page.getByRole("dialog", { name: BOOK_SHEET.title(1) });
    await sheet.getByRole("radio", { name: BOOK_SHEET.asMember }).click();
    await sheet.getByRole("combobox", { name: new RegExp(`^${BOOK_SHEET.memberLabel}`) }).click();
    await expect(page.locator("[cmdk-input]")).toBeFocused();
    const past = await ringPastClip(page, "[data-slot='command']");
    expect(past.style).toBe("solid");
    for (const side of ["top", "left", "right", "bottom"] as const) expect(past[side], `ring cut at the ${side}`).toBeLessThanOrEqual(0);
  });
}

/* ─────────────────────────────── L17-4 ─────────────────────────────── */

const SESSION_MEMBER = { ...SESSION_ANON, user_id: "00000000-0000-0000-0000-000000000009", is_authenticated: true };

function codeRoutes(): ApiRoute[] {
  return [
    { path: "/api/v1/whoami", body: SESSION_MEMBER },
    { path: "/api/v1/wallet", body: { balance_minutes: 500, entries: [], total_entries: 0, offset: 0, limit: 50 } },
    { path: "/api/v1/me/profile", body: { user_id: SESSION_MEMBER.user_id, email: "nomsa@club.test", full_name: "Nomsa Khumalo", photo_url: null, status: "active", is_admin: false, tenant_slug: "crusaders", membership_number: "M-1" } },
    { method: "POST", path: "/api/v1/me/code/enrol", respond: () => ({ v: 1, ref: MEMBER_CODE.ref, generation: 1, secret: memberCodeSecretB64(), tz: MEMBER_CODE.tz, step_seconds: 30, server_time_ms: Date.now() }) },
    { path: "/api/v1/me/code", respond: () => ({ v: 1, ref: MEMBER_CODE.ref, generation: 1, tz: MEMBER_CODE.tz, server_time_ms: Date.now() }) },
    { path: "/api/v1/me/door", body: { doors: false, doors_shut: "none", timezone: "Africa/Johannesburg", policy: "active_member", membership: "active", membership_detail: "active", is_club_admin: false, next_booking: null, early_entry_minutes: null, roster_max_entries: 48, contact: { phone: "021 555 0134", email: null }, door_log_retention_days: 90, last_decision: null } },
    { path: "/api/v1/me/preferences", body: {} },
    { path: "/api/v1/webauthn/credentials", body: [] },
  ];
}

function contrast(rgb: string, against: [number, number, number]): number {
  const [r, g, b] = (rgb.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number);
  const lum = ([x, y, z]: number[]) => {
    const c = [x, y, z].map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const [l1, l2] = [lum([r, g, b]), lum(against)].sort((a, b2) => b2 - a);
  return (l1 + 0.05) / (l2 + 0.05);
}

for (const scheme of ["dark", "light"] as const) {
  test(`L17-4 — the QR button's ring reads on the white plate (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await signIn(page);
    await serveApi(page, codeRoutes());
    await page.goto("/my-code");
    const qr = page.getByRole("button", { name: MY_CODE.fullScreenTrigger });
    await expect(qr).toBeVisible();
    await qr.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(qr).toBeFocused();
    const ring = await qr.evaluate((el) => ({ color: getComputedStyle(el).outlineColor, style: getComputedStyle(el).outlineStyle }));
    expect(ring.style).toBe("solid");
    expect(contrast(ring.color, [255, 255, 255]), `ring ${ring.color} on the plate`).toBeGreaterThanOrEqual(3);
  });
}

/* ─────────────────────────────── L17-7 ─────────────────────────────── */

function adminRoutes(): ApiRoute[] {
  const prefs = {
    theme: "system", member_onboarding_completed_at: null, member_onboarding_dismissed_at: "2026-09-01T10:00:00Z",
    admin_onboarding_completed_at: "2026-09-01T10:00:00Z", admin_onboarding_dismissed_at: null,
  };
  return [
    ...memberShellRoutes({ admin: true }),
    { path: "/api/v1/me/profile", body: { ...PROFILE_ME, is_admin: true, status: "active", preferences: prefs } },
    { path: "/api/v1/me/preferences", body: { ...prefs, findable: false, show_in_leaderboards: false } },
    { method: "POST", path: "/api/v1/me/onboarding/admin/complete", body: prefs },
    { path: "/api/v1/admin/members", body: [] },
    { path: "/api/v1/admin/monitoring/summary", body: { open: {} } },
    { path: "/api/v1/admin/doors", body: { day_started_at: "2026-09-23T00:00:00Z", timezone: "Africa/Johannesburg", shut_all_active: false, doors: [] } },
  ];
}

test("L17-7 — at 1280 / 150 % the tour's mark stays on screen while the rail scrolls its anchor away", async ({ page }) => {
  const height = 560;
  await page.setViewportSize({ width: 1280, height });
  await signIn(page);
  await serveApi(page, adminRoutes());
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = "html { font-size: 24px; }";
      document.head.append(style);
    });
  });
  await page.goto(ADMIN_TOUR_PATH);
  const mark = page.getByRole("dialog", { name: ADMIN_TOUR.stops[0].title });
  await expect(mark).toBeVisible({ timeout: 45_000 });
  const anchor = page.locator(`[data-admin-rail] [data-admin-nav="${ADMIN_TOUR.stops[0].navId}"]`);
  await expect(anchor).toBeVisible();
  // The rail's own scroller (it is sticky and height-capped), scrolled to its end.
  await anchor.evaluate((item) => {
    let el: HTMLElement | null = item.parentElement;
    while (el && !(el.scrollHeight > el.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
    if (el) el.scrollTop = el.scrollHeight;
  });
  await page.waitForTimeout(400);
  const chrome = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--app-chrome-height")) || 0);
  const gone = (await anchor.boundingBox())!;
  // The scenario: the anchor has scrolled up under the top bar or off the screen.
  expect(gone.y + gone.height, "the rail did not scroll its anchor away — the case is not exercised").toBeLessThanOrEqual(chrome);
  const box = (await mark.boundingBox())!;
  expect(box.y, "the mark rode its anchor under the top bar / off the top").toBeGreaterThanOrEqual(chrome);
  expect(box.y + box.height, "the mark runs off the bottom").toBeLessThanOrEqual(height + 1);
  await expect(mark.getByRole("button", { name: ADMIN_TOUR.next, exact: true })).toBeInViewport({ ratio: 1 });
});
