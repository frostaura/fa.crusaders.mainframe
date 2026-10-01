import type { Page } from "@playwright/test";
import { SESSION_ADMIN, SESSION_ANON, serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { bigText, fontsReady, sideways, textOffScreen } from "./layoutKit";

/** A lazy route on a cold dev server, under a loaded machine: give the first paint room. */
const ARRIVES = { timeout: 20_000 };

const MEMBER = "00000000-0000-0000-0000-000000000002";
const MEMBER_ID = "bbbbbbbb-0000-4000-8000-00000000000b";

/** A book whose names and comments are as long as the club's real ones (round 5's 1440/1920 shots). */
function book(n: number) {
  return Array.from({ length: n }, (_, i) => {
    const signed = i % 3 === 0 ? 200 + i : -(48 + i);
    return {
      id: `l${String(i).padStart(3, "0")}`, at: new Date(Date.UTC(2026, 0, 28 - (i % 27), 10, i % 60)).toISOString(),
      from: signed >= 0 ? "Club treasury" : "Nomvula Dlamini-Hendricks", to: signed >= 0 ? "Nomvula Dlamini-Hendricks" : "Club treasury",
      amountCredits: Math.abs(signed), signedAmountCredits: signed, type: signed >= 0 ? "AdminTopUp" : "BookingCharge",
      comment: signed >= 0 ? "Desk top-up · R125.00 at 1.6 cr per R1" : "Share of a split booking returned · Court 3 · Thu 15 Jan, 18:00–19:30",
      subjectUserId: MEMBER, subjectName: "Nomvula Dlamini-Hendricks", actorUserId: MEMBER,
      actorName: signed >= 0 ? "Desk Volunteer Bartholomew" : "Nomvula Dlamini-Hendricks", relatedBookingId: null,
    };
  });
}

const ADMIN_SHELL: ApiRoute[] = [
  { path: "/api/v1/whoami", body: SESSION_ADMIN },
  { path: "/api/v1/me/profile", body: { full_name: "Club Admin", email: "a@test.local", photo_url: null, membership_number: "A-1" } },
  { path: "/api/v1/wallet", body: { balance_credits: 0, entries: [], total_entries: 0, offset: 0, limit: 10 } },
];

async function openTransactions(page: Page, width: number, height = 900) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width, height });
  await signIn(page);
  await serveApi(page, [...ADMIN_SHELL, { path: "/api/v1/admin/ledger/", body: book(40) }]);
  await page.goto("/admin/ledger?from=2026-01-01&to=2026-01-31");
  await expect(page.getByRole("table", { name: "Club ledger" })).toBeVisible(ARRIVES);
  await fontsReady(page);
}

const SESSION_MEMBER = { ...SESSION_ANON, user_id: MEMBER, is_authenticated: true };

function memberRoutes(entries: unknown[]): ApiRoute[] {
  return [
    { path: "/api/v1/whoami", body: SESSION_MEMBER },
    { path: "/api/v1/me/profile", body: { user_id: MEMBER, email: "n@club.test", full_name: "Nomvula", photo_url: null, status: "active", is_admin: false, tenant_slug: "crusaders", membership_number: "M-1" } },
    { path: "/api/v1/me/preferences", body: {} },
    { path: "/api/v1/wallet", body: { balance_credits: 300, held_credits: 0, spendable_credits: 300, entries, total_entries: entries.length, offset: 0, limit: 50 } },
  ];
}

async function openWallet(page: Page, width: number, height = 900) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width, height });
  await signIn(page);
  await serveApi(page, [
    ...memberRoutes(book(30)),
    { path: "/api/v1/reports/me/wallet", body: { top_ups_credits: 300, spent_credits: 150, refunds_credits: 0, penalties_credits: 0, adjustments_credits: 0, net_movement_credits: 150, penalty_count: 0, attended_bookings: 3, bookings: 3, minutes_on_court: 135, count: 6 } },
  ]);
  await page.goto("/wallet");
  await expect(page.getByRole("table", { name: "Wallet ledger" })).toBeVisible(ARRIVES);
  await fontsReady(page);
}

