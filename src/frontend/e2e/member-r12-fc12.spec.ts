import { type Page } from "@playwright/test";
import { serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { BOOKING, CLUB_ZONE, detailFixture, inviteFixture, memberShellRoutes } from "./playersKit";
import { INVITES_COPY } from "../src/lib/playersCopy";

/**
 * Review round 12, lane FC12 — at 320 / 390 px with 200 % text:
 * L12-2: the "At the court" line wraps and its icon kept shrinking to 7.7 px; it keeps 16 px.
 * J12-3: the Decline question is titled for itself and draws no money; its buttons stay inside.
 */

async function open(page: Page, path: string, size: { width: number; height: number }, routes: ApiRoute[] = []) {
  await page.setViewportSize(size);
  await signIn(page);
  await serveApi(page, routes);
  await page.addInitScript(() => {
    const add = () => { const s = document.createElement("style"); s.textContent = "html { font-size: 32px; }"; document.documentElement.appendChild(s); };
    if (document.documentElement) add(); else addEventListener("DOMContentLoaded", add);
  });
  await page.goto(path);
}

const SEAT = "p0000000-0000-0000-0000-000000000003";

for (const width of [320, 390]) {
  test(`L12-2 — "At the court" at ${width} px, 200 % text: the icon keeps its size`, async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "sizes are set per test");
    const checkedIn = new Date(Date.now() - 10 * 60_000).toISOString();
    await open(page, `/bookings/${BOOKING}`, { width, height: 640 }, [
      { path: `/api/v1/bookings/${BOOKING}/result`, status: 404, body: { error: "not_found" } },
      { path: `/api/v1/bookings/${BOOKING}`, body: detailFixture({ attendance: { checked_in_at: checkedIn, players_checked_in: 1 } }) },
      ...memberShellRoutes(),
    ]);
    const line = page.getByText(/^Checked in at/).first();
    await line.scrollIntoViewIfNeeded();
    await expect(line).toBeVisible();
    const icon = await line.evaluate((p) => { const b = p.querySelector("svg")!.getBoundingClientRect(); return [b.width, b.height]; });
    expect(icon[0]).toBeGreaterThanOrEqual(15.5);
    expect(icon[1]).toBeGreaterThanOrEqual(15.5);
    await line.screenshot({ path: info.outputPath(`attendance-${width}x2.png`) });
  });

  test(`J12-3 — the Decline question at ${width} px, 200 % text`, async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "sizes are set per test");
    const invite = inviteFixture({ participant_id: SEAT });
    await open(page, `/invites/${SEAT}`, { width, height: 640 }, [
      { path: "/api/v1/me/invites", body: { items: [invite], count: 1, timezone: CLUB_ZONE } },
      ...memberShellRoutes(),
    ]);
    await page.getByRole("button", { name: INVITES_COPY.decline, exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: INVITES_COPY.declineSheetTitle })).toBeVisible();
    await expect(page.locator("[data-money]")).toHaveCount(0);
    await expect(page.locator("[data-deadline]")).toHaveCount(0);
    await expect(page.getByText(INVITES_COPY.declineNothingMoves, { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: INVITES_COPY.declineKeep })).toBeFocused();
    const wide = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    expect(wide, "something scrolls sideways").toBe(false);
    // A word never breaks mid-word: the organiser's name is one line box per word.
    const name = page.locator("dl dd").filter({ hasText: "Nomsa" }).locator("span span").last();
    expect(await name.evaluate((n) => n.getClientRects().length)).toBe(1);
    // …and no fact's word is cut ("Cou / rt 1"): every word of every value is one line box.
    const cut = await page.locator("dl").first().evaluate((dl) => [...dl.querySelectorAll("dd")].flatMap((dd) => {
      const walker = document.createTreeWalker(dd, NodeFilter.SHOW_TEXT);
      const out: string[] = [];
      for (let t = walker.nextNode(); t; t = walker.nextNode()) {
        const text = t.textContent ?? "";
        // A range may break at its dash ("18:00–" / "18:45"); a word never breaks inside itself.
        for (const m of text.matchAll(/[^\s\u2013]+/g)) {
          const r = document.createRange(); r.setStart(t, m.index!); r.setEnd(t, m.index! + m[0].length);
          if (new Set([...r.getClientRects()].map((b) => Math.round(b.top))).size > 1) out.push(m[0]);
        }
      }
      return out;
    }));
    expect(cut).toEqual([]);
    await page.getByRole("heading", { level: 1 }).screenshot({ path: info.outputPath(`decline-head-${width}x2.png`) });
    await page.locator("dl").first().screenshot({ path: info.outputPath(`decline-facts-${width}x2.png`) });
    await page.screenshot({ path: info.outputPath(`decline-${width}x2.png`) });
  });
}
