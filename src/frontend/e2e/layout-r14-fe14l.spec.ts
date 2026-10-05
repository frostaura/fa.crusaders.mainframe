import { type Page } from "@playwright/test";
import { SESSION_ADMIN, memberCodeRoutes, serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { BOOKING, SAM, detailFixture, memberShellRoutes, seat } from "./playersKit";

/**
 * Review round 14 (FE14l) — layout, measured in Chromium.
 *
 * <ul>
 *   <li><b>L14-1</b> — from xl at large text the admin's tabs sit in a fixed bar at the foot of the
 *   screen (R13), and the rail's height still subtracted only the TOP bar: Settings and Webhooks
 *   sat under the tab bar, and a click on Webhooks landed on "My Code".</li>
 *   <li><b>L14-2</b> — a cancelled game with nobody on Team B kept Team B's column: a ~760px empty
 *   band at 1280–1920. A finished game draws only the teams that have someone on them, and a lone
 *   team uses the Players block's whole width.</li>
 *   <li><b>L14-3</b> — a long single-word surname broke mid-word ("Wolfeschlegelste/in") in the
 *   members list's cards, on the pass, in an Inbox row and a Change record row. A name now takes a
 *   line of its own before any of its words is split; a word may split only when it is wider than
 *   the whole box it sits in (Chromium's `hyphens: auto` never splits a Capitalised word — measured).</li>
 *   <li><b>L14-4</b> — the account menu cut the name and the address to a few letters at 200 % ("Chiama…").
 *   Both wrap now, the address at its "@" and dots, and the avatar stands over them when the text is
 *   large for the menu.</li>
 * </ul>
 */

// A cold dev server compiles the admin frame on first ask, and the machine is shared.
test.describe.configure({ timeout: 120_000 });

async function open(page: Page, path: string, size: { width: number; height: number }, routes: ApiRoute[], root: number) {
  await page.setViewportSize(size);
  await signIn(page);
  await serveApi(page, routes);
  await page.goto(path, { timeout: 90_000 });
  if (root !== 16) await page.addStyleTag({ content: `html { font-size: ${root}px; }` });
  await expect(page.locator("nav[data-primary-nav]")).toBeAttached();
  await page.evaluate(() => document.fonts.ready);
}

function adminRoutes(extra: ApiRoute[] = []): ApiRoute[] {
  return [
    ...extra,
    { path: "/api/v1/admin/doors", body: { doors: [], shut_together: [], shut_individually: [], timezone: "Africa/Johannesburg" } },
    { path: "/api/v1/admin/monitoring/summary", body: { open: { critical: 3 } } },
    { path: "/api/v1/admin/play/results/disputed/count", body: { count: 0 } },
    ...memberShellRoutes({ admin: true }),
  ];
}

/**
 * Brings each rail link into view the way a reader would (scrolling the rail, then the page), and
 * asks the engine what is under its middle. The bottom tab bar must never be what answers.
 */
async function railReach(page: Page) {
  return page.evaluate(async () => {
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const rail = document.querySelector("[data-admin-rail]")!;
    const links = [...rail.querySelectorAll<HTMLAnchorElement>("a[data-admin-nav]")];
    const bar = document.querySelector("nav[data-primary-nav]")!;
    const barFixed = getComputedStyle(bar).position === "fixed";
    const barTop = barFixed ? bar.getBoundingClientRect().top : innerHeight;
    const covered: string[] = [];
    for (const a of links) {
      a.scrollIntoView({ block: "nearest" });
      await frame();
      const r = a.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + 12, (r.top + r.bottom) / 2);
      if (!a.contains(hit) || r.bottom > barTop + 0.5) covered.push(a.dataset.adminNav ?? "?");
    }
    return { barFixed, covered };
  });
}

test.describe("L14-1 — the admin rail ends above the bottom tab bar", () => {
  test.skip(({ isMobile }) => isMobile, "the rail is an xl surface");
  for (const [width, height, root] of [[1280, 900, 24], [1280, 900, 32], [1440, 900, 24], [1440, 900, 32], [1920, 1080, 32], [1280, 720, 24]] as const) {
    for (const path of ["/admin", "/admin/settings", "/admin/webhooks", "/admin/members"]) {
      test(`${path} at ${width}×${height}, ${root} px text: every rail link is reachable`, async ({ page }) => {
        await open(page, path, { width, height }, adminRoutes(), root);
        await expect(page.locator("[data-admin-rail]")).toBeVisible();
        const m = await railReach(page);
        expect(m.barFixed, "this size should put the admin's tabs in the bottom bar").toBe(true);
        expect(m.covered, "rail links under the tab bar").toEqual([]);
        // And a real click on the last one goes where it says.
        if (path !== "/admin/webhooks") {
          await page.locator("[data-admin-rail] a[data-admin-nav=webhooks]").click();
          await expect(page).toHaveURL(/\/admin\/webhooks$/);
        }
      });
    }
  }
});