/** The table's box, the region, the heads drawn, and where the Amount head sits. */
async function measure(page: Page, table: string) {
  return page.evaluate((name) => {
    const t = document.querySelector(`table[aria-label="${name}"]`) as HTMLElement;
    const region = t.parentElement as HTMLElement;
    const box = t.closest("[data-ledger-box]") as HTMLElement;
    const heads = [...t.querySelectorAll("th")].filter((th) => getComputedStyle(th).display !== "none").map((th) => th.textContent?.trim() || "·");
    const amountHead = [...t.querySelectorAll("th")].find((th) => th.textContent?.includes("Amount")) as HTMLElement;
    const a = amountHead.getBoundingClientRect();
    const r = region.getBoundingClientRect();
    const root = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const was = t.style.width;
    t.style.width = "min-content";
    const minRem = +(t.getBoundingClientRect().width / root).toFixed(1);
    t.style.width = was;
    return {
      boxRem: +(box.getBoundingClientRect().width / root).toFixed(1), minRem, tableW: Math.round(t.getBoundingClientRect().width), regionW: Math.round(r.width),
      scrolls: (region.parentElement as HTMLElement).hasAttribute("data-scrolls"), amountRight: Math.round(a.right), regionRight: Math.round(r.right), heads,
    };
  }, table);
}

/**
 * F5-1 / V5-1 (HIGH): the Amount is always on screen — inside the region, and the cell a pointer
 * finds at its centre IS the amount (pinned over the scrolled cells when the table scrolls).
 */
async function amountVisible(page: Page, table: string) {
  const m = await measure(page, table);
  const hit = await page.evaluate((name) => {
    const t = document.querySelector(`table[aria-label="${name}"]`)!;
    const row = [...t.querySelectorAll("tbody tr")].find((tr) => tr.getBoundingClientRect().height > 0)!;
    const column = row.querySelector("td.text-right") as HTMLElement;
    // In the one-column form (a phone at 200 % text) the amount rides in the movement's cell.
    const stacked = getComputedStyle(column).display === "none";
    const cell = stacked ? row.querySelector("[data-stacked-amount] > span") as HTMLElement : column;
    cell.scrollIntoView({ block: "center" });
    const r = cell.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + Math.min(r.width / 2, 20), r.top + 8);
    return { stacked, ok: !!at && cell.contains(at), right: r.right, vw: window.innerWidth, at: at ? `${at.tagName}.${at.className}`.slice(0, 160) : null };
  }, table);
  if (!hit.stacked) expect(m.amountRight, `the Amount head is past the region's edge (${JSON.stringify(m)})`).toBeLessThanOrEqual(m.regionRight + 1);
  expect(hit.ok, `the amount is what a reader sees at its own place: ${JSON.stringify(hit)}`).toBe(true);
  expect(hit.right).toBeLessThanOrEqual(hit.vw);
  return { ...m, stacked: hit.stacked };
}

