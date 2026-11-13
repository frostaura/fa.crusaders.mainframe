import type { Page } from "@playwright/test";
import { SESSION_ANON, MEMBER_CODE, memberCodeSecretB64, serveApi, signIn, test, expect, type ApiRoute, singleTap } from "./fixtures";
import { bigText, fontsReady } from "./layoutKit";
import { BOOKING, detailFixture, inviteFixture, memberShellRoutes } from "./playersKit";

/**
 * Review round 9 (lane FA9 — ui primitives, the dialog, the shell, the auth frame): what only a
 * browser can measure. Each block names its finding.
 */

test.describe.configure({ timeout: 120_000 });
test.beforeEach(({ browserName }, info) => { void browserName; test.skip(info.project.name !== "desktop", "widths are set per test"); });

type Rect = { top: number; bottom: number; left: number; right: number; width: number; height: number };
const rectOf = (page: Page, selector: string): Promise<Rect> =>
  page.locator(selector).first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
  });

/** Words under `selector` that paint on more than one line — broken mid-word. */
async function brokenWords(page: Page, selector: string): Promise<string[]> {
  return page.evaluate((sel) => {
    const out: string[] = [];
    for (const root of Array.from(document.querySelectorAll(sel))) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if ((node.parentElement as HTMLElement).closest(".sr-only,[aria-hidden=true]")) continue;
        const text = node.textContent ?? "";
        const re = /[A-Za-z][A-Za-z'’]+/g;
        for (let m = re.exec(text); m; m = re.exec(text)) {
          const range = document.createRange();
          range.setStart(node, m.index);
          range.setEnd(node, m.index + m[0].length);
          const tops = new Set(Array.from(range.getClientRects()).filter((r) => r.width > 0.5).map((r) => Math.round(r.top)));
          if (tops.size > 1) out.push(m[0]);
        }
      }
    }
    return out;
  }, selector);
}

/* ───────────────────────── L9-1 — the auth split is decided by the shell's own width ───────────────────────── */

async function openLogin(page: Page, width: number, height: number, big: boolean) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width, height });
  await serveApi(page, [{ path: "/api/v1/session", body: SESSION_ANON }, { path: "/api/v1/whoami", body: SESSION_ANON }]);
  await page.goto("/login");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 20_000 });
  if (big) await bigText(page);
  await fontsReady(page);
  await page.waitForTimeout(200);
}

/** The brand panel's box, or null when it is not drawn. */
const brandBox = (page: Page) => page.locator("[data-auth-brand]").evaluate((el) => {
  if (getComputedStyle(el).display === "none") return null;
  const r = el.getBoundingClientRect();
  return { left: r.left, right: r.right, inner: el.scrollWidth - el.clientWidth };
});

test.describe("L9-1 — the auth screen splits only when the shell has the room for both", () => {
  for (const [width, height] of [[1024, 768], [1280, 800]] as const) {
    test(`${width} / 200 %: the panel never overlaps the card, and the club's name is whole`, async ({ page }) => {
      await openLogin(page, width, height, true);
      const card = await rectOf(page, "[data-auth-shell] > div:last-child");
      const brand = await brandBox(page);
      test.info().annotations.push({ type: "geometry", description: JSON.stringify({ card, brand }) });
      if (brand) {
        expect(brand.right, "the brand panel runs under the card").toBeLessThanOrEqual(card.left + 0.5);
        expect(brand.inner, "the panel's own content overflows it").toBeLessThanOrEqual(0);
      }
      expect(await brokenWords(page, "[data-auth-shell]")).toEqual([]);
      expect(card.right, "the card runs off the window").toBeLessThanOrEqual(width);
    });
  }

  for (const [width, height] of [[1024, 768], [1280, 800]] as const) {
    test(`${width} at 100 %: the split screen still stands, panel beside the card`, async ({ page }) => {
      await openLogin(page, width, height, false);
      const card = await rectOf(page, "[data-auth-shell] > div:last-child");
      const brand = await brandBox(page);
      expect(brand, "the brand panel is drawn").not.toBeNull();
      expect(brand!.right).toBeLessThanOrEqual(card.left);
    });
  }
});

