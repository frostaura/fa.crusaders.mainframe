import { type Locator, type Page } from "@playwright/test";
import { expect, serveApi, signIn, test, type ApiRoute } from "./fixtures";
import { BOOKING, PEOPLE, detailFixture, inviteFixture, memberShellRoutes, seat } from "./playersKit";
import { DETAIL_ACTIONS, PICKER } from "../src/lib/playersCopy";

/**
 * Review round 18, lane FE18m — measured in Chromium.
 *
 * <ul>
 *   <li><b>L18-1</b> — a picker row at 320 / 200 % left the words a 56px column ("Ch…", "Mem / ber"):
 *   the words now take the row under the photo; no word breaks mid-word. Same for the invites card
 *   heading and the invite page's card-in-card.</li>
 *   <li><b>L18-4</b> — "10 / min" on the accept: a figure is one piece.</li>
 *   <li><b>L18-9</b> — the invite deep link was a 512px column on a 1440px screen.</li>
 *   <li><b>L18-7</b> — a cancelled game drew empty wrappers (a 96px gap).</li>
 *   <li><b>L17-6</b> — the picker's close animation took focus back from a refusal at ~300ms.</li>
 *   <li><b>X18-2</b> — the club adjusting the wallet 0.8 s after the member's own money-path write
 *   raised no toast.</li>
 * </ul>
 */

test.describe.configure({ timeout: 120_000 });

const PID_ALEX = "p0000000-0000-0000-0000-000000000003";

async function large(page: Page, root: number) {
  if (root !== 16) await page.addStyleTag({ content: `html { font-size: ${root}px; }` });
  await page.evaluate(() => document.fonts.ready);
}

/**
 * Every space-separated word in the element's text that the browser broke across lines (its
 * Range has rects on more than one line). Figures glued with no-break spaces count as one word.
 */
async function brokenWords(target: Locator): Promise<string[]> {
  return target.evaluate((root) => {
    const broken: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? "";
      const re = /[^ \n\t-]+-?/g; // a hyphen is a break the word itself offers
      for (let m = re.exec(text); m; m = re.exec(text)) {
        const range = document.createRange();
        range.setStart(node, m.index);
        range.setEnd(node, m.index + m[0].length);
        const tops = new Set([...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1).map((r) => Math.round(r.top)));
        if (tops.size > 1) broken.push(m[0]);
      }
    }
    return broken;
  });
}

const CHIAMAKA = [
  { user_id: "99999999-9999-9999-9999-999999999991", name: "Chiamaka Okafor-Bartholomew", photo_url: null, played_with_you: 0, member_since: "2026-10-01", member_ref: "K7Q2" },
  { user_id: "99999999-9999-9999-9999-999999999992", name: "Chiamaka Okafor-Bartholomew", photo_url: null, played_with_you: 0, member_since: "2026-10-05", member_ref: "M3X9" },
];

/** Three seats taken, one free: the organiser's Invite is offered. */
function threeSeats(): Record<string, unknown> {
  const d = detailFixture();
  return { ...d, players: (d.players as unknown[]).slice(0, 3) };
}

function detailRoutes(extra: ApiRoute[] = [], detail: Record<string, unknown> = threeSeats()): ApiRoute[] {
  return [
    ...extra,
    { path: `/api/v1/bookings/${BOOKING}`, body: detail },
    { path: "/api/v1/me/partners/favourites", body: { items: [{ ...PEOPLE.sam, played_with_you: 3 }] } },
    { path: "/api/v1/me/partners/recent", body: { items: [] } },
    { path: "/api/v1/members/directory", body: { items: CHIAMAKA } },
    ...memberShellRoutes(),
  ];
}

for (const [width, root] of [[320, 32], [320, 24], [390, 32], [320, 16]] as const) {
  test(`L18-1 — a picker row gives the words room and breaks no word at ${width} / ${root * 100 / 16} %`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await signIn(page);
    await serveApi(page, detailRoutes());
    await page.goto(`/bookings/${BOOKING}`, { timeout: 90_000 });
    await large(page, root);
    await page.getByRole("button", { name: DETAIL_ACTIONS.invite }).first().click();
    const sheet = page.getByRole("dialog");
    await sheet.getByRole("tab", { name: PICKER.members }).click();
    await sheet.getByLabel(PICKER.searchLabel).fill("Chiamaka");
    const row = sheet.locator("[data-member-row]").first();
    await expect(row.locator("[data-member-detail]")).toBeVisible();
    const m = await row.evaluate((li) => {
      const name = li.querySelector<HTMLElement>("[data-member-name]")!;
      const words = name.parentElement!.getBoundingClientRect();
      return { li: li.getBoundingClientRect().width, words: words.width, clipped: name.scrollHeight > name.clientHeight + 1 };
    });
    const broken = [...await brokenWords(row.locator("[data-member-detail]")), ...await brokenWords(row.locator("[data-member-name]"))];
    console.log(`L18-1 ${width}/${root}: row ${m.li.toFixed(0)}px, words ${m.words.toFixed(0)}px, name clipped ${m.clipped}, broken ${JSON.stringify(broken)}`);
    expect(m.words, "the words are never a sliver (they were 56px)").toBeGreaterThanOrEqual(120);
    expect(broken, "no word breaks mid-word").toEqual([]);
  });
}

