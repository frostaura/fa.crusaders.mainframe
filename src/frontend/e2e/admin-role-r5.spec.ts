import { type Page } from "@playwright/test";
import { SESSION_ADMIN, serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { memberShellRoutes } from "./playersKit";

// A cold dev server compiles the admin frame on first ask, and the machine is shared.
test.describe.configure({ timeout: 90_000 });

/**
 * R5 lane G — Dean: "there is still no way to make a user an admin yet … that should be easy from
 * the members list too". Measured in Chromium against a stateful mocked API: a grant from the
 * row's ⋯ at desk and phone width draws the Admin badge once the server has answered; a revoke
 * sends its reason; and nothing scrolls sideways at 320 with 200 % text — the list with its
 * Admins chip, the ⋯ with a locked item's reason, and the dialog.
 */

/** The row's badge: "Admin", then its sr-only reason (" — Made an admin by the club."). */
const ADMIN_BADGE = /^Admin —/;

const ids = (i: number) => ({
  user_id: `00000000-0000-4000-8000-0000000003${String(i).padStart(2, "0")}`,
  membership_id: `00000000-0000-4000-8000-0000000004${String(i).padStart(2, "0")}`,
});

function member(i: number, name: string, admin: null | "granted" | "config", status = "Active") {
  return {
    ...ids(i), full_name: name, email: `member.${i}@role-r5.review.test`, membership_number: `MEM-20${i}`,
    status, email_verified: true, balance_minutes: 120, created_at: `2026-09-0${i}T08:00:00Z`, photo_url: null,
    is_admin: admin !== null, admin_source: admin, groups: [],
  };
}

type Club = ReturnType<typeof member>[];

/** The club as the server holds it, changed only by a POST that the server accepted. */
function club(): { members: Club; posts: unknown[]; routes: ApiRoute[] } {
  const members: Club = [
    member(1, "Bea Nkosi", null),
    member(2, "Cam Pillay", "granted"),
    member(3, "Ops Desk With A Very Long Surname-Featherstonehaugh", "config"),
    member(4, "Sal Suspended", null, "Suspended"),
  ];
  const posts: unknown[] = [];
  const routes: ApiRoute[] = [
    ...memberShellRoutes({ admin: true }),
    { path: "/api/v1/whoami", body: SESSION_ADMIN },
    { path: "/api/v1/admin/doors", body: { doors: [], shut_together: [], shut_individually: [], timezone: "Africa/Johannesburg" } },
    { path: "/api/v1/admin/monitoring/summary", body: { open: {} } },
    { path: "/api/v1/admin/play/results/disputed/count", body: { count: 0 } },
    { path: "/api/v1/admin/biometric/enrollments", body: [] },
    { path: "/api/v1/admin/members/", respond: () => members },
    {
      method: "POST", path: "/api/v1/admin/members/",
      respond: ({ path, body }) => {
        const userId = path.split("/")[5];
        const row = members.find((m) => m.user_id === userId)!;
        const { grant } = body as { grant: boolean };
        posts.push({ userId, ...(body as object) });
        row.is_admin = grant;
        row.admin_source = grant ? "granted" : null;
        return { user_id: userId, is_admin: grant, admin_source: row.admin_source, changed: true };
      },
    },
  ];
  return { members, posts, routes };
}

async function open(page: Page, width: number, routes: ApiRoute[], bigText = false) {
  await page.setViewportSize({ width, height: 900 });
  await signIn(page);
  await serveApi(page, routes);
  await page.goto("/admin/members");
  if (bigText) await page.addStyleTag({ content: "html { font-size: 32px; }" });
  await expect(page.locator("tr[data-member-row]").first()).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
}

const row = (page: Page, i: number) => page.locator(`tr[data-member-row="${ids(i).user_id}"]`);

async function chooseRole(page: Page, i: number, label: string) {
  await row(page, i).locator("[data-member-menu]").click();
  await page.getByRole("menuitem", { name: label, exact: true }).click();
  return page.getByRole("dialog");
}

/** Sideways scroll on the document or the app's scroller, and the widest thing past the viewport. */
async function sideways(page: Page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const main = document.getElementById("main-content");
    const scroll = Math.max(...[document.documentElement, main].filter(Boolean).map((el) => el!.scrollWidth - el!.clientWidth));
    const past = [...document.querySelectorAll("[role='menu'], [role='dialog'], [role='menuitem'], [role='radio']")]
      .map((el) => ({ text: (el.textContent ?? "").slice(0, 30), right: Math.round(el.getBoundingClientRect().right) }))
      .filter((r) => r.right > vw + 1);
    return { scroll, past };
  });
}

