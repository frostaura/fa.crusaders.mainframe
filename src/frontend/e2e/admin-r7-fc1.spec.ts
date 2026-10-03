import { type Locator, type Page } from "@playwright/test";
import { SESSION_ADMIN, serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { BOOKING, PEOPLE, SAM, ALEX, detailFixture, memberShellRoutes, seat } from "./playersKit";
import { ADMIN_TOUR } from "../src/lib/onboardingCopy";
import { ADJUST_SHEET, SELL_COPY } from "../src/lib/deskMinutesCopy";
import { PACKAGES_COPY } from "../src/lib/packagesCopy";

// A cold dev server compiles the admin frame on first ask, and the machine is shared.
test.describe.configure({ timeout: 90_000 });

/**
 * Review round 7, lane FC1 (members, desk sheets, packages, admin player acts, the admin tour) —
 * measured in Chromium against a mocked API: what jsdom cannot see (wrapping, overlap, where focus
 * lands after a Radix surface closes).
 */

const USER = "00000000-0000-4000-8000-000000000701";

function member(overrides: Record<string, unknown> = {}) {
  return {
    user_id: USER, membership_id: "00000000-0000-4000-8000-000000000711", full_name: "Bea Nkosi",
    email: "bea@r7.review.test", membership_number: "MEM-701", status: "Active", email_verified: true,
    balance_minutes: 273, created_at: "2026-09-01T08:00:00Z", photo_url: null, is_admin: false, admin_source: null,
    groups: [], ...overrides,
  };
}

const memberDetail = (overrides: Record<string, unknown> = {}) => ({
  ...member(), account_status: "active", last_login_at: null, passkey_count: 0,
  fingerprints: { count: 0, enrolments: [] }, next_bookings: [], counts_30d: { bookings: 0, no_shows: 0, sessions_played: 0 },
  ...overrides,
});

function adminRoutes(extra: ApiRoute[] = []): ApiRoute[] {
  return [
    ...extra,
    ...memberShellRoutes({ admin: true }),
    { path: "/api/v1/whoami", body: SESSION_ADMIN },
    { path: "/api/v1/admin/doors", body: { doors: [], shut_together: [], shut_individually: [], timezone: "Africa/Johannesburg" } },
    { path: "/api/v1/admin/monitoring/summary", body: { open: {} } },
    { path: "/api/v1/admin/play/results/disputed/count", body: { count: 0 } },
    { path: "/api/v1/admin/biometric/enrollments", body: [] },
    { path: "/api/v1/admin/member-groups", body: { groups: [] } },
    { path: "/api/v1/admin/ledger/", body: [] },
    { path: "/api/v1/admin/minutes/", body: { discount: null, packages: [] } },
    { path: "/api/v1/admin/members/", body: [member()] },
  ];
}

async function open(page: Page, path: string, routes: ApiRoute[], width = 1280, height = 900) {
  await page.setViewportSize({ width, height });
  await signIn(page);
  await serveApi(page, routes);
  await page.goto(path);
}

const BIG = "html { font-size: 32px; }";

/**
 * Words cut across lines: every run of non-space characters under `el` whose own line boxes sit on
 * more than one line ("Mok/oena", "Notificatio/ns"). A break after a hyphen is a real break
 * ("Mokoena-" / "Dlamini"), so a hyphen ends a word.
 */
async function brokenWords(el: Locator, room?: Locator): Promise<string[]> {
  return el.evaluate((root, roomWidth) => {
    const out: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? "";
      if ((node.parentElement?.closest(".sr-only"))) continue;
      for (const m of text.matchAll(/[^\s\u00a0-]+-?/g)) {
        const range = document.createRange();
        range.setStart(node, m.index!);
        range.setEnd(node, m.index! + m[0].length);
        const rects = [...range.getClientRects()].filter((r) => r.width > 0);
        const tops = new Set(rects.map((r) => Math.round(r.top)));
        // A word wider than all the room there is can only break; one that would fit, never.
        const width = rects.reduce((sum, r) => sum + r.width, 0);
        if (tops.size > 1 && (roomWidth === null || width <= roomWidth)) out.push(m[0]);
      }
    }
    return out;
  }, room ? await room.evaluate((box) => {
    const cs = getComputedStyle(box);
    return box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  }) : null);
}

/** A figure's number and its unit on two lines ("4 h 33 | min"): every "<n> <unit>" pair must share a line. */
function splitFigures(el: Locator): Promise<string[]> {
  return el.evaluate((root) => {
    const out: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? "";
      if ((node.parentElement?.closest(".sr-only"))) continue;
      for (const m of text.matchAll(/\d+[\s\u00a0]+(?:d|h|min)\b/g)) {
        const range = document.createRange();
        range.setStart(node, m.index!);
        range.setEnd(node, m.index! + m[0].length);
        const tops = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)));
        if (tops.size > 1) out.push(m[0]);
      }
    }
    return out;
  });
}