const BARTHOLOMEW = { user_id: "55555555-5555-5555-5555-555555555559", name: "Bartholomew Mkhize", photo_url: null };

for (const [width, root] of [[320, 32], [320, 24], [390, 16]] as const) {
  test(`L18-1 / L18-4 — the invites card and the invite page break no word, and keep each figure whole, at ${width} / ${root * 100 / 16} %`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await signIn(page);
    const invite = inviteFixture({ organiser: BARTHOLOMEW, share_minutes: 10, to_pay_minutes: 10, balance_minutes: 600, spendable_minutes: 600, held_minutes: 0, balance_after_minutes: 590 });
    await serveApi(page, [
      ...memberShellRoutes({ invites: [invite, { ...invite, participant_id: "p-second" }], wallet: { balance_minutes: 600, held_minutes: 0, spendable_minutes: 600 } }),
    ]);
    await page.goto("/bookings/invites", { timeout: 90_000 });
    await large(page, root);
    const card = page.locator("[data-invite]").first();
    await expect(card).toBeVisible();
    const cardBroken = await brokenWords(card);
    await page.goto(`/invites/${PID_ALEX}`, { timeout: 90_000 });
    await large(page, root);
    const panel = page.locator("[data-invite-card]");
    await expect(panel.locator("[data-money-row]").first()).toBeVisible();
    const figuresSplit = await panel.locator("[data-money-row] dd").evaluateAll((dds) => dds.filter((dd) => {
      const range = document.createRange();
      range.selectNodeContents(dd.querySelector("[aria-hidden='true']") ?? dd);
      // The painted figure only: `<Minutes>` carries its words for a screen reader in a 1px sr-only box.
      return new Set([...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1).map((r) => Math.round(r.top))).size > 1;
    }).map((dd) => dd.textContent));
    const factsBroken = await brokenWords(panel.locator("[data-game-facts]"));
    console.log(`L18-1/4 ${width}/${root}: card ${JSON.stringify(cardBroken)}, facts ${JSON.stringify(factsBroken)}, figures split ${JSON.stringify(figuresSplit)}`);
    expect(cardBroken, "the card breaks no word").toEqual([]);
    expect(factsBroken, "the invite page's facts break no word").toEqual([]);
    expect(figuresSplit, "no figure splits from its unit").toEqual([]);
  });
}

test("L18-9 — the invite deep link uses a desktop's width: facts and figures side by side", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  const invite = inviteFixture();
  await serveApi(page, memberShellRoutes({ invites: [invite] }));
  await page.goto(`/invites/${PID_ALEX}`, { timeout: 90_000 });
  const card = page.locator("[data-invite-card]");
  await expect(card.locator("[data-game-facts]")).toBeVisible();
  const g = await card.evaluate((el) => {
    const facts = el.querySelector("[data-game-facts]")!.getBoundingClientRect();
    const money = el.querySelector("[data-money]")!.getBoundingClientRect();
    return { card: el.getBoundingClientRect().width, factsLeft: facts.left, moneyLeft: money.left, factsTop: facts.top, moneyTop: money.top };
  });
  console.log(`L18-9 1440: card ${g.card.toFixed(0)}px, facts at ${g.factsLeft.toFixed(0)},${g.factsTop.toFixed(0)}, money at ${g.moneyLeft.toFixed(0)},${g.moneyTop.toFixed(0)}`);
  expect(g.card, "the card is not a 512px column").toBeGreaterThanOrEqual(800);
  expect(g.moneyLeft, "the money stands beside the facts").toBeGreaterThan(g.factsLeft + 200);
  // A source comment once leaked into the card as text: nothing but the invite is said.
  await expect(card).not.toContainText("R18");
  expect(Math.abs(g.moneyTop - g.factsTop), "on the same row").toBeLessThan(40);
});