/* ───────────────────────── Book sheet helpers (L9-2, X9-3) ───────────────────────── */

const COURTS = ["a", "b", "c", "d"].map((x, i) => ({
  id: `aaaaaaaa-0000-4000-8000-00000000000${x}`, courtNumber: i + 1, name: `Court ${i + 1}`,
}));
const inDays = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const DAY = inDays(2);
const FIRST_BOOK = '[role="grid"] button[aria-label^="Book "]';

async function openBookSheet(page: Page, width: number, height: number, big: boolean) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width, height });
  await signIn(page);
  const routes: ApiRoute[] = [
    {
      path: "/api/v1/schedule",
      body: {
        date: DAY, timezone: "UTC", sliceMinutes: 15, dayStartMinute: 8 * 60, dayEndMinute: 20 * 60,
        advanceBookingDays: 14, penaltyPct: 30, penaltyWindowMinutes: 15, courts: COURTS, slots: [],
      },
    },
    { path: "/api/v1/me/bookings/upcoming", body: { timezone: "UTC", items: [] } },
    { path: "/api/v1/me/bookings/recent", body: { timezone: "UTC", items: [] } },
    ...memberShellRoutes({ invites: [inviteFixture({ invite_id: "i0" })] }),
  ];
  await serveApi(page, routes);
  await page.goto(`/bookings?date=${DAY}`);
  await singleTap(page);
  await page.waitForSelector(FIRST_BOOK);
  await page.waitForTimeout(300);
  if (big) await bigText(page);
  await fontsReady(page);
  await page.locator(FIRST_BOOK).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.waitForTimeout(400);
}

/* ───────────────────────── L9-2 — the stepper bar stays inside the dialog's gutter ───────────────────────── */

test.describe("L9-2 — the stepper bar ends at the header's gutter, not past it", () => {
  for (const [width, height, big] of [[390, 844, false], [1280, 800, false], [320, 640, true]] as const) {
    test(`${width}${big ? " / 200 %" : ""}: the bar's right edge is inside the header's right padding`, async ({ page }) => {
      await openBookSheet(page, width, height, big);
      const edge = await page.locator("[data-slot=dialog-header]").evaluate((el) => {
        const r = el.getBoundingClientRect();
        return r.right - parseFloat(getComputedStyle(el).paddingRight);
      });
      const bar = await rectOf(page, '[data-slot=dialog-header] ol[aria-label="Progress"]');
      test.info().annotations.push({ type: "geometry", description: JSON.stringify({ edge, bar }) });
      // Was 40px past it (a -mr-10 left over from the header's old 56px right padding).
      expect(bar.right).toBeLessThanOrEqual(edge + 0.5);
    });
  }
});

/* ───────────────────────── X9-3 — Tab's wrap inside a dialog lands on something you can see ───────────────────────── */

/** Where focus is, and whether any scroller between it and the window hides it. */
function focusSeen(page: Page) {
  return page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      const r = el.getBoundingClientRect();
      const inDialog = !!el.closest("[role=dialog]");
      let visible = r.bottom > 0 && r.top < window.innerHeight;
      for (let at = el.parentElement; at; at = at.parentElement) {
        const style = getComputedStyle(at);
        if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
          const box = at.getBoundingClientRect();
          if (r.bottom <= box.top + 1 || r.top >= box.bottom - 1) visible = false;
        }
      }
      return { inDialog, visible, top: Math.round(r.top), name: el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 30) };
  });
}