/** Text that runs out of its own box — the box clips it, or it paints past the edge. */
function overflowing(el: Locator): Promise<boolean> {
  return el.evaluate((node) => node.scrollWidth > node.clientWidth + 1);
}

const focused = (page: Page) => page.evaluate(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return "<body>";
  return el.getAttribute("aria-label") ?? el.getAttribute("data-slot") ?? el.tagName;
});

/* ───────────────────────────── L7-1 the members list on a phone ───────────────────────────── */

const CLUB = [
  { full_name: "Thandiwe Mokoena-Dlamini", balance_minutes: 200, is_admin: true, admin_source: "config" },
  { full_name: "Bea Nkosi", balance_minutes: 0 },
  { full_name: "Alexandra Featherstonehaugh", balance_minutes: 273, email_verified: false },
  { full_name: "Sipho Dube", balance_minutes: 15_633 },
].map((m, i) => member({
  user_id: `00000000-0000-4000-8000-00000000080${i}`, membership_id: `00000000-0000-4000-8000-00000000081${i}`, ...m,
}));

test.describe("L7-1 — the members list on a phone", () => {
  for (const [width, big] of [[390, true], [320, true], [320, false], [390, false]] as const) {
    test(`at ${width}${big ? " / 200 %" : ""}: names whole, balances whole, every ⋯ on the card`, async ({ page }) => {
      await open(page, "/admin/members", adminRoutes([{ path: "/api/v1/admin/members/", body: CLUB }]), width);
      await expect(page.locator("[data-member-row]").first()).toBeVisible({ timeout: 30_000 });
      if (big) await page.addStyleTag({ content: BIG });
      await page.evaluate(() => document.fonts.ready);
      if (process.env.FC_SHOTS) await page.locator("table[aria-label=Members] tbody").screenshot({ path: `${process.env.FC_SHOTS}/members-${width}${big ? "-x2" : ""}.png` });
      const rows = page.locator("[data-member-row]");
      const narrow = big || width === 320;
      for (let i = 0; i < CLUB.length; i++) {
        const row = rows.nth(i);
        const name = row.locator("a[title]");
        // The NARROW card (under 20rem) gives the name the card's width. At 390 / 100 % the compact
        // card (§4.3, ~72 px) keeps the name beside a badge column: a single 17-letter word beside
        // two badges may still break there (L6-9 holds it to "never clipped"), a known trade.
        if (narrow) expect(await brokenWords(name, row), `${CLUB[i].full_name}: a word of the name is cut`).toEqual([]);
        const balance = row.locator("[data-label='Balance']");
        expect(await splitFigures(balance), `${CLUB[i].full_name}: a balance splits number from unit`).toEqual([]);
        expect(await overflowing(balance.locator("span").first()), `${CLUB[i].full_name}: the balance is cut`).toBe(false);
        const more = row.locator("[data-member-menu]");
        await expect(more, `${CLUB[i].full_name}: no ⋯`).toBeVisible();
        const card = (await row.boundingBox())!;
        const dots = (await more.boundingBox())!;
        expect(dots.x + dots.width, `${CLUB[i].full_name}: the ⋯ is past the card`).toBeLessThanOrEqual(card.x + card.width + 1);
        expect(dots.width, `${CLUB[i].full_name}: the ⋯ is squeezed`).toBeGreaterThanOrEqual(43);
      }
      const sideways = await page.evaluate(() => Math.max(...[document.documentElement, document.getElementById("main-content")]
        .filter(Boolean).map((el) => el!.scrollWidth - el!.clientWidth)));
      expect(sideways).toBeLessThanOrEqual(1);
    });
  }
});

/* ───────────────────────────── J7-5 the member header's balance ───────────────────────────── */

test.describe("J7-5 — the member header's balance never splits a number from its unit", () => {
  for (const [width, minutes] of [[320, 273], [390, 15_633], [320, 15_633], [1280, 15_633]] as const) {
    test(`at ${width} / 200 %, ${minutes} minutes`, async ({ page }) => {
      await open(page, `/admin/members/${USER}`, adminRoutes([
        { path: `/api/v1/admin/members/${USER}`, body: memberDetail({ balance_minutes: minutes }) },
      ]), width);
      const figure = page.getByTestId("member-balance");
      await expect(figure).toBeVisible({ timeout: 30_000 });
      await page.addStyleTag({ content: BIG });
      await page.evaluate(() => document.fonts.ready);
      expect(await splitFigures(figure)).toEqual([]);
      if (process.env.FC_SHOTS) await figure.screenshot({ path: `${process.env.FC_SHOTS}/header-${width}-${minutes}.png` });
    });
  }
});

