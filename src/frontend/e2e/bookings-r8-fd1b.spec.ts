import type { Page } from "@playwright/test";
import { serveApi, signIn, test, expect, type ApiRoute, singleTap } from "./fixtures";
import { bigText, firstBookInView, fontsReady, sideways } from "./layoutKit";
import { BOOKING, detailFixture, inviteFixture, memberShellRoutes, seat } from "./playersKit";
import { celebrationFixture, myPlayFixture } from "./playKit";

/**
 * Review round 8 (lane FD1b — Bookings, booking detail, invites) — what only a browser can
 * measure: the §4.2 opening scroll against keyboard focus (X8-1) and the "Booking for" bar (J8-3),
 * the Book sheet's step opening at its top (L8-5), the booking page sideways at 320 / 200 % (L8-3),
 * and the sheet's "Balance after" figure kept whole (L7-4).
 */

test.describe.configure({ timeout: 120_000 });
test.beforeEach(({ browserName }, info) => { void browserName; test.skip(info.project.name !== "desktop", "widths are set per test"); });

const COURTS = ["a", "b", "c", "d"].map((x, i) => ({
  id: `aaaaaaaa-0000-4000-8000-00000000000${x}`, courtNumber: i + 1, name: `Court ${i + 1}`,
}));
const inDays = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const DAY = inDays(2);
const MEMBER = "99999999-0000-4000-8000-000000000001";

function wholeDay() {
  return {
    date: DAY, timezone: "UTC", sliceMinutes: 15, dayStartMinute: 8 * 60, dayEndMinute: 20 * 60,
    advanceBookingDays: 14, penaltyPct: 30, penaltyWindowMinutes: 15, courts: COURTS, slots: [],
  };
}

function game(n: number) {
  const start = new Date(`${inDays(3 + n)}T10:00:00Z`);
  return {
    booking_id: `bbbbbbbb-0000-4000-8000-00000000000${n}`, court_name: `Court ${n}`,
    starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 3_600_000).toISOString(),
    role: "organiser", status: "Confirmed", players: [], my_share_minutes: 50, needs_action: false,
  };
}

function bookingRoutes(options: { admin?: boolean; wallet?: Record<string, unknown> } = {}): ApiRoute[] {
  return [
    { path: "/api/v1/schedule", body: wholeDay() },
    { path: "/api/v1/me/bookings/upcoming", body: { timezone: "UTC", items: [game(1), game(2), game(3)] } },
    { path: "/api/v1/me/bookings/recent", body: { timezone: "UTC", items: [] } },
    { method: "POST", path: "/api/v1/bookings/quote", body: { price_minutes: 15, balance_after_minutes: 510 } },
    { path: `/api/v1/admin/members/${MEMBER}/booking-rules`, body: { day: DAY, groups: [], allowed_windows: null, empty_window_groups: null } },
    { path: `/api/v1/admin/members/${MEMBER}`, body: { full_name: "Naledi Dlamini", balance_minutes: 240 } },
    ...memberShellRoutes({ admin: options.admin, wallet: options.wallet, invites: [inviteFixture({ invite_id: "i0" })] }),
  ];
}

const FIRST_BOOK = '[role="grid"] button[aria-label^="Book "]';
const mainScrollTop = (page: Page) => page.evaluate(() => document.querySelector("main")!.scrollTop);

/** Where focus is, and whether a sighted keyboard user can see it (below the app bar, above the fold). */
const focusFacts = (page: Page) => page.evaluate(() => {
  const el = document.activeElement as HTMLElement | null;
  const main = document.querySelector("main")!.getBoundingClientRect();
  const r = el?.getBoundingClientRect();
  return {
    tag: el?.tagName ?? null,
    inStrip: Boolean(el?.closest("[data-day-strip]")),
    visible: Boolean(r && r.bottom > main.top && r.top >= main.top - 1 && r.top < window.innerHeight),
    top: r ? Math.round(r.top) : null,
  };
});

/* ───────────────────────── X8-1 — the opening scroll never fights keyboard focus ───────────────────────── */