/** Every admin route the reviewer walked; the full sweep runs with FE14L_SWEEP=1 (24 routes × 5 sizes). */
const ADMIN_ROUTES = [
  "/admin", "/admin/members", "/admin/groups", "/admin/packages", "/admin/results", "/admin/transactions", "/admin/reports",
  "/admin/monitoring", "/admin/monitoring/doors", "/admin/monitoring/doors/log", "/admin/monitoring/devices", "/admin/monitoring/faults",
  "/admin/monitoring/changes", "/admin/monitoring/night", "/admin/schedules", "/admin/courts", "/admin/settings", "/admin/webhooks",
  ...["", "/wallet", "/bookings", "/doors", "/night", "/access"].map((tab) => `/admin/members/00000000-0000-0000-0000-000000000201${tab}`),
];

test("L14-1 sweep — every admin route's rail at 1280/1440/1920 × 150/200 %", async ({ page, isMobile }) => {
  test.skip(isMobile || !process.env.FE14L_SWEEP, "the long sweep is opt-in (FE14L_SWEEP=1)");
  test.setTimeout(900_000);
  const bad: string[] = [];
  for (const [width, height, root] of [[1280, 900, 24], [1280, 900, 32], [1440, 900, 24], [1440, 900, 32], [1920, 1080, 32]] as const) {
    for (const path of ADMIN_ROUTES) {
      await open(page, path, { width, height }, adminRoutes(), root);
      await expect(page.locator("[data-admin-rail]")).toBeVisible();
      const m = await railReach(page);
      if (!m.barFixed || m.covered.length) bad.push(`${path} ${width}/${root}: fixed=${m.barFixed} ${m.covered.join(",")}`);
    }
  }
  expect(bad).toEqual([]);
});

test.describe("L14-1 — a sticky aside or split list is capped above the bottom bars too", () => {
  test.skip(({ isMobile }) => isMobile, "both stand beside their main column only on a wide box");
  test("WithAside and SplitView lose the tab bar's and a docked ContextBar's height", async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await serveApi(page, [{ path: "/api/v1/whoami", body: { is_authenticated: false } }, { path: "/api/v1/session", body: { is_authenticated: false } }]);
    await page.goto("/dev/primitives?section=layout&theme=light&row=1");
    await expect(page.locator('[data-gallery-section="layout"]')).toBeVisible();
    const caps = () => page.evaluate(() => {
      const px = (sel: string) => parseFloat(getComputedStyle(document.querySelector(sel)!).maxHeight);
      return { aside: px("[data-with-aside] [data-aside]"), list: px("[data-split-list]") };
    });
    const before = await caps();
    expect(Number.isFinite(before.aside) && Number.isFinite(before.list), "both are capped").toBe(true);
    await page.evaluate(() => {
      document.documentElement.style.setProperty("--app-bottom-bar-height", "88px");
      document.documentElement.style.setProperty("--context-bar-height", "60px");
    });
    const after = await caps();
    expect(before.aside - after.aside).toBeCloseTo(148, 0);
    expect(before.list - after.list).toBeCloseTo(148, 0);
  });
});

/** Seats 1 and 2 only — Team B was never filled. */
function teamAOnly(status: "cancelled" | "completed" | "no_show") {
  return detailFixture({
    status,
    players: [
      seat(),
      seat({ participant_id: "p0000000-0000-0000-0000-000000000002", seat: 2, kind: "member", user_id: SAM, name: "Sam Petersen",
        status: "accepted", consented_minutes: 25, paid_minutes: 25, target_minutes: 25 }),
    ],
    permissions: {
      can_invite: false, can_change_split: false, can_cancel: false, can_accept: false, can_decline: false,
      can_withdraw: false, withdraw_closes_at: null,
    },
  });
}

