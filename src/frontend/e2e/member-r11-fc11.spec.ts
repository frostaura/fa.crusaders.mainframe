import { type Page } from "@playwright/test";
import { serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { BOOKING, detailFixture, memberShellRoutes } from "./playersKit";

/**
 * Review round 11, lane FC11 — a booking's page at 320 px with 200 % text (L11-4): the docked
 * "Invite a player" ran 49–309 px inside a 32–288 dock, and "Cancel booking" reached 312 px. Every
 * button on the page stays inside its container and the screen, and its words stay inside it.
 */

async function open(page: Page, path: string, size: { width: number; height: number }, routes: ApiRoute[] = []) {
  await page.setViewportSize(size);
  await signIn(page);
  await serveApi(page, [...routes, ...memberShellRoutes()]);
  await page.addInitScript(() => {
    const add = () => { const s = document.createElement("style"); s.textContent = "html { font-size: 32px; }"; document.documentElement.appendChild(s); };
    if (document.documentElement) add(); else addEventListener("DOMContentLoaded", add);
  });
  await page.goto(path);
}

/** Each visible button whose box leaves its parent or the screen, or whose words leave the box. */
async function spills(page: Page) {
  // The page's own buttons and its dock — the shell's header (avatar, bell) is the shell lane's.
  return page.evaluate(() => [...document.querySelectorAll("button, a[data-slot=button]")].filter((el) => !el.closest("header")).flatMap((el) => {
    const b = el.getBoundingClientRect();
    if (b.width === 0 || b.height === 0) return [];
    const p = (el.parentElement as HTMLElement).getBoundingClientRect();
    const out = b.left < Math.max(0, p.left) - 1 || b.right > Math.min(innerWidth, p.right) + 1
      || (el as HTMLElement).scrollWidth > (el as HTMLElement).clientWidth + 1;
    return out ? [{ name: (el.textContent ?? "").trim().slice(0, 40), left: Math.round(b.left), right: Math.round(b.right), parent: [Math.round(p.left), Math.round(p.right)] }] : [];
  }));
}

for (const width of [320, 390]) {
  test(`L11-4 — a booking's page at ${width} px, 200 % text: docked Invite and Cancel stay inside`, async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "sizes are set per test");
    await open(page, `/bookings/${BOOKING}`, { width, height: 640 }, [
      { path: `/api/v1/bookings/${BOOKING}/result`, status: 404, body: { error: "not_found" } },
      // Three seats taken, so the organiser still has a seat to invite to (the dock's verb).
      { path: `/api/v1/bookings/${BOOKING}`, body: (() => { const d = detailFixture() as { players: unknown[] }; return { ...d, players: d.players.slice(0, 3) }; })() },
    ]);
    const invite = page.getByRole("button", { name: /Invite a player/ }).last();
    await expect(invite).toBeVisible();
    const cancel = page.getByRole("button", { name: /Cancel booking/ });
    await cancel.scrollIntoViewIfNeeded();
    await expect(cancel).toBeVisible();
    expect(await spills(page)).toEqual([]);
    // FA11's ask: the heading's day number never leaves its month ("Sun 4 / Oct").
    const heading = page.getByRole("heading", { level: 1 });
    const lines = await heading.evaluate((h) => [...h.querySelectorAll("[data-kept-figure]")].map((s) => s.getClientRects().length));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((n) => n === 1), JSON.stringify(lines)).toBe(true);
    await heading.screenshot({ path: info.outputPath(`heading-${width}x2.png`) });
    await page.screenshot({ path: info.outputPath(`booking-${width}x2.png`), fullPage: false });
  });
}