test.describe("X8-1 — §4.2's opening scroll and the route announcer's focus", () => {
  test("arriving from the tab bar at 390: the week is in view, focus is ON it (not a heading under the app bar), and Tab stays there", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);
    await serveApi(page, bookingRoutes());
    await page.goto("/bookings/invites");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    // An in-app navigation: the announcer names the page and moves focus.
    await page.getByRole("link", { name: "Bookings", exact: true }).last().click();
    await page.waitForSelector(FIRST_BOOK);
    // The announcer retries for a while; the page settles.
    await page.waitForTimeout(1200);
    // Dean's §4.2 stands: the first Book cell on the first screen — since 2026-10 by the grid's
    // own scroller, the page holding still (`layoutKit.firstBookInView`).
    const first = await firstBookInView(page);
    expect(first.inScroller && first.onScreen, `first Book cell at y=${Math.round(first.top)}, not in view`).toBe(true);
    const focus = await focusFacts(page);
    expect(focus.visible, `focus is on a ${focus.tag} at y=${focus.top}, out of sight`).toBe(true);
    expect(focus.inStrip, "focus on the week the page opened at").toBe(true);
    const before = await mainScrollTop(page);
    await page.keyboard.press("Tab");
    await page.waitForTimeout(300);
    expect(Math.abs((await mainScrollTop(page)) - before), "the first Tab yanked the page back to the top").toBeLessThanOrEqual(2);
    expect((await focusFacts(page)).visible).toBe(true);
  });

  test("a direct load leaves focus alone and still opens with the first bookable row in view", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);
    await serveApi(page, bookingRoutes());
    await page.goto(`/bookings?date=${DAY}`);
    await page.waitForSelector(FIRST_BOOK);
    await page.waitForTimeout(600);
    const first = await firstBookInView(page);
    expect(first.inScroller && first.onScreen, `first Book cell at y=${Math.round(first.top)}, not in view`).toBe(true);
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  });
});

/* ───────────────────────── J8-3 — booking for a member keeps the bar in view ───────────────────────── */

test.describe("J8-3 — booking FOR a member on a phone", () => {
  test("390: the page opens with the 'Booking for … · can spend' bar in view", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);
    await serveApi(page, bookingRoutes({ admin: true }));
    await page.goto(`/bookings?as=${MEMBER}&date=${DAY}`);
    await singleTap(page);
    await page.waitForSelector(FIRST_BOOK);
    await expect(page.locator("[data-booking-for]")).toContainText("Naledi");
    await page.waitForTimeout(600);
    const bar = await page.locator("[data-booking-for]").evaluate((el) => {
      const r = el.getBoundingClientRect();
      const main = document.querySelector("main")!.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, mainTop: main.top };
    });
    expect(bar.top, "the bar starts under the app bar, not above it").toBeGreaterThanOrEqual(bar.mainTop - 1);
    expect(bar.bottom).toBeLessThanOrEqual(844);
  });
});

/* ───────────────────────── L8-5 — a Book step opens at its top, focus on it ───────────────────────── */

test.describe("L8-5 — the Book sheet's next step opens at its top", () => {
  for (const [width, height, big] of [[320, 640, true], [390, 844, true], [390, 844, false]] as const) {
    test(`${width}${big ? " / 200 %" : ""}: Continue → Confirm is read from its top, with focus on the step`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await signIn(page);
      await serveApi(page, bookingRoutes());
      await page.goto(`/bookings?date=${DAY}`);
      await singleTap(page);
      await page.waitForSelector(FIRST_BOOK);
      await page.waitForTimeout(300);
      if (big) await bigText(page);
      await page.locator(FIRST_BOOK).first().click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Continue" }).click();
      await expect(dialog.locator("[aria-current=step]")).toContainText("Confirm");
      await page.waitForTimeout(500);
      const m = await dialog.evaluate((d) => {
        const body = d.querySelector<HTMLElement>("[data-slot=dialog-body]")!;
        const scrollers = [d, ...d.querySelectorAll<HTMLElement>("*")].filter((e) => e.scrollTop > 0).map((e) => `${e.getAttribute("data-slot") ?? e.tagName}:${e.scrollTop}`);
        const active = document.activeElement;
        return { scrollers, onStep: active === body || Boolean(active && body.contains(active)), active: active?.tagName ?? null };
      });
      expect(m.scrollers, "a scroller opened part-way down the new step").toEqual([]);
      expect(m.onStep, `focus is on ${m.active}, not on the step`).toBe(true);
    });
  }
});