async function teamsGeometry(page: Page) {
  return page.evaluate(() => {
    const section = document.querySelector("[data-players-section]")!;
    const teams = [...section.querySelectorAll("h3")].filter((h) => /team/i.test(h.textContent ?? ""));
    const chips = [...section.querySelectorAll("li[data-seat]")].map((li) => li.getBoundingClientRect());
    const usedRight = Math.max(...chips.map((r) => r.right));
    const s = section.getBoundingClientRect();
    return {
      teams: teams.map((h) => h.textContent),
      free: section.querySelectorAll("[data-free]").length,
      used: (usedRight - s.left) / s.width,
      rows: new Set(chips.map((r) => Math.round(r.top))).size,
      sideways: document.querySelector("main")!.scrollWidth - document.querySelector("main")!.clientWidth,
    };
  });
}

test.describe("L14-2 — a finished game draws only the teams that have players", () => {
  for (const status of ["cancelled", "completed", "no_show"] as const) {
    for (const [width, height, root] of [[1280, 900, 16], [1920, 1080, 16], [1920, 1080, 32], [390, 844, 16], [320, 700, 32]] as const) {
      test(`${status} at ${width} px, ${root} px text: no empty Team B column, the width is used`, async ({ page, isMobile }) => {
        test.skip(isMobile !== width < 768, "each width on its own project");
        await signIn(page);
        await serveApi(page, [{ path: `/api/v1/bookings/${BOOKING}`, body: teamAOnly(status) }, ...memberShellRoutes()]);
        await page.setViewportSize({ width, height });
        await page.goto(`/bookings/${BOOKING}`);
        if (root !== 16) await page.addStyleTag({ content: `html { font-size: ${root}px; }` });
        await expect(page.locator("[data-players-section] li[data-seat]")).toHaveCount(2);
        if (process.env.FE14L_SHOTS) await page.screenshot({ path: `${process.env.FE14L_SHOTS}/${status}-${width}-${root}.png` });
        const m = await teamsGeometry(page);
        expect(m.teams).toEqual(["Team A"]);
        expect(m.free, "no seat is left to fill on a finished game").toBe(0);
        // Measured once the large text has settled (a first frame can still be the 16px layout's scroll width).
        await expect.poll(async () => (await teamsGeometry(page)).sideways).toBeLessThanOrEqual(0);
        // The lone team runs the block's width: two chips side by side where the box holds two.
        expect(m.used).toBeGreaterThan(0.95);
        if (width >= 1280 && root === 16) expect(m.rows, "the two chips share a row").toBe(1);
      });
    }
  }
  test("a booked game still shows both teams and its free seats", async ({ page, isMobile }) => {
    test.skip(isMobile, "desktop geometry");
    await signIn(page);
    const booked = detailFixture({ players: [seat()] });
    await serveApi(page, [{ path: `/api/v1/bookings/${BOOKING}`, body: booked }, ...memberShellRoutes()]);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/bookings/${BOOKING}`);
    await expect(page.locator("[data-players-section] li[data-seat]")).toHaveCount(4);
    const m = await teamsGeometry(page);
    expect(m.teams).toEqual(["Team A", "Team B"]);
    expect(m.free).toBe(3);
  });
});

/** 22 letters, one word: wider than any column it was squeezed into. */
const LONG = "Wolfeschlegelsteinhaus";
const LONG_NAME = `Bartholomew ${LONG}`;
/** 17 letters after a hyphen — the reviewer's own case, which fits a 320 phone's row at 200 %. */
const HYPHENED = "Featherstonehaugh";
const HYPHENED_NAME = `Alexandra Montgomery-${HYPHENED}`;

/**
 * Every occurrence of `word` under `scope`: whether it was split across lines, its own unbroken
 * width (a nowrap clone in the same font), and the content width of the ROW it sits in — the most
 * room a layout could give it. A split is a defect when the word would have fitted the row.
 */
async function splitWords(page: Page, scope: string, row: string, word: string) {
  return page.evaluate(({ scope, row, word }) => {
    const out: { word: string; split: boolean; wordW: number; rowW: number }[] = [];
    for (const root of document.querySelectorAll(scope)) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.textContent?.indexOf(word) ?? -1;
        const host = node.parentElement!;
        if (at < 0 || host.closest(".sr-only") || host.getClientRects().length === 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + word.length);
        const tops = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)));
        const probe = document.createElement("span");
        const cs = getComputedStyle(host);
        probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${cs.font};letter-spacing:${cs.letterSpacing};font-stretch:${cs.fontStretch}`;
        probe.textContent = word;
        document.body.append(probe);
        const wordW = probe.getBoundingClientRect().width;
        probe.remove();
        const box = (host.closest(row) ?? root) as HTMLElement;
        const pad = getComputedStyle(box);
        const rowW = box.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight);
        out.push({ word, split: tops.size > 1, wordW: Math.round(wordW), rowW: Math.round(rowW) });
      }
    }
    return out;
  }, { scope, row, word });
}