test.describe("F5-1 / V5-1: the Amount is always visible, folded by the table's own box", () => {
  for (const width of [1024, 1280, 1440, 1920]) {
    test(`Transactions at ${width}, with and without the movement open beside it`, async ({ page }, info) => {
      test.skip(info.project.name !== "desktop", "one project sweeps the widths");
      await openTransactions(page, width);
      const closed = await amountVisible(page, "Club ledger");
      expect(closed.scrolls, "the book fits its box: nothing to scroll").toBe(false);
      await page.getByRole("button", { name: /^Details — / }).first().click();
      // Narrower than a 72rem box the movement opens as a modal sheet over the book; beside it, a panel.
      if (await page.getByRole("dialog").isVisible()) await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      const open = await amountVisible(page, "Club ledger");
      expect(open.scrolls).toBe(false);
      if (width >= 1280) expect(open.heads).toEqual(expect.arrayContaining(["Time", "From", "To", "Category", "Amount"]));
    });
  }

  for (const width of [390, 768, 1024, 1280, 1920]) {
    test(`Wallet at ${width}, and at 200 % text`, async ({ page }, info) => {
      test.skip(info.project.name !== "desktop", "one project sweeps the widths");
      await openWallet(page, width);
      const normal = await amountVisible(page, "Wallet ledger");
      expect(normal.scrolls).toBe(false);
      expect(await sideways(page)).toBeLessThanOrEqual(0);
      await bigText(page);
      await amountVisible(page, "Wallet ledger");
      expect(await sideways(page)).toBeLessThanOrEqual(0);
    });
  }

  test("a phone at 200 % text: one column, the amount under the movement, nothing to scroll", async ({ page }) => {
    await openTransactions(page, 390, 844);
    await bigText(page);
    const m = await amountVisible(page, "Club ledger");
    expect(m.stacked).toBe(true);
    expect(m.scrolls, `the book fits a 200 % phone (${JSON.stringify(m)})`).toBe(false);
    expect(await sideways(page), "the page itself never scrolls sideways (X5-11)").toBeLessThanOrEqual(0);
    expect(await textOffScreen(page)).toEqual([]);
  });

  test("a wide book that does scroll pins its Amount and Details (the fallback)", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "a desktop width");
    await openTransactions(page, 1280, 800);
    // Squeeze the book's box without moving a threshold: a 61rem box draws From and To, and a
    // narrower table than they need must scroll with its money pinned, not hide it.
    await page.locator("[data-ledger-box]").evaluate((el) => { (el as HTMLElement).style.width = "61rem"; (el.querySelector("table") as HTMLElement).style.minWidth = "80rem"; });
    await expect(page.locator("[data-scrolls]")).toHaveCount(1);
    await amountVisible(page, "Club ledger");
    const region = page.getByRole("region", { name: "Club ledger" });
    await expect(region).toHaveAttribute("tabindex", "0");
    const pinned = await page.evaluate(() => {
      const row = document.querySelector("table[aria-label='Club ledger'] tbody tr")!;
      const amount = row.querySelector("td.text-right")!.getBoundingClientRect();
      const details = row.querySelector("td:last-child")!.getBoundingClientRect();
      const box = document.querySelector("[data-scrolls] [role=region]")!.getBoundingClientRect();
      return { amountRight: amount.right, detailsLeft: details.left, detailsRight: details.right, boxRight: box.right };
    });
    expect(Math.abs(pinned.detailsRight - pinned.boxRight)).toBeLessThanOrEqual(1);
    expect(Math.abs(pinned.amountRight - pinned.detailsLeft)).toBeLessThanOrEqual(1);
  });

  test("320 at 200 % text: Transactions never scrolls the page sideways (X5-11)", async ({ page }) => {
    await openTransactions(page, 320, 700);
    await bigText(page);
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    expect(await textOffScreen(page)).toEqual([]);
  });

  test("the member's Wallet tab beside the members list at 1440 and 1920", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "desktop widths");
    await signIn(page);
    await serveApi(page, [...ADMIN_SHELL,
      { path: "/api/v1/admin/members", body: [] },
      { path: "/api/v1/admin/monitoring/summary", body: { open: {} } },
      { path: "/api/v1/admin/ledger/", body: book(12) },
      { path: `/api/v1/admin/members/${MEMBER_ID}`, body: { user_id: MEMBER_ID, membership_id: "c", full_name: "Naledi Khumalo", email: "n@x.test", membership_number: "CR-1", status: "Active", account_status: "Active", email_verified: true, created_at: "2026-03-01T08:00:00Z", last_login_at: null, photo_url: null, is_admin: false, admin_source: null, groups: [], balance_credits: 300, passkey_count: 0, fingerprints: { count: 0, enrolments: [] }, next_bookings: [], counts_30d: { bookings: 0, no_shows: 0, sessions_played: 0 } } },
    ]);
    for (const width of [1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      if (width === 1440) await page.goto(`/admin/members/${MEMBER_ID}/wallet`);
      await expect(page.getByRole("table", { name: "Naledi Khumalo's ledger" })).toBeVisible({ timeout: 20_000 });
      await amountVisible(page, "Naledi Khumalo's ledger");
    }
  });
});