async function tabFromClose(page: Page) {
  await page.getByRole("dialog").locator("[data-slot=dialog-close]").focus();
  await page.keyboard.press("Tab");
  await page.waitForTimeout(300);
  const seen = await focusSeen(page);
  test.info().annotations.push({ type: "focus", description: JSON.stringify(seen) });
  expect(seen.inDialog).toBe(true);
  expect(seen.visible, `focus on "${seen.name}" at ${seen.top} is off-screen`).toBe(true);
}

test.describe("X9-3 — Tab from the close × wraps to the first control, scrolled into view", () => {
  test("the invite sheet of a member who is short, 390 / 200 % (was Buy minutes at top 1152, unscrolled)", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);
    const short = inviteFixture({
      balance_minutes: 0, spendable_minutes: 0, held_minutes: 0, balance_after_minutes: -25, short_by_minutes: 25,
    });
    await serveApi(page, memberShellRoutes({ invites: [short], wallet: { balance_minutes: 0, held_minutes: 0, spendable_minutes: 0 } }));
    await page.goto("/bookings/invites");
    const accept = page.getByRole("button", { name: /^Accept/ }).first();
    await expect(accept).toBeVisible({ timeout: 20_000 });
    await bigText(page);
    await fontsReady(page);
    await accept.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.waitForTimeout(500);
    await tabFromClose(page);
  });

  test("the Book sheet, 320 × 640 / 200 %, body scrolled to its end", async ({ page }) => {
    await openBookSheet(page, 320, 640, true);
    const body = page.locator("[data-slot=dialog-body]");
    const scrolls = await body.evaluate((el) => { el.scrollTop = el.scrollHeight; return el.scrollTop; });
    expect(scrolls, "precondition: the body scrolls").toBeGreaterThan(0);
    await tabFromClose(page);
  });
});

/* ───────────────────────── L9-4 — the pass card steps down at large text ───────────────────────── */

const SESSION_MEMBER = { ...SESSION_ANON, user_id: "00000000-0000-0000-0000-000000000009", is_authenticated: true };

function codeRoutes(): ApiRoute[] {
  return [
    { path: "/api/v1/whoami", body: SESSION_MEMBER },
    { path: "/api/v1/wallet", body: { balance_minutes: 500, entries: [], total_entries: 0, offset: 0, limit: 50 } },
    { path: "/api/v1/me/profile", body: { user_id: SESSION_MEMBER.user_id, email: "nomsa@club.test", full_name: "Nomsa Khumalo", photo_url: null, status: "active", is_admin: false, tenant_slug: "crusaders", membership_number: "M-1" } },
    {
      method: "POST", path: "/api/v1/me/code/enrol",
      respond: () => ({ v: 1, ref: MEMBER_CODE.ref, generation: 1, secret: memberCodeSecretB64(), tz: MEMBER_CODE.tz, step_seconds: 30, server_time_ms: Date.now() }),
    },
    { path: "/api/v1/me/code", respond: () => ({ v: 1, ref: MEMBER_CODE.ref, generation: 1, tz: MEMBER_CODE.tz, server_time_ms: Date.now() }) },
    { path: "/api/v1/me/door", body: { doors: false, doors_shut: "none", timezone: "Africa/Johannesburg", policy: "active_member", membership: "active", membership_detail: "active", is_club_admin: false, next_booking: null, early_entry_minutes: null, roster_max_entries: 48, contact: { phone: "021 555 0134", email: null }, door_log_retention_days: 90, last_decision: null } },
    { path: "/api/v1/me/preferences", body: {} },
    { path: "/api/v1/webauthn/credentials", body: [] },
  ];
}