test("L18-7 — a cancelled game draws no empty block: every block in the layout has height", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await signIn(page);
  const cancelled = detailFixture({
    status: "cancelled", cancelled_by: "member",
    permissions: { can_invite: false, can_change_split: false, can_cancel: false, can_accept: false, can_decline: false, can_withdraw: false, withdraw_closes_at: null },
  });
  await serveApi(page, detailRoutes([], cancelled));
  await page.goto(`/bookings/${BOOKING}`, { timeout: 90_000 });
  await expect(page.locator("[data-cancelled]")).toBeVisible();
  const empty = await page.locator("[data-detail-layout]").evaluate((layout) =>
    [...layout.children].filter((c) => c.getBoundingClientRect().height < 1).map((c) => c.outerHTML.slice(0, 80)));
  console.log(`L18-7: empty blocks ${JSON.stringify(empty)}`);
  expect(empty).toEqual([]);
});

test("L17-6 — a refused invite keeps focus after the picker has finished closing (animations on)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await signIn(page);
  const pia = { user_id: "88888888-8888-8888-8888-888888888888", name: "Pia van Partner", photo_url: null, played_with_you: 2 };
  await serveApi(page, [
    { method: "POST", path: `/api/v1/bookings/${BOOKING}/players`, status: 409, body: { error: "at_daily_limit", user_id: pia.user_id, name: pia.name } },
    { path: "/api/v1/me/partners/favourites", body: { items: [pia] } },
    ...detailRoutes(),
  ]);
  await page.goto(`/bookings/${BOOKING}`, { timeout: 90_000 });
  await page.getByRole("button", { name: DETAIL_ACTIONS.invite }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: PICKER.add(pia.name) }).click();
  const notice = page.locator("[data-detail-notice]");
  await expect(notice).toContainText("Pia");
  await expect(notice).toBeFocused();
  // Past the close animation (~300ms) and well beyond.
  await page.waitForTimeout(900);
  await expect(page.locator('[data-dialog="player-picker"]')).toHaveCount(0);
  const active = await page.evaluate(() => document.activeElement?.closest("[data-detail-notice]") !== null);
  expect(active, "focus is still on the refusal").toBe(true);
});

/**
 * X18-2 — a fake EventSource the test drives: the app's wallet stream, with a hand on its frames.
 * The reminder (a POST under /api/v1/bookings) is a money-path write: it opened the "own" window.
 */
test("X18-2 — the club's adjustment 0.8 s after the member's own write is toasted, once", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.addInitScript(() => {
    class FakeSource extends EventTarget {
      url: string; readyState = 1; onopen: ((e: Event) => void) | null = null; onmessage: ((e: MessageEvent) => void) | null = null; onerror: ((e: Event) => void) | null = null;
      constructor(url: string) {
        super();
        this.url = url;
        (window as unknown as { __streams: FakeSource[] }).__streams.push(this);
        setTimeout(() => this.onopen?.(new Event("open")), 0);
      }
      close() { this.readyState = 2; }
      push(frame: unknown) { this.dispatchEvent(new MessageEvent("balance", { data: JSON.stringify(frame) })); }
      ping() { this.dispatchEvent(new Event("ping")); }
    }
    (window as unknown as { __streams: FakeSource[] }).__streams = [];
    (window as unknown as { EventSource: unknown }).EventSource = FakeSource;
  });
  await signIn(page);
  await serveApi(page, [
    { method: "POST", path: "/api/v1/wallet/stream-ticket", body: { ticket: "t", expires_in_seconds: 60 } },
    { method: "POST", path: `/api/v1/bookings/${BOOKING}/players/${PID_ALEX}/nudge`, body: { participant_id: PID_ALEX, nudges_left: 1 } },
    ...detailRoutes([], detailFixture({ players: [seat(), seat({ participant_id: PID_ALEX, seat: 3, team: "B", kind: "member", user_id: PEOPLE.alex.user_id, name: PEOPLE.alex.name, status: "invited", unpaid_minutes: 25 })] })),
  ]);
  await page.goto(`/bookings/${BOOKING}`, { timeout: 90_000 });
  await page.waitForFunction(() => (window as unknown as { __streams: unknown[] }).__streams.length > 0);
  const push = (frame: unknown) => page.evaluate((f) => {
    const s = (window as unknown as { __streams: { push: (x: unknown) => void; readyState: number }[] }).__streams.filter((x) => x.readyState === 1);
    s[s.length - 1].push(f);
  }, frame);
  await push({ balance_minutes: 120, held_minutes: 20, spendable_minutes: 100 });
  await page.getByRole("button", { name: DETAIL_ACTIONS.nudgeFor("Alex") }).click();
  await expect(page.locator("[data-detail-notice]")).toContainText(/Alex/);
  await page.waitForTimeout(800);
  await push({ balance_minutes: 125, delta_minutes: 5, reason: "admin_adjustment", held_minutes: 20, spendable_minutes: 105 });
  const toast = page.getByText("The club added 5 minutes to your wallet.");
  await expect(toast).toHaveCount(1);
});