/** Where the first visible column head and `main` sit, after `main` is scrolled by `by`. */
async function headsAfterScroll(page: Page, table: string, by: number) {
  return page.evaluate(({ name, by }) => {
    const main = document.querySelector("main")!;
    main.scrollTop += by;
    const th = [...document.querySelectorAll(`table[aria-label="${name}"] th`)].find((el) => getComputedStyle(el).display !== "none")!;
    const bar = document.querySelector("[data-context-bar=top]");
    return { head: th.getBoundingClientRect().top, main: main.getBoundingClientRect().top, bar: bar ? bar.getBoundingClientRect().bottom : null, scrolled: main.scrollTop };
  }, { name: table, by });
}

test.describe("V5-6: the column heads stay in view while the page scrolls", () => {
  test("Transactions at 1280: under the sticky filters-and-totals bar", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "a desktop width");
    await openTransactions(page, 1280, 800);
    const at = await headsAfterScroll(page, "Club ledger", 900);
    expect(at.scrolled).toBeGreaterThan(400);
    expect(at.bar).not.toBeNull();
    expect(Math.abs(at.head - at.bar!), `heads at ${at.head}, bar ends at ${at.bar}`).toBeLessThanOrEqual(2);
  });

  test("Wallet: at the top of the page's scroller", async ({ page }) => {
    await openWallet(page, 390, 844);
    const at = await headsAfterScroll(page, "Wallet ledger", 900);
    expect(at.scrolled).toBeGreaterThan(400);
    expect(Math.abs(at.head - at.main)).toBeLessThanOrEqual(2);
  });
});

test.describe("X5-1: a top bar sticks by the room it takes, never by the viewport", () => {
  test("Transactions at 1280: sticks; at 200 % text it scrolls away and the rows come into view", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "a desktop width");
    await openTransactions(page, 1280, 800);
    const bar = page.locator("[data-context-bar=top]");
    await expect(bar).toHaveAttribute("data-sticks");
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue("--context-bar-top-height"))).not.toBe("");
    await bigText(page);
    await expect(bar).not.toHaveAttribute("data-sticks");
    expect(await bar.evaluate((el) => getComputedStyle(el).position)).not.toBe("sticky");
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue("--context-bar-top-height"))).toBe("");
    // Scrolled past the bar, a ledger row is on screen — it never was (665px bar, 744px scroller).
    await page.evaluate(() => { const main = document.querySelector("main")!; main.scrollTop = (document.querySelector("[data-context-bar=top]") as HTMLElement).getBoundingClientRect().bottom + main.scrollTop - 100; });
    const row = page.locator("table[aria-label='Club ledger'] tbody tr").first();
    const r = (await row.boundingBox())!;
    expect(r.y + r.height).toBeLessThanOrEqual(800);
    expect(r.y).toBeGreaterThanOrEqual(0);
  });

  test("Wallet activity: the range card sticks at 1280 and not at 200 % text", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "a desktop width");
    await openActivity(page, 1280, 800);
    const range = page.locator("[data-range-bar]");
    await expect(range).toHaveAttribute("data-sticks");
    await bigText(page);
    await expect(range).not.toHaveAttribute("data-sticks");
    expect(await range.evaluate((el) => getComputedStyle(el).position)).not.toBe("sticky");
  });

  test("Wallet activity on a phone: the wrapped range card does not hold the screen", async ({ page }) => {
    await openActivity(page, 390, 844);
    const range = page.locator("[data-range-bar]");
    const h = (await range.boundingBox())!.height;
    const room = await page.evaluate(() => document.querySelector("main")!.clientHeight);
    if (h > room * 0.3) await expect(range).not.toHaveAttribute("data-sticks");
    else await expect(range).toHaveAttribute("data-sticks");
  });
});