function membersList(): unknown[] {
  return [LONG_NAME, HYPHENED_NAME, "Naledi Khoza"].map((name, i) => ({
    membership_id: `00000000-0000-0000-0000-00000000010${i}`, user_id: `00000000-0000-0000-0000-00000000020${i}`,
    email: `m${i}@sample.review.test`, full_name: name, membership_number: `MEM-100${i}`, photo_url: null,
    status: "Active", email_verified: true, is_admin: i === 1, admin_source: i === 1 ? "granted" : null,
    created_at: "2026-09-05T08:00:00Z", rejection_reason: null, balance_minutes: 570 * (i + 1),
  }));
}

const NOTICE_AT = new Date(Date.now() - 5 * 60_000).toISOString();
const SURFACES = {
  members: {
    path: "/admin/members", scope: "tbody", row: "tr",
    ready: (page: Page) => expect(page.getByText("Naledi Khoza")).toBeVisible({ timeout: 20_000 }),
    routes: (): ApiRoute[] => adminRoutes([
      { path: "/api/v1/admin/members/", body: membersList() },
      { path: "/api/v1/admin/biometric/enrollments", body: [] },
      { path: "/api/v1/admin/member-groups", body: { groups: [] } },
    ]),
  },
  pass: {
    path: "/my-code", scope: "[data-pass-band]", row: "[data-pass-band]",
    ready: (page: Page) => expect(page.locator("[data-pass-band]")).toBeVisible({ timeout: 20_000 }),
    routes: (): ApiRoute[] => [
      { path: "/api/v1/me/profile", body: { full_name: LONG_NAME, email: "b@sample.review.test", photo_url: null, membership_number: "M-1", timezone: "Africa/Johannesburg" } },
      ...memberCodeRoutes(),
      ...memberShellRoutes(),
    ],
  },
  inbox: {
    path: "/inbox", scope: "[data-notification]", row: "[data-notification] > a, [data-notification] > div",
    ready: (page: Page) => expect(page.locator("[data-notification]").first()).toBeVisible({ timeout: 20_000 }),
    routes: (): ApiRoute[] => [
      ...memberShellRoutes({ unread: 1 }),
      { path: "/api/v1/me/notifications", body: { items: [
        { id: "n1", kind: "players.invited", headline: `${LONG_NAME} asked you to play — Court 1`, link: "/bookings/b1", booking_id: "b1", created_at: NOTICE_AT, read_at: null },
        { id: "n2", kind: "players.invited", headline: `${HYPHENED_NAME} asked you to play — Court 2`, link: "/bookings/b2", booking_id: "b2", created_at: NOTICE_AT, read_at: NOTICE_AT },
      ], unread_count: 1, next_cursor: null } },
    ],
  },
  changes: {
    path: "/admin/monitoring/changes", scope: "[data-change-row]", row: "[data-change-row]",
    ready: (page: Page) => expect(page.locator("[data-change-row]").first()).toBeVisible({ timeout: 30_000 }),
    routes: (): ApiRoute[] => adminRoutes([
      { path: "/api/v1/whoami", body: SESSION_ADMIN },
      { path: "/api/v1/admin/changes", body: { rows: [{
        id: "ch-1", occurred_at: "2026-10-03T13:20:00Z", actor: { name: LONG_NAME }, area: "members", action: "updated",
        headline: "Changed a member's details", subject: { kind: "member", label: HYPHENED_NAME }, changes: [],
      }], total: 1, cursor: null, timezone: "Africa/Johannesburg" } },
    ]),
  },
} as const;

test("L14-3 — a long name a search brings in is measured, even when the list keeps its size", async ({ page, isMobile }) => {
  test.skip(isMobile, "one width");
  const s = SURFACES.members;
  await open(page, s.path, { width: 768, height: 900 }, s.routes(), 16);
  await s.ready(page);
  // Pin the frame's size, as a same-size page swap leaves it: nothing about the BOX changes.
  await page.locator("[data-members-frame]").evaluate((el) => { el.style.height = `${el.getBoundingClientRect().height}px`; });
  const search = page.getByPlaceholder("Name, email or member no.");
  await search.fill("Naledi");
  await expect(page.locator("tr[data-member-row]")).toHaveCount(1);
  await search.fill("Bartholomew");
  const row = page.locator("tr[data-member-row]", { hasText: LONG });
  await expect(row).toHaveCount(1);
  await expect(row, "the new row was never measured").toHaveAttribute("data-long-name", "");
  const found = await splitWords(page, s.scope, s.row, LONG);
  expect(found.filter((f) => f.split), JSON.stringify(found)).toEqual([]);
});