/* ───────────────────────────── L7-3 / X7-5 the desk's Adjust sheet ───────────────────────────── */

async function openAdjust(page: Page, width: number) {
  await open(page, `/admin/members/${USER}`, adminRoutes([
    { path: `/api/v1/admin/members/${USER}`, body: memberDetail() },
  ]), width, 844);
  const more = page.getByRole("button", { name: "More actions for Bea Nkosi" });
  await expect(more).toBeVisible({ timeout: 30_000 });
  await more.click();
  await page.getByRole("menuitem", { name: "Adjust minutes", exact: true }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  return sheet;
}

test.describe("L7-3 — the Adjust sheet's quick amounts at 200 % text", () => {
  for (const width of [390, 320]) {
    test(`at ${width}: every amount is inside its own button, none overlap`, async ({ page }) => {
      const sheet = await openAdjust(page, width);
      await page.addStyleTag({ content: BIG });
      await page.evaluate(() => document.fonts.ready);
      // Measured once the sheet has finished sliding in, not mid-animation.
      await page.evaluate(() => Promise.all(document.getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => null))));
      if (process.env.FC_SHOTS) await page.screenshot({ path: `${process.env.FC_SHOTS}/adjust-${width}-x2.png` });
      const items = sheet.getByRole("radiogroup", { name: ADJUST_SHEET.quickLabel }).getByRole("radio");
      await expect(items).toHaveCount(4);
      const boxes = [];
      for (let i = 0; i < 4; i++) {
        const item = items.nth(i);
        expect(await overflowing(item), `quick amount ${i} spills out of its button`).toBe(false);
        expect(await brokenWords(item), `quick amount ${i} cuts a word`).toEqual([]);
        boxes.push((await item.boundingBox())!);
      }
      for (let a = 0; a < boxes.length; a++) {
        for (let b = a + 1; b < boxes.length; b++) {
          const [p, q] = [boxes[a], boxes[b]];
          const apart = p.x + p.width <= q.x + 1 || q.x + q.width <= p.x + 1 || p.y + p.height <= q.y + 1 || q.y + q.height <= p.y + 1;
          expect(apart, `quick amounts ${a} and ${b} overlap`).toBe(true);
        }
      }
      const body = (await sheet.locator("[data-slot='dialog-body']").boundingBox())!;
      for (const box of boxes) expect(box.x + box.width).toBeLessThanOrEqual(body.x + body.width + 1);
      // The title is not under the close ×.
      const title = (await sheet.getByRole("heading").first().boundingBox())!;
      const close = (await sheet.getByRole("button", { name: /^Close/ }).first().boundingBox())!;
      const clear = title.x + title.width <= close.x + 1 || close.y + close.height <= title.y + 1 || title.y + title.height <= close.y + 1;
      expect(clear, "the title runs under the close button").toBe(true);
    });
  }
});

test.describe("X7-5 — a desk sheet's Next takes focus to the new step and names it", () => {
  test("Adjust: amount → reason → check", async ({ page }) => {
    const sheet = await openAdjust(page, 1280);
    await sheet.getByRole("radio", { name: /30 minutes/ }).click();
    await sheet.getByRole("button", { name: ADJUST_SHEET.next }).click();
    await expect.poll(() => focused(page)).toMatch(/^Step 2 of 3: Reason/);
    await sheet.getByRole("button", { name: ADJUST_SHEET.back }).click();
    await expect.poll(() => focused(page)).toMatch(/^Step 1 of 3: Amount/);
  });

  test("Sell: package → payment", async ({ page }) => {
    await open(page, `/admin/members/${USER}`, adminRoutes([
      { path: `/api/v1/admin/members/${USER}`, body: memberDetail() },
      { path: `/api/v1/admin/minutes/${USER}/packages`, body: { discount: null, packages: [
        { id: "p-5", name: "5 hours", minutes: 300, price_zar: 550, list_price_zar: 550, discount_bps: 0, saving_zar: null, saving_pct: null, group: null, sort_order: 0 },
      ] } },
    ]), 1280);
    await page.getByRole("button", { name: /Sell package/ }).first().click({ timeout: 30_000 });
    const sheet = page.getByRole("dialog");
    await sheet.getByRole("radio", { name: /5 hours/ }).click();
    await sheet.getByRole("button", { name: SELL_COPY.next }).click();
    await expect.poll(() => focused(page)).toMatch(/^Step 2 of 3: Payment/);
  });
});

/* ───────────────────────────── J7-4 a duplicate package name ───────────────────────────── */