test("X5-2: a focused row lands below the top bar and the column heads (2.4.11)", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "a desktop width");
  await openTransactions(page, 1280, 800);
  await page.evaluate(() => { document.querySelector("main")!.scrollTop = 900; });
  // The row now under the bar and the heads: the first whose top is above the bar's bottom.
  const target = await page.evaluate(() => {
    const bar = document.querySelector("[data-context-bar=top]")!.getBoundingClientRect().bottom;
    const rows = [...document.querySelectorAll("table[aria-label='Club ledger'] tbody tr")];
    const row = rows.find((tr) => { const r = tr.getBoundingClientRect(); return r.top > 0 && r.top < bar; })!;
    return row.getAttribute("data-ledger-row");
  });
  const button = page.locator(`[data-ledger-row="${target}"] button`);
  await button.focus();
  const at = await page.evaluate((id) => {
    const bar = document.querySelector("[data-context-bar=top]")!.getBoundingClientRect().bottom;
    const head = document.querySelector("table[aria-label='Club ledger'] th")!.getBoundingClientRect().bottom;
    const b = document.querySelector(`[data-ledger-row="${id}"] button`)!.getBoundingClientRect();
    return { bar, head, top: b.top };
  }, target);
  expect(at.head).toBeGreaterThan(at.bar - 1);
  expect(at.top, `the focused Details sits at ${at.top}, under heads ending at ${at.head}`).toBeGreaterThanOrEqual(at.head - 1);
});

test.describe("X5-4 / M5-9: the activity tiles and the wallet rail", () => {
  test("390 at 200 % text: no money figure splits inside its number", async ({ page }) => {
    await openActivity(page, 390, 844);
    await expect(page.locator("[data-stat-tiles] dd").first()).toBeVisible();
    await bigText(page);
    const broken = await page.locator("[data-stat-tiles] dd").evaluateAll((dds) => dds.flatMap((dd) => {
      // Every line box of the figure: a number cut across lines shows as a line holding part of a word.
      const range = document.createRange();
      range.selectNodeContents(dd);
      const lines = new Set([...range.getClientRects()].map((r) => Math.round(r.top)));
      const words = (dd.textContent ?? "").trim().split(/\s+/).length;
      return lines.size > words ? [dd.textContent] : [];
    }));
    expect(broken).toEqual([]);
    expect(await sideways(page)).toBeLessThanOrEqual(0);
  });

  test("1280: Top up is the primary action beside the balance, with the last 30 days under it", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "a desktop width");
    await openWallet(page, 1280);
    const rail = page.getByRole("complementary", { name: "Your balance" });
    const topUp = rail.getByRole("link", { name: /Top up/ });
    await expect(topUp).toHaveClass(/(^|\s)bg-primary(\s|$)/);
    const mini = rail.getByRole("region", { name: "Last 30 days" });
    await expect(mini.getByText("+300.00 cr")).toBeVisible();
    await expect(mini.getByText("−150.00 cr")).toBeVisible();
  });
});

async function openActivity(page: Page, width: number, height: number) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width, height });
  await signIn(page);
  await serveApi(page, [
    ...memberRoutes([]),
    { path: "/api/v1/reports/me/wallet", body: { top_ups_credits: 125050.5, spent_credits: 98765.25, refunds_credits: 0, penalties_credits: 0, adjustments_credits: 0, net_movement_credits: 26285.25, penalty_count: 0, attended_bookings: 3, bookings: 3, minutes_on_court: 135, count: 6 } },
    { path: "/api/v1/reports/me/daily", body: Array.from({ length: 30 }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, "0")}`, top_ups_credits: 0, spent_credits: 50, refunds_credits: 0, bookings: 1, attended: 1, minutes_on_court: 45, balance_credits: 300 })) },
  ]);
  await page.goto("/wallet/activity");
  await expect(page.locator("[data-stat-tiles]")).toBeVisible(ARRIVES);
  await fontsReady(page);
}
