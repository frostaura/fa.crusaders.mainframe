import AxeBuilder from "@axe-core/playwright";
import { type Page } from "@playwright/test";
import { SESSION_ADMIN, serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";

/**
 * Admin · Courts (`/admin/courts`, plan P6) in a real browser: the list reads, a court opens in a
 * sheet (from the right on a desktop, from the bottom on a phone), a court carries no price (P13,
 * contract §3.9 — a booking costs its minutes), and the page passes axe in both themes.
 */

const COURTS = [1, 2, 3].map((n) => ({
  id: `2222222${n}-2222-2222-2222-222222222222`, court_number: n, name: n === 3 ? "Glass court" : `Court ${n}`,
  court_type: "Squash", is_active: n !== 2,
}));

function routes(extra: ApiRoute[] = []): ApiRoute[] {
  return [
    { path: "/api/v1/whoami", body: SESSION_ADMIN },
    { path: "/api/v1/me/profile", body: { full_name: "Crusaders Admin", email: "admin@sample.local", photo_url: null, membership_number: "ADMIN-0001" } },
    { path: "/api/v1/admin/courts/", body: COURTS },
    ...extra,
  ];
}

async function openCourts(page: Page, extra: ApiRoute[] = []) {
  await signIn(page);
  await serveApi(page, routes(extra));
  await page.goto("/admin/courts");
  await expect(page.getByRole("heading", { name: "Courts", level: 1 })).toBeVisible();
  await expect(page.getByRole("region", { name: "The club’s courts" })).toBeVisible();
}

test("lists the courts and renames one in a sheet that has no price", async ({ page }) => {
  const sent: unknown[] = [];
  await openCourts(page, [{
    method: "PATCH", path: "/api/v1/admin/courts/",
    respond: (request) => { sent.push(request.body); return { saved: true }; },
  }]);

  await expect(page.getByText("2 bookable · 3 courts")).toBeVisible();
  await page.getByRole("button", { name: "Edit Glass court" }).click();
  const sheet = page.getByRole("dialog", { name: "Edit Glass court" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Close" })).toBeVisible();

  await expect(sheet.getByRole("spinbutton")).toHaveCount(0);
  await expect(sheet).not.toContainText(/price|credit|\bcr\b/i);
  await sheet.getByRole("textbox", { name: "Name" }).fill("Glass hall");
  await sheet.getByRole("button", { name: "Save court" }).click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toEqual({ name: "Glass hall" });
  await expect(sheet).toBeHidden();
});

test("adds a court with its name and type only", async ({ page }) => {
  const sent: unknown[] = [];
  await openCourts(page, [{
    method: "POST", path: "/api/v1/admin/courts/",
    respond: (request) => { sent.push(request.body); return { id: "new", court_number: 4 }; },
  }]);
  await page.getByRole("button", { name: "Add court" }).first().click();
  const sheet = page.getByRole("dialog", { name: "Add a court" });
  await sheet.getByRole("textbox", { name: "Name" }).fill("Court 4");
  await sheet.getByRole("button", { name: "Add court" }).click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toEqual({ name: "Court 4", courtType: "Squash" });
});

test("refuses a court with no name at the sheet", async ({ page }) => {
  await openCourts(page);
  await page.getByRole("button", { name: "Add court" }).first().click();
  const sheet = page.getByRole("dialog", { name: "Add a court" });
  await sheet.getByRole("button", { name: "Add court" }).click();
  await expect(sheet.getByText("Give the court a name.")).toBeVisible();
  await expect(sheet.getByRole("textbox", { name: "Name" })).toBeFocused();
});

test("keeps every row inside the screen", async ({ page }) => {
  await openCourts(page);
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(sideways).toBeLessThanOrEqual(1);
  const rows = page.getByRole("region", { name: "The club’s courts" }).getByRole("listitem");
  await expect(rows).toHaveCount(3);
  for (const row of await rows.all()) {
    const edit = row.getByRole("button", { name: /^Edit / });
    // 36 to the eye, 44 to the finger (`sm` extends its hit area) — and inside the viewport.
    const box = (await edit.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(36);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  }
});

for (const scheme of ["light", "dark"] as const) {
  test(`passes axe, list and sheet, ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await openCourts(page);
    const tags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
    const list = await new AxeBuilder({ page }).withTags(tags).include("#main-content").analyze();
    expect(list.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);

    await page.getByRole("button", { name: "Edit Court 1" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    const sheet = await new AxeBuilder({ page }).withTags(tags).include("[role=dialog]").analyze();
    expect(sheet.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  });
}
