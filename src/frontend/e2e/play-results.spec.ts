import AxeBuilder from "@axe-core/playwright";
import { type Page } from "@playwright/test";
import { serveApi, signIn, test, expect } from "./fixtures";
import { detailFixture, memberShellRoutes, SESSION_MEMBER } from "./playersKit";
import { BOOKING, SAM, resultServer } from "./playKit";

/**
 * P12 — a match result on the booking's page (`play.md` §9.2), in a real browser on a phone and
 * a desktop: Nomsa records 3–1 through the sheet (the live check refusing 12–11 on the way), Sam
 * opens the mail's `?result=confirm` link and confirms; in another game Sam disputes with a note.
 * Both pages share one in-memory result server, so each side reads what the other just did.
 */

const DETAIL = `/api/v1/bookings/${BOOKING}`;
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

type Server = ReturnType<typeof resultServer>;

async function openAs(page: Page, who: "nomsa" | "sam", server: Server, theme?: "light" | "dark") {
  await signIn(page);
  if (theme) await page.addInitScript((t) => window.localStorage.setItem("crusaders:theme", t), theme);
  const checkedIn = detailFixture({ attendance: { checked_in_at: new Date().toISOString(), players_checked_in: 1 } });
  await serveApi(page, [
    // Sam's own session first: of two routes the same length, the first declared answers.
    ...(who === "sam" ? [{ path: "/api/v1/whoami", body: { ...SESSION_MEMBER, user_id: SAM } }] : []),
    { path: DETAIL, body: checkedIn },
    ...server.routesFor(who),
    ...memberShellRoutes(),
  ]);
}

async function type(page: Page, game: number, a: number, b: number) {
  await page.getByRole("textbox", { name: `Game ${game}, Side A points` }).fill(String(a));
  await page.getByRole("textbox", { name: `Game ${game}, Side B points` }).fill(String(b));
}

test.describe("a result, recorded and confirmed", () => {
  test("Nomsa records 3–1; Sam confirms it from the mail's link", async ({ page, browser }) => {
    const server = resultServer();
    await openAs(page, "nomsa", server);
    await page.goto(`/bookings/${BOOKING}`);
    const card = page.locator("[data-result-card]");
    await card.getByRole("button", { name: "Record the result" }).click();
    const sheet = page.getByRole("dialog", { name: "Record the result" });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Record result" })).toBeDisabled();

    await type(page, 1, 12, 11);
    await expect(sheet.getByText("A game is won at 11, or by two clear after 10–all.")).toBeVisible();
    await type(page, 1, 11, 7);
    await type(page, 2, 9, 11);
    await type(page, 3, 11, 5);
    await expect(sheet.locator("[data-match-progress]")).toHaveText("2–1 · one more game");
    await type(page, 4, 11, 8);
    await expect(sheet.locator("[data-match-progress]")).toHaveText("3–1 · match complete");
    // A 44px target for every stepper, on both widths.
    const plus = await sheet.getByRole("button", { name: "Game 1, Side A points: one more" }).boundingBox();
    expect(plus?.height ?? 0).toBeGreaterThanOrEqual(44);
    await sheet.getByRole("button", { name: "Record result" }).click();

    await expect(sheet).toBeHidden();
    await expect(card).toContainText("Waiting to confirm");
    await expect(card).toContainText(/Waiting for Sam Petersen to confirm · confirms itself/);
    expect(server.state.result?.games).toEqual([{ a: 11, b: 7 }, { a: 9, b: 11 }, { a: 11, b: 5 }, { a: 11, b: 8 }]);

    // Sam, on his own phone, opens the mail's link.
    const samContext = await browser.newContext({ ...(page.viewportSize() ? { viewport: page.viewportSize()! } : {}) });
    const sam = await samContext.newPage();
    await openAs(sam, "sam", server);
    await sam.goto(`/bookings/${BOOKING}?result=confirm`);
    const confirm = sam.getByRole("dialog", { name: "Is this result right?" });
    await expect(confirm).toBeVisible();
    await expect(confirm.getByRole("table")).toContainText("Nomsa Khumalo");
    await confirm.getByRole("button", { name: "Confirm result" }).click();
    await expect(confirm).toBeHidden();
    await expect(sam.locator("[data-result-card]")).toContainText("Confirmed");
    await expect(sam.locator("[data-result-card]")).toContainText("You lost 1–3");
    expect(new URL(sam.url()).search).toBe("");
    await samContext.close();

    // Nomsa's page, re-read, agrees.
    await page.reload();
    await expect(card).toContainText("You won 3–1");
  });

  test("Sam disputes with a note, and the card says the club will look", async ({ page, browser }) => {
    const server = resultServer();
    await openAs(page, "nomsa", server);
    await page.goto(`/bookings/${BOOKING}?result=record`);
    const sheet = page.getByRole("dialog", { name: "Record the result" });
    await page.getByRole("radio", { name: "Best of 3" }).click();
    await type(page, 1, 11, 7);
    await type(page, 2, 11, 9);
    await sheet.getByRole("button", { name: "Record result" }).click();
    await expect(sheet).toBeHidden();

    const samContext = await browser.newContext();
    const sam = await samContext.newPage();
    await openAs(sam, "sam", server);
    await sam.goto(`/bookings/${BOOKING}`);
    await sam.getByRole("button", { name: "Something's wrong" }).click();
    const dialog = sam.getByRole("dialog", { name: "Is this result right?" });
    await dialog.getByLabel("What's wrong? Optional — the club sees this.").fill("It went to a third game.");
    await dialog.getByRole("button", { name: "Send to the club" }).click();
    await expect(dialog).toBeHidden();
    await expect(sam.locator("[data-result-card]")).toContainText("Disputed — the club will look at it");
    await expect(sam.locator("[data-dispute-note]")).toHaveText("It went to a third game.");
    await samContext.close();
  });
});

for (const theme of ["light", "dark"] as const) {
  test(`the card and the sheet pass axe (${theme})`, async ({ page }) => {
    const server = resultServer();
    await openAs(page, "nomsa", server, theme);
    await page.goto(`/bookings/${BOOKING}`);
    await expect(page.getByRole("button", { name: "Record the result" })).toBeVisible();
    const card = await new AxeBuilder({ page }).withTags(TAGS).include("[data-result-card]").analyze();
    expect(card.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    await page.getByRole("button", { name: "Record the result" }).click();
    await type(page, 1, 12, 11);
    const sheet = await new AxeBuilder({ page }).withTags(TAGS).include("[role=dialog]").analyze();
    expect(sheet.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(scroll, "the page scrolls sideways").toBeLessThanOrEqual(0);
  });
}
