import type { Page } from "@playwright/test";
import { serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { BOOKING, detailFixture, inviteFixture, memberShellRoutes } from "./playersKit";
import { INBOX_COPY, INVITES_COPY } from "../src/lib/playersCopy";
import { SPLIT_PANE_COPY } from "../src/lib/inboxCopy";
import { bigText, fontsReady, sideways } from "./layoutKit";

/**
 * R5 — Inbox and Invites open a pick beside the list by the SAME measure the split view stacks by
 * (its box, in rem), measured in Chromium at 1280:
 * - X5-3: at 200 % text the split view stacks, so a row goes to its page (a phone's flow); a pick
 *   already open when the text grew shows under a back control, and Back returns to the list.
 * - X5-10: a pick opened beside the list is announced; focus stays on the row (Up/Down walk on).
 * - X5-7: the picked row keeps an edge in forced colours.
 * Desktop project only: the widths are set here.
 */
const at = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
const NOTICES = [
  { id: "n1", kind: "players.share_moved", headline: "Sam paid you 25.00 credits", link: `/bookings/${BOOKING}`, booking_id: BOOKING, created_at: at(5), read_at: null },
  { id: "n2", kind: "players.response", headline: "Alex accepted — Court 1", link: `/bookings/${BOOKING}`, booking_id: BOOKING, created_at: at(9), read_at: null },
];

function inboxRoutes(): ApiRoute[] {
  return [
    { path: "/api/v1/me/notifications", body: { items: NOTICES, unread_count: 2, next_cursor: null, timezone: "Africa/Johannesburg" } },
    { method: "POST", path: "/api/v1/me/notifications/", respond: ({ path }) => ({ id: path.split("/").at(-2), read: true }) },
    { path: `/api/v1/bookings/${BOOKING}`, body: detailFixture() },
    ...memberShellRoutes({ unread: 2 }),
  ];
}

async function open(page: Page, path: string, routes: ApiRoute[]) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 800 });
  await signIn(page);
  await serveApi(page, routes);
  await page.goto(path);
  await fontsReady(page);
}

const splitView = (page: Page) => page.locator("[data-split-view]");

test.describe("Inbox (R5 X5-3, X5-7, X5-10)", () => {
  test.beforeEach(({}, info) => { test.skip(info.project.name !== "desktop", "1280 only"); });

  test("1280: a pick opens beside the list, is announced, and focus stays on the row with an edge forced colours keep", async ({ page }) => {
    await open(page, "/inbox", inboxRoutes());
    const list = page.getByRole("list", { name: INBOX_COPY.listLabel });
    await expect(splitView(page)).toHaveAttribute("data-split");
    const row = list.getByRole("link", { name: NOTICES[0].headline });
    await row.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/inbox\?n=n1/);
    await expect(page.locator(`[data-booking-panel="${BOOKING}"]`)).toBeVisible();
    await expect(page.locator("[data-split-said]")).toHaveText(SPLIT_PANE_COPY.showing(NOTICES[0].headline));
    await expect(row).toBeFocused();
    await expect(page.locator("[data-split-back]")).toBeHidden();
    const edge = () => row.evaluate((el) => {
      const s = getComputedStyle(el);
      return { width: s.borderLeftWidth, color: s.borderLeftColor };
    });
    expect((await edge()).width).toBe("4px");
    await page.emulateMedia({ forcedColors: "active" });
    // The mode frames a link whose class names a border (index.css) — only the picked row does.
    const forced = await edge();
    expect(Number.parseFloat(forced.width)).toBeGreaterThanOrEqual(1);
    expect(forced.color).not.toBe("rgba(0, 0, 0, 0)");
    const other = list.getByRole("link", { name: NOTICES[1].headline });
    expect(await other.evaluate((el) => getComputedStyle(el).borderLeftWidth)).toBe("0px");
    // Back from the pick returns to the bare list (the pick was pushed), still on the inbox.
    await page.goBack();
    await expect(page).toHaveURL(/\/inbox$/);
    await expect(page.getByText(INBOX_COPY.pickTitle)).toBeVisible();
  });

  test("1280 at 200 % text: the split view stacks, so a row goes to its page — and Back returns to the list", async ({ page }) => {
    await open(page, "/inbox", inboxRoutes());
    await bigText(page);
    await expect(splitView(page)).not.toHaveAttribute("data-split");
    await page.getByRole("list", { name: INBOX_COPY.listLabel }).getByRole("link", { name: NOTICES[0].headline }).click();
    await expect(page).toHaveURL(new RegExp(`/bookings/${BOOKING}$`));
    await page.goBack();
    await expect(page).toHaveURL(/\/inbox$/);
    await expect(page.getByRole("list", { name: INBOX_COPY.listLabel })).toBeVisible();
  });

  test("1280, text grown to 200 % with a pick open: the detail under a back control that returns to the list", async ({ page }) => {
    await open(page, "/inbox?n=n1", inboxRoutes());
    await expect(page.locator(`[data-booking-panel="${BOOKING}"]`)).toBeVisible();
    await bigText(page);
    await expect(splitView(page)).not.toHaveAttribute("data-split");
    await expect(page.getByRole("list", { name: INBOX_COPY.listLabel })).toBeHidden();
    const back = page.getByRole("button", { name: SPLIT_PANE_COPY.backToNotifications });
    await expect(back).toBeVisible();
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    await back.click();
    await expect(page).toHaveURL(/\/inbox$/);
    await expect(page.getByRole("list", { name: INBOX_COPY.listLabel })).toBeVisible();
  });
});

test.describe("Invites (R5 X5-3)", () => {
  test.beforeEach(({}, info) => { test.skip(info.project.name !== "desktop", "1280 only"); });
  const second = () => inviteFixture({ participant_id: "p0000000-0000-0000-0000-000000000009", court_name: "Court 2" });

  test("1280 at 200 % text: a card opens the accept sheet, never a pane the stacked view hides", async ({ page }) => {
    await open(page, "/bookings/invites", memberShellRoutes({ invites: [inviteFixture(), second()] }));
    await bigText(page);
    await expect(splitView(page)).not.toHaveAttribute("data-split");
    const cards = page.getByRole("list", { name: INVITES_COPY.listLabel }).locator("[data-invite]");
    await cards.nth(1).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page).not.toHaveURL(/seat=/);
  });

  test("1280: a picked invite is pushed — Back returns to the list with the placeholder", async ({ page }) => {
    await open(page, "/bookings/invites", memberShellRoutes({ invites: [inviteFixture(), second()] }));
    const cards = page.getByRole("list", { name: INVITES_COPY.listLabel }).locator("[data-invite]");
    await cards.nth(1).click();
    await expect(page.locator("[data-invite-detail]")).toBeVisible();
    await expect(page.locator("[data-split-said]")).not.toHaveText("");
    await page.goBack();
    await expect(page).toHaveURL(/\/bookings\/invites$/);
    await expect(page.getByText(INVITES_COPY.pickTitle)).toBeVisible();
  });
});