for (const width of [1280, 390]) {
  test.describe(`R5 G — the admin role from the members list at ${width}`, () => {
    test("grants from the row's ⋯, and the Admin badge appears once the server has answered", async ({ page }) => {
      const { posts, routes } = club();
      await open(page, width, routes);
      await expect(row(page, 1).getByText(ADMIN_BADGE)).toHaveCount(0);

      const dialog = await chooseRole(page, 1, "Make administrator");
      await expect(dialog).toContainText("Make Bea Nkosi an administrator?");
      await dialog.getByRole("textbox", { name: "Reason" }).fill("Joined the committee as treasurer");
      await dialog.getByRole("button", { name: "Make administrator" }).click();

      await expect(dialog).toBeHidden();
      await expect(row(page, 1).getByText(ADMIN_BADGE)).toBeVisible();
      expect(posts).toEqual([{ userId: ids(1).user_id, grant: true, reason: "Joined the committee as treasurer" }]);
    });

    test("revokes with a reason, and the badge goes", async ({ page }) => {
      const { posts, routes } = club();
      await open(page, width, routes);
      await expect(row(page, 2).getByText(ADMIN_BADGE)).toBeVisible();

      const dialog = await chooseRole(page, 2, "Remove admin rights");
      await dialog.getByRole("button", { name: "Remove admin rights" }).click();
      // No reason, nothing sent: the press names what is missing.
      await expect(dialog.getByRole("textbox", { name: "Reason" })).toBeFocused();
      expect(posts).toEqual([]);
      await dialog.getByRole("textbox", { name: "Reason" }).fill("Stepped down");
      await dialog.getByRole("button", { name: "Remove admin rights" }).click();

      await expect(dialog).toBeHidden();
      await expect(row(page, 2).getByText(ADMIN_BADGE)).toHaveCount(0);
      expect(posts).toEqual([{ userId: ids(2).user_id, grant: false, reason: "Stepped down" }]);
    });
  });
}

test.describe("R5 G — 320 px at 200 % text", () => {
  test("the list with its Admins chip, a locked item's reason and the dialog scroll nothing sideways", async ({ page }) => {
    const { routes } = club();
    await open(page, 320, routes, true);
    let o = await sideways(page);
    expect(o.scroll, "the list scrolls sideways").toBeLessThanOrEqual(1);
    expect(o.past, "chips past the edge").toEqual([]);

    await page.getByRole("radio", { name: /Admins/ }).click();
    await expect(page.locator("tr[data-member-row]")).toHaveCount(2);

    await row(page, 3).locator("[data-member-menu]").click();
    const locked = page.getByRole("menuitem", { name: /Remove admin rights/ });
    await expect(locked).toHaveAttribute("aria-disabled", "true");
    await expect(locked).toContainText("Set in the server's configuration");
    o = await sideways(page);
    expect(o.scroll, "the open menu scrolls sideways").toBeLessThanOrEqual(1);
    expect(o.past, "the menu past the edge").toEqual([]);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);

    const dialog = await chooseRole(page, 2, "Remove admin rights");
    await expect(dialog).toBeVisible();
    o = await sideways(page);
    expect(o.scroll, "the dialog scrolls sideways").toBeLessThanOrEqual(1);
    expect(o.past, "the dialog past the edge").toEqual([]);
  });
});