/** L6-9's three cards: a hyphened name with two badges, a short one, a long one with three. */
function badgeCards(): unknown[] {
  return ["Thandiwe Mokoena-Dlamini", "Bea Nkosi", "Alexandra Featherstonehaugh"].map((full_name, i) => ({
    membership_id: `00000000-0000-4000-8000-00000000071${i}`, user_id: `00000000-0000-4000-8000-00000000070${i}`,
    email: `b${i}@sample.review.test`, full_name, membership_number: `MEM-200${i}`, photo_url: null, status: "Active",
    email_verified: i !== 2, is_admin: i !== 1, admin_source: i === 0 ? "config" : "granted",
    created_at: "2026-09-05T08:00:00Z", rejection_reason: null, balance_minutes: 150,
  }));
}

test.describe("L14-3 review — a long-name card's badges wrap in a row, not a column", () => {
  for (const [width, root] of [[320, 16], [390, 16], [320, 32], [390, 32]] as const) {
    test(`at ${width} px, ${root} px text: nothing cut, nothing sideways, badges side by side where they fit`, async ({ page, isMobile }) => {
      test.skip(!isMobile, "phone widths");
      await open(page, "/admin/members", { width, height: 844 }, adminRoutes([
        { path: "/api/v1/admin/members/", body: badgeCards() },
        { path: "/api/v1/admin/biometric/enrollments", body: [] },
        { path: "/api/v1/admin/member-groups", body: { groups: [] } },
      ]), root);
      await expect(page.locator("[data-member-row]")).toHaveCount(3, { timeout: 30_000 });
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      if (process.env.FE14L_SHOTS) await page.screenshot({ path: `${process.env.FE14L_SHOTS}/badges-${width}-${root}.png`, fullPage: true });
      const m = await page.locator("[data-member-row]").evaluateAll((rows) => rows.map((row) => {
        const box = row.getBoundingClientRect();
        const cut = [...row.querySelectorAll<HTMLElement>("a[title], [data-slot='badge']")]
          .filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent);
        const past: string[] = [];
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if (!n.textContent?.trim() || n.parentElement?.closest(".sr-only")) continue;
          const r = document.createRange();
          r.selectNodeContents(n);
          for (const rect of r.getClientRects()) if (rect.width > 0 && (rect.right > box.right + 1 || rect.left < box.left - 1)) past.push(n.textContent);
        }
        // Lines of badges by vertical centre (an icon badge sits a pixel off its neighbour's top).
        const mids = [...row.querySelectorAll("[data-slot='badge']")].map((b) => { const r = b.getBoundingClientRect(); return (r.top + r.bottom) / 2; });
        const lines = mids.sort((a, b) => a - b).filter((y, i, all) => i === 0 || y - all[i - 1] > 4).length;
        return { h: Math.round(box.height), long: row.hasAttribute("data-long-name"), cut, past, badgeRows: lines, badges: mids.length };
      }));
      expect(m.flatMap((c) => [...c.cut, ...c.past]), JSON.stringify(m)).toEqual([]);
      await expect.poll(() => page.evaluate(() => Math.max(...[document.scrollingElement!, ...document.querySelectorAll("main")].map((e) => e.scrollWidth - e.clientWidth)))).toBeLessThanOrEqual(1);
      // A long-name card's three badges never stand one per line at normal text.
      for (const c of m) if (c.long && root === 16) expect(c.badgeRows, JSON.stringify(m)).toBeLessThan(c.badges);
      console.log(`${width}/${root} heights ${m.map((c) => `${c.h}${c.long ? "L" : ""}:${c.badgeRows}/${c.badges}`).join(" ")}`);
    });
  }
});

/**
 * The surface, the screen, the root font — and, at 320 / 200 %, the reviewer's own 17-letter case,
 * which must stay WHOLE there: the narrow row steps its type and inset down so that it can.
 */
