import { type Page } from "@playwright/test";
import { serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { BOOKING, detailFixture, memberShellRoutes, seat } from "./playersKit";

/**
 * Review round 9, lane FC9 — the member's screens at 200 % text on a phone.
 *
 * <p>
 * L9-6: a seat chip's status pill broke "Orga/niser" — the avatar kept its row beside a column
 * too narrow for one word. The words are read as TEXT ranges (gotchas-frontend-layout), not boxes.
 * </p>
 */

async function open(page: Page, path: string, width: number, routes: ApiRoute[], bigText = true) {
  await page.setViewportSize({ width, height: 844 });
  await signIn(page);
  await serveApi(page, [...routes, ...memberShellRoutes({ unread: 0 })]);
  await page.goto(path);
  if (bigText) await page.addStyleTag({ content: "html { font-size: 32px; }" });
}

/** Every word under `selector` whose rects sit on two lines (a hyphen, dash, slash or middot may break). */
export async function brokenWords(page: Page, selector: string): Promise<string[]> {
  return page.locator(selector).first().evaluate((root) => {
    const out: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const host = node.parentElement;
      if (!host || host.closest(".sr-only") || host.getClientRects().length === 0) continue;
      for (const m of (node.textContent ?? "").matchAll(/[^\s\-–—/·]+/g)) {
        const range = document.createRange();
        range.setStart(node, m.index);
        range.setEnd(node, m.index + m[0].length);
        const rects = [...range.getClientRects()].filter((r) => r.width > 0);
        if (new Set(rects.map((r) => Math.round(r.top))).size > 1) out.push(`split: ${m[0]}`);
        if (rects.some((r) => r.right > window.innerWidth + 1 || r.left < -1)) out.push(`off-screen: ${m[0]}`);
      }
    }
    return out;
  });
}

const DETAIL: ApiRoute[] = [{ path: `/api/v1/bookings/${BOOKING}`, body: detailFixture({
  players: [
    seat({ name: "Nomsa Khumalo-Mthembu" }),
    seat({ participant_id: "p0000000-0000-0000-0000-000000000003", seat: 3, team: "B", kind: "member", user_id: "u3",
      name: "Alexandria Naidoo", status: "invited", unpaid_minutes: 25 }),
  ],
}) }];

for (const width of [320, 390] as const) {
  test(`L9-6 — seat chips keep every word whole at ${width} px, 200 % text`, async ({ page }) => {
    await open(page, `/bookings/${BOOKING}`, width, DETAIL);
    const chips = page.locator("li[data-seat]").first();
    await expect(chips).toBeVisible();
    await chips.scrollIntoViewIfNeeded();
    for (const li of await page.locator("li[data-seat][data-status]").all()) {
      expect(await brokenWords(page, `li[data-seat="${await li.getAttribute("data-seat")}"]`)).toEqual([]);
    }
    await page.screenshot({ path: test.info().outputPath(`chips-${width}.png`) });
  });
}

test("L9-6 — at normal text the avatar still stands beside the name", async ({ page }) => {
  await open(page, `/bookings/${BOOKING}`, 390, DETAIL, false);
  const chip = page.locator("li[data-seat='1']");
  await expect(chip).toBeVisible();
  const avatar = await chip.locator("[data-slot='avatar']").first().evaluate((el) => el.getBoundingClientRect().toJSON() as DOMRect);
  const name = await chip.getByText("Nomsa", { exact: false }).first().evaluate((el) => el.getBoundingClientRect().toJSON() as DOMRect);
  expect(name.left, "the name is beside the photo").toBeGreaterThan(avatar.right);
  const free = page.locator("li[data-free]").first();
  const ring = await free.locator("span[aria-hidden='true']").first().evaluate((el) => el.getBoundingClientRect().toJSON() as DOMRect);
  const words = await free.getByText("Free seat").evaluate((el) => el.getBoundingClientRect().toJSON() as DOMRect);
  expect(words.left, "a free seat's words are beside its ring").toBeGreaterThan(ring.right);
});

test("L9-6 — at 320 px, 200 % text, a free seat's words stand under its ring, whole", async ({ page }) => {
  await open(page, `/bookings/${BOOKING}`, 320, DETAIL);
  const free = page.locator("li[data-free]").first();
  await expect(free).toBeVisible();
  const ring = await free.locator("span[aria-hidden='true']").first().evaluate((el) => el.getBoundingClientRect().toJSON() as DOMRect);
  const words = await free.getByText("Free seat").evaluate((el) => el.getBoundingClientRect().toJSON() as DOMRect);
  expect(words.top, "under the ring").toBeGreaterThanOrEqual(ring.bottom);
  expect(await brokenWords(page, "li[data-free]")).toEqual([]);
});