/* ───────────────────────── L7-4 — "Balance after" is never split from its unit ───────────────────────── */

test.describe("L7-4 — the Book sheet's money figures keep number and unit together", () => {
  for (const [width, height] of [[390, 844], [320, 640]] as const) {
    test(`${width} / 200 %: "8 h 45 min" never breaks as "8 h 45 | min"`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await signIn(page);
      await serveApi(page, bookingRoutes({ wallet: { balance_minutes: 545, held_minutes: 5, spendable_minutes: 540 } }));
      await page.goto(`/bookings?date=${DAY}`);
      await singleTap(page);
      await page.waitForSelector(FIRST_BOOK);
      await page.waitForTimeout(300);
      await bigText(page);
      await page.locator(FIRST_BOOK).first().click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("button", { name: "Continue" }).click();
      await expect(dialog.locator("dl dd").first()).toBeVisible();
      const broken = await dialog.evaluate((d) => {
        const out: string[] = [];
        for (const dd of d.querySelectorAll<HTMLElement>("dl dd")) {
          const fig = dd.querySelector<HTMLElement>("[aria-hidden=true]");
          if (!fig?.firstChild) continue;
          const range = document.createRange();
          range.selectNodeContents(fig);
          const lines = new Map<number, string>();
          // Each word's line: a number alone at the end of one line with its unit on the next is the defect.
          const text = fig.textContent ?? "";
          const node = fig.firstChild;
          let at = 0;
          for (const word of text.split(/[ \u00A0]/)) {
            const r = document.createRange();
            r.setStart(node, at); r.setEnd(node, at + word.length);
            const top = Math.round(r.getBoundingClientRect().top);
            lines.set(top, `${lines.get(top) ?? ""} ${word}`.trim());
            at += word.length + 1;
          }
          for (const line of lines.values()) if (/\d$/.test(line)) out.push(`${text} → ${[...lines.values()].join(" | ")}`);
        }
        return out;
      });
      expect(broken).toEqual([]);
    });
  }
});

/* ───────────────────────── L8-3 — the booking page never scrolls sideways ───────────────────────── */

test.describe("L8-3 — member booking detail at 320 / 200 %", () => {
  test("the Team seat cards stack in the column: nothing scrolls sideways", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 320, height: 640 });
    await signIn(page);
    const detail = detailFixture({
      players: [
        seat(),
        seat({ participant_id: "p0000000-0000-0000-0000-000000000002", seat: 2, kind: "member", user_id: "u2", name: "Bongani Mthembu-Abrahams", status: "accepted" }),
        seat({ participant_id: "p0000000-0000-0000-0000-000000000003", seat: 3, team: "B", kind: "member", user_id: "u3", name: "Alexandra Naidoo", status: "invited" }),
      ],
    });
    await serveApi(page, [{ path: `/api/v1/bookings/${BOOKING}`, body: detail }, ...memberShellRoutes()]);
    await page.goto(`/bookings/${BOOKING}`);
    await fontsReady(page);
    await expect(page.locator("[data-players-section]")).toBeVisible();
    await bigText(page);
    await page.waitForTimeout(300);
    expect(await sideways(page)).toBeLessThanOrEqual(0);
  });
});

/* ───────────────────────── L8-7 (Profile part) — "Matches W–L" never breaks at its dash ───────────────────────── */