const L14_3: [keyof typeof SURFACES, number, number, string[]?][] = [
  ["members", 390, 16], ["members", 768, 16], ["members", 768, 32], ["members", 1440, 24], ["members", 1280, 24], ["members", 320, 32, [HYPHENED]],
  ["pass", 320, 16], ["pass", 390, 20], ["pass", 390, 24], ["pass", 768, 24], ["pass", 1280, 22], ["pass", 1920, 24], ["pass", 390, 32],
  ["inbox", 320, 32, [HYPHENED]], ["inbox", 390, 32, [HYPHENED]], ["inbox", 390, 16], ["inbox", 1280, 24],
  ["changes", 320, 32, [HYPHENED]], ["changes", 390, 32, [HYPHENED, LONG]], ["changes", 1280, 24],
];

test.describe("L14-3 — a name takes its own line before a word of it is split", () => {
  for (const [surface, width, root, whole = []] of L14_3) {
    test(`${surface} at ${width} px, ${root} px text: a long surname is never split where it would fit`, async ({ page, isMobile }) => {
      test.skip(isMobile !== width < 768, "each width on its own project");
      const s = SURFACES[surface];
      await open(page, s.path, { width, height: width < 768 ? 844 : 900 }, s.routes(), root);
      await s.ready(page);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      if (process.env.FE14L_SHOTS) await page.screenshot({ path: `${process.env.FE14L_SHOTS}/${surface}-${width}-${root}.png` });
      const found = [...await splitWords(page, s.scope, s.row, LONG), ...await splitWords(page, s.scope, s.row, HYPHENED)];
      expect(found.length, "the long surname is drawn").toBeGreaterThan(0);
      // Split where it would have fitted, or painted past the row unsplit.
      const defects = found.filter((f) => (f.split && f.wordW <= f.rowW) || (!f.split && f.wordW > f.rowW + 1) || (f.split && whole.includes(f.word)));
      expect(defects, JSON.stringify(found)).toEqual([]);
    });
  }
});

const LONG_EMAIL = "bartholomew.wolfeschlegelsteinhaus+club@sample.review.test";

test.describe("L14-4 — the account menu says the whole name and address", () => {
  for (const [width, root] of [[320, 32], [390, 24], [390, 32], [390, 16], [768, 32], [1920, 32], [1280, 16]] as const) {
    test(`at ${width} px, ${root} px text: nothing cut, words whole where they fit`, async ({ page, isMobile }) => {
      test.skip(isMobile !== width < 768, "each width on its own project");
      await open(page, "/wallet", { width, height: width < 768 ? 844 : 900 }, [
        { path: "/api/v1/me/profile", body: { full_name: LONG_NAME, email: LONG_EMAIL, photo_url: null, membership_number: "M-1", timezone: "Africa/Johannesburg" } },
        ...memberShellRoutes(),
      ], root);
      await page.getByRole("button", { name: "Account menu" }).click();
      // The row that holds the name (written so it finds the row before the fix as well as after).
      const identity = page.getByRole("menu").locator("div", { has: page.locator("p", { hasText: LONG_NAME }) }).first();
      await expect(identity).toBeVisible();
      await expect(identity).toContainText(LONG_NAME);
      const m = await identity.evaluate((el) => {
        const cut = [...el.querySelectorAll("p")].filter((p) => p.scrollWidth > p.clientWidth + 1 || getComputedStyle(p).textOverflow === "ellipsis")
          .map((p) => p.textContent);
        const box = el.getBoundingClientRect();
        const past: string[] = [];
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const r = document.createRange();
          r.selectNodeContents(n);
          for (const rect of r.getClientRects()) if (rect.right > box.right + 1 || rect.left < box.left - 1) past.push(n.textContent ?? "");
        }
        const avatar = el.querySelector("[data-slot='avatar']")!.getBoundingClientRect();
        const name = el.querySelector("p")!.getBoundingClientRect();
        return { cut, past, stacked: avatar.bottom <= name.top + 1, nameW: name.width };
      });
      if (process.env.FE14L_SHOTS) await page.screenshot({ path: `${process.env.FE14L_SHOTS}/menu-${width}-${root}.png` });
      expect(m.cut, "a line of the identity is cut short").toEqual([]);
      expect(m.past, "text painted past the menu").toEqual([]);
      const found = await splitWords(page, "[role=menu]", "[data-account-identity]", LONG);
      expect(found.filter((f) => f.split && f.wordW <= f.rowW), JSON.stringify(found)).toEqual([]);
      // At 320 / 200 % the avatar stands over the name, so the name has the menu's width.
      if (width === 320) expect(m.stacked).toBe(true);
      if (root === 16) expect(m.stacked, "at normal text the avatar stays beside the name").toBe(false);
    });
  }
});