const pkg = (id: string, name: string, minutes: number, price: number, order: number) => ({
  id, name, minutes, price_zar: price, group: null, sort_order: order, status: "active",
  created_at: "2026-09-01T08:00:00Z", updated_at: "2026-09-01T08:00:00Z",
});
const PACKAGES = [pkg("p-1", "One hour", 60, 120, 0), pkg("p-5", "Five hours", 300, 550, 1)];

test.describe("J7-4 — a name already on the shelf is refused AT the name", () => {
  for (const width of [390, 1280]) {
    test(`at ${width}: the name field says so, takes focus, and lets go once edited`, async ({ page }) => {
      await open(page, "/admin/packages", adminRoutes([
        { path: "/api/v1/admin/packages", body: { packages: PACKAGES } },
        { method: "POST", path: "/api/v1/admin/packages", status: 409, body: { error: "package_name_taken", name: "Five hours" } },
      ]), width, 844);
      await page.getByRole("button", { name: PACKAGES_COPY.add }).first().click({ timeout: 30_000 });
      const form = page.locator("[data-package-editor]");
      const name = form.getByRole("textbox", { name: PACKAGES_COPY.nameLabel });
      await name.fill("Five hours");
      await form.getByRole("textbox", { name: PACKAGES_COPY.minutesLabel }).fill("300");
      await form.getByRole("textbox", { name: PACKAGES_COPY.priceLabel }).fill("500");
      await page.locator("button[type=submit]").filter({ hasText: PACKAGES_COPY.saveNew }).click();
      const said = PACKAGES_COPY.errorCodes.package_name_taken;
      await expect(name).toHaveAttribute("aria-invalid", "true");
      await expect(name).toBeFocused();
      await expect(page.getByText(said)).toBeInViewport();
      await expect(name).toHaveAccessibleDescription(new RegExp(said.slice(0, 30)));
      await name.fill("Five hours (winter)");
      await expect(page.getByText(said)).toHaveCount(0);
      await expect(name).not.toHaveAttribute("aria-invalid", "true");
    });
  }
});

/* ───────────────────────────── X7-1 god-mode dialogs give focus back ───────────────────────────── */

const DETAIL = `/api/v1/bookings/${BOOKING}`;
const ALEX_PID = "p0000000-0000-0000-0000-000000000003";

function godModeDetail() {
  const base = detailFixture() as Record<string, unknown>;
  return {
    ...base,
    viewer: { role: "admin", participant_id: null },
    organiser: PEOPLE.sam,
    players: [
      seat({ user_id: SAM, name: PEOPLE.sam.name }),
      seat({ participant_id: ALEX_PID, seat: 2, kind: "member", user_id: ALEX, name: PEOPLE.alex.name, status: "invited", consented_minutes: 0, target_minutes: 25, unpaid_minutes: 25 }),
    ],
    permissions: { ...(base.permissions as object), can_invite: false, can_change_split: false, can_cancel: false },
  };
}

test.describe("X7-1 — closing a god-mode act gives focus back to the seat's Admin menu", () => {
  for (const how of ["Escape", "Cancel"] as const) {
    test(`by ${how}`, async ({ page }) => {
      await signIn(page);
      await serveApi(page, [{ path: DETAIL, body: godModeDetail() }, ...memberShellRoutes({ admin: true })]);
      await page.goto(`/bookings/${BOOKING}`);
      const menu = page.getByRole("button", { name: "Admin actions for Alex" });
      await menu.click({ timeout: 30_000 });
      const item = page.getByRole("menuitem").first();
      await item.focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      if (how === "Escape") await page.keyboard.press("Escape");
      else await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toHaveCount(0);
      await expect.poll(() => focused(page)).toBe("Admin actions for Alex");
    });
  }
});

/* ───────────────────────────── X7-4 the admin tour lets go of focus ───────────────────────────── */

test.describe("X7-4 — closing the admin tour leaves focus on the page, not <body>", () => {
  for (const how of ["close", "skip", "escape"] as const) {
    test(`by ${how}`, async ({ page }) => {
      await open(page, "/admin?tour=replay", adminRoutes([
        { method: "POST", path: "/api/v1/me/onboarding/admin/complete", body: {} },
        { path: "/api/v1/admin/members", body: [] },
      ]), 1280);
      const first = page.getByRole("dialog", { name: ADMIN_TOUR.stops[0].title });
      await expect(first).toBeVisible({ timeout: 30_000 });
      if (how === "close") await first.getByRole("button", { name: ADMIN_TOUR.close }).click();
      else if (how === "skip") await first.getByRole("button", { name: ADMIN_TOUR.skip }).click();
      else await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect.poll(() => focused(page)).not.toBe("<body>");
      const inMain = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return Boolean(el && el !== document.body && el.isConnected && el.getClientRects().length > 0);
      });
      expect(inMain).toBe(true);
    });
  }
});
