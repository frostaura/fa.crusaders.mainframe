import { type Page } from "@playwright/test";
import { serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { memberShellRoutes } from "./playersKit";

/**
 * P11 — the bell and the inbox, in a real browser on a phone and a desktop: the bell carries the
 * unread count, opening an invite notice lands on that invite and drops the count, and "Mark all
 * read" clears the rest. The API is a small in-memory server so a re-read agrees with what the
 * member just did — a static count would put the old figure back on the first poll.
 */

const PID = "p0000000-0000-0000-0000-000000000003";
const INVITE_HEADLINE = "Sam asked you to play — Court 1, Wed 30 Sep, 18:00";

type Notice = { id: string; kind: string; headline: string; link: string | null; booking_id: string | null; created_at: string; read_at: string | null };

function inboxServer(options: { empty?: boolean } = {}) {
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const notices: Notice[] = options.empty ? [] : [
    { id: "n1", kind: "players.invited", headline: INVITE_HEADLINE, link: `/invites/${PID}`, booking_id: "b1", created_at: at(5), read_at: null },
    { id: "n2", kind: "players.share_moved", headline: "Alex paid their 25.00 cr share for Court 1", link: "/bookings/b1", booking_id: "b1", created_at: at(60), read_at: null },
    { id: "n3", kind: "players.reminder", headline: "Your 25.00 cr share for Friday is still open", link: null, booking_id: "b2", created_at: at(60 * 26), read_at: null },
    { id: "n4", kind: "players.game_cancelled", headline: "Cancelled — Court 2, Mon 28 Sep, 19:00", link: "/bookings/b3", booking_id: "b3", created_at: at(60 * 50), read_at: at(60 * 49) },
    { id: "n5", kind: "players.response", headline: "Jo said yes to Court 1 on Wednesday", link: "/bookings/b1", booking_id: "b1", created_at: at(60 * 75), read_at: at(60 * 70) },
  ];
  const unread = () => notices.filter((n) => n.read_at === null).length;
  const routes: ApiRoute[] = [
    { path: "/api/v1/me/notifications/unread-count", respond: () => ({ unread_count: unread() }) },
    { path: "/api/v1/me/notifications", respond: () => ({ items: notices, unread_count: unread(), next_cursor: null }) },
    {
      method: "POST",
      path: "/api/v1/me/notifications/",
      respond: ({ path }) => {
        const now = new Date().toISOString();
        if (path.endsWith("/read-all")) {
          const marked = unread();
          for (const n of notices) n.read_at ??= now;
          return { marked };
        }
        const id = path.split("/").at(-2);
        const hit = notices.find((n) => n.id === id);
        if (hit) hit.read_at ??= now;
        return { id, read: true };
      },
    },
  ];
  return { routes, unread };
}

async function open(page: Page, options: { empty?: boolean; theme?: "light" | "dark"; at?: string } = {}) {
  const server = inboxServer(options);
  await signIn(page);
  if (options.theme) {
    const theme = options.theme;
    await page.addInitScript((t) => window.localStorage.setItem("crusaders:theme", t), theme);
  }
  // Ours FIRST: of two routes with the same path, the first declared wins.
  await serveApi(page, [...server.routes, ...memberShellRoutes({ unread: 3 })]);
  await page.goto(options.at ?? "/inbox");
  return server;
}

const bell = (page: Page) => page.locator("header[data-app-header] a[data-notification-bell]");

test.describe("the bell and the inbox", () => {
  test("the bell counts, an invite opens its invite, and mark-all clears the rest", async ({ page }) => {
    await open(page, { at: "/my-code" });
    await expect(bell(page)).toHaveAccessibleName("Notifications, 3 unread");
    await expect(bell(page).locator("[data-unread-badge]")).toHaveText("3");

    await bell(page).click();
    await expect(page).toHaveURL(/\/inbox$/);
    await expect(page.getByRole("heading", { level: 1, name: "Notifications" })).toBeVisible();
    const list = page.getByRole("list", { name: "Your notifications" });
    await expect(list.getByRole("listitem")).toHaveCount(5);

    await list.getByRole("link", { name: INVITE_HEADLINE }).click();
    await expect(page).toHaveURL(new RegExp(`/invites/${PID}$`));
    await expect(bell(page)).toHaveAccessibleName("Notifications, 2 unread");

    await bell(page).click();
    await expect(page).toHaveURL(/\/inbox$/);
    await expect(list.locator("li[data-unread]")).toHaveCount(2);
    await page.getByRole("button", { name: "Mark all read" }).click();
    await expect(list.locator("li[data-unread]")).toHaveCount(0);
    await expect(bell(page)).toHaveAccessibleName("Notifications");
    await expect(bell(page).locator("[data-unread-badge]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Mark all read" })).toHaveCount(0);
  });

  test("an empty inbox says so, and the header still fits on one row", async ({ page }) => {
    await open(page, { empty: true });
    await expect(page.getByText("Nothing yet — invites, shares and game changes land here.")).toBeVisible();
    await expect(bell(page)).toHaveAccessibleName("Notifications");
    const box = (await bell(page).boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(scroll, "the page scrolls sideways").toBeLessThanOrEqual(0);
  });
});

/**
 * Screenshots for review — only when asked for (`P11_SHOTS_DIR`), and only on the desktop
 * project, which sets its own viewport per shot.
 */
test.describe("inbox screenshots", () => {
  const dir = process.env.P11_SHOTS_DIR;
  for (const theme of ["light", "dark"] as const) {
    test(`header, list and empty — ${theme}`, async ({ page }, info) => {
      test.skip(!dir || info.project.name !== "desktop", "screenshots are opt-in");
      for (const width of [375, 1440]) {
        await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
        await open(page, { theme });
        await expect(page.getByRole("list", { name: "Your notifications" })).toBeVisible();
        await page.locator("header[data-app-header]").screenshot({ path: `${dir}/header-${width}-${theme}.png` });
        await page.screenshot({ path: `${dir}/inbox-${width}-${theme}.png`, fullPage: true });
        await page.unrouteAll({ behavior: "ignoreErrors" });
        await open(page, { theme, empty: true });
        await expect(page.getByText("Nothing yet — invites, shares and game changes land here.")).toBeVisible();
        await page.screenshot({ path: `${dir}/empty-${width}-${theme}.png`, fullPage: true });
        await page.unrouteAll({ behavior: "ignoreErrors" });
      }
    });
  }
});