test.describe("L8-7 — Profile's stat labels at 320 / 200 %", () => {
  test('"Matches W–L" and "Games W–L" keep "W–L" on one line', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 320, height: 640 });
    await signIn(page);
    await serveApi(page, [
      { path: "/api/v1/me/play", body: myPlayFixture() },
      { path: "/api/v1/me/webauthn/credentials", body: [] },
      { path: "/api/v1/me/preferences", body: { findable: false, show_in_leaderboards: false } },
      { path: "/api/v1/me/door/history", body: { items: [], next_cursor: null } },
      ...memberShellRoutes(),
    ]);
    await page.goto("/profile");
    await expect(page.locator("[data-stat=matches]")).toBeVisible();
    await bigText(page);
    await page.waitForTimeout(300);
    const split = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>("[data-stat] dt")).flatMap((dt) => {
      // "W–" and "L" painted on different lines is the defect ("Matches W– / L").
      const walker = document.createTreeWalker(dt, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = (node.textContent ?? "").indexOf("W–L");
        if (at < 0) continue;
        const top = (from: number, to: number) => { const r = document.createRange(); r.setStart(node!, from); r.setEnd(node!, to); return Math.round(r.getBoundingClientRect().top); };
        return top(at, at + 2) === top(at + 2, at + 3) ? [] : [dt.textContent ?? ""];
      }
      return [];
    }));
    expect(split).toEqual([]);
    expect(await sideways(page), "the page scrolls sideways").toBeLessThanOrEqual(0);
    // The ring's centre ("6 h 45 min") breaks between groups, never "45 | min".
    const centre = await page.locator("[data-ring] [aria-hidden=true] span").first().evaluate((el) => {
      const node = el.firstChild!;
      const text = node.textContent ?? "";
      const at = text.lastIndexOf("min");
      const top = (from: number, to: number) => { const r = document.createRange(); r.setStart(node, from); r.setEnd(node, to); return Math.round(r.getBoundingClientRect().top); };
      return { text, same: top(at - 3, at - 1) === top(at, at + 3) };
    });
    expect(centre.same, `"${centre.text}" broke between a number and its unit`).toBe(true);
    // L6-16 (FD1a's ask) — the streak's flame grows with its words (was 20px at 200 %).
    const flame = await page.locator("[data-streak] svg").first().evaluate((el) => ({ w: el.getBoundingClientRect().width, html: el.outerHTML.slice(0, 160) }));
    expect(flame.w, `the flame stayed small: ${flame.html}`).toBeGreaterThanOrEqual(36);
  });
});

test.describe("the monthly ring keeps its size at normal text", () => {
  test("390 at 100 %: the ring is 7rem (112px); it steps down only for large text", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);
    await serveApi(page, [
      { path: "/api/v1/me/play", body: myPlayFixture() },
      { path: "/api/v1/me/webauthn/credentials", body: [] },
      { path: "/api/v1/me/preferences", body: { findable: false, show_in_leaderboards: false } },
      { path: "/api/v1/me/door/history", body: { items: [], next_cursor: null } },
      ...memberShellRoutes(),
    ]);
    await page.goto("/profile");
    const ring = page.locator("[data-ring] [role=img]").first();
    await expect(ring).toBeVisible();
    expect(Math.round((await ring.boundingBox())!.width)).toBe(112);
  });
});

/* ───────────────────────── FD1a's ask — the celebration's centred title stays centred ───────────────────────── */

test.describe("the celebration moment's title", () => {
  for (const width of [390, 1280] as const) {
    test(`${width}: centred on the sheet, clear of the close ×`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.setViewportSize({ width, height: 844 });
      await signIn(page);
      await serveApi(page, [
        { path: "/api/v1/me/play/celebrations", body: { timezone: "Africa/Johannesburg", items: [celebrationFixture()] } },
        { path: "/api/v1/me/play", body: myPlayFixture() },
        { path: "/api/v1/me/webauthn/credentials", body: [] },
        { path: "/api/v1/me/preferences", body: { findable: false, show_in_leaderboards: false } },
        { path: "/api/v1/me/door/history", body: { items: [], next_cursor: null } },
        ...memberShellRoutes(),
      ]);
      await page.goto("/profile");
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      const m = await dialog.evaluate((d) => {
        const box = d.getBoundingClientRect();
        const title = d.querySelector<HTMLElement>("h2, [data-slot=dialog-title]")!;
        const words = Array.from(title.querySelectorAll("span")).filter((s) => !s.classList.contains("sr-only") && s.children.length === 0 && (s.textContent ?? "").trim() !== "").map((s) => s.getBoundingClientRect());
        const close = Array.from(d.querySelectorAll("button")).find((b) => /close/i.test(b.getAttribute("aria-label") ?? b.textContent ?? ""))!.getBoundingClientRect();
        const left = Math.min(...words.map((r) => r.left));
        const right = Math.max(...words.map((r) => r.right));
        return { off: Math.round((left + right) / 2 - (box.left + box.right) / 2), overlap: words.some((r) => r.right > close.left && r.top < close.bottom) };
      });
      expect(Math.abs(m.off), `the title sits ${m.off}px off the sheet's centre`).toBeLessThanOrEqual(3);
      expect(m.overlap, "a title word under the close ×").toBe(false);
    });
  }
});