async function openPass(page: Page, width: number, big: boolean) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width, height: 800 });
  await signIn(page);
  await serveApi(page, codeRoutes());
  await page.goto("/my-code");
  await expect(page.locator("[data-pass-band]")).toBeVisible({ timeout: 20_000 });
  if (big) await bigText(page);
  await fontsReady(page);
  await page.waitForTimeout(200);
  return page.locator("[data-pass-band]").evaluate((band) => {
    const ps = Array.from(band.querySelectorAll("p")) as HTMLElement[];
    const [overline, club, member] = ps;
    const avatar = band.lastElementChild as HTMLElement;
    const r = (el: Element) => { const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right }; };
    const cut = (el: HTMLElement) => el.scrollWidth - el.clientWidth > 0 || getComputedStyle(el).textOverflow === "ellipsis" && el.scrollWidth > el.clientWidth;
    // The overline's WORDS, not its box: a grid cell can be narrower than "MEMBER" and paint under the avatar.
    const words = document.createRange();
    words.selectNodeContents(overline);
    const ink = Array.from(words.getClientRects()).filter((x) => x.width > 0);
    const overlineInk = { top: Math.min(...ink.map((x) => x.top)), bottom: Math.max(...ink.map((x) => x.bottom)), left: Math.min(...ink.map((x) => x.left)), right: Math.max(...ink.map((x) => x.right)) };
    return { overline: overlineInk, club: r(club), member: member ? r(member) : null, avatar: r(avatar), cut: [club, member].filter(Boolean).some((el) => cut(el!)), band: r(band) };
  });
}

test.describe("L9-4 — My Code's pass: names whole, MEMBER never under the avatar", () => {
  for (const width of [320, 390]) {
    test(`${width} / 200 %: the club's and member's names are not truncated or broken, and the overline clears the avatar`, async ({ page }) => {
      const m = await openPass(page, width, true);
      test.info().annotations.push({ type: "band", description: JSON.stringify(m) });
      expect(m.cut, "a name is truncated").toBe(false);
      expect(await brokenWords(page, "[data-pass-band]")).toEqual([]);
      const sideBySide = m.overline.right <= m.avatar.left + 0.5;
      const below = m.overline.top >= m.avatar.bottom - 0.5;
      expect(sideBySide || below, "MEMBER paints over/under the avatar").toBe(true);
      for (const part of [m.club, m.member!]) expect(part.right, "a name runs past the band").toBeLessThanOrEqual(m.band.right);
    });
  }

  test("390 at 100 %: crest, names and avatar stay in one row", async ({ page }) => {
    const m = await openPass(page, 390, false);
    expect(Math.abs(m.club.top - m.avatar.top)).toBeLessThan(40);
    expect(m.club.right).toBeLessThanOrEqual(m.avatar.left);
  });
});

/* ───────────────────────── L9-6 — a badge's word is never broken ───────────────────────── */

test.describe("L9-6 — badge pills keep their words whole at 320 / 200 %", () => {
  test("the booking page's seat badges (Organiser, Invited, …)", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 320, height: 700 });
    await signIn(page);
    await serveApi(page, [{ path: `/api/v1/bookings/${BOOKING}`, body: detailFixture() }, ...memberShellRoutes()]);
    await page.goto(`/bookings/${BOOKING}`);
    await expect(page.locator("[data-slot=badge]").first()).toBeVisible({ timeout: 20_000 });
    await bigText(page);
    await fontsReady(page);
    await page.waitForTimeout(200);
    expect(await brokenWords(page, "[data-slot=badge]")).toEqual([]);
    // The primitive's own contract, whatever room a caller leaves: squeeze the row a seat's badge
    // sits in under its word ("Orga / niser" at 320 / 200 % on the reviewer's data). The pill
    // floors at its longest word; it is the caller's row that must wrap or step.
    await page.locator("[data-slot=badge]").first().evaluate((badge) => { (badge.parentElement as HTMLElement).style.width = "4rem"; });
    await page.waitForTimeout(100);
    expect(await brokenWords(page, "[data-slot=badge]")).toEqual([]);
    await page.locator("[data-slot=badge]").first().evaluate((badge) => { (badge.parentElement as HTMLElement).style.width = ""; });
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(sideways).toBeLessThanOrEqual(0);
  });
});
