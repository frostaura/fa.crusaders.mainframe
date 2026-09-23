import AxeBuilder from "@axe-core/playwright";
import { type Page } from "@playwright/test";
import { SESSION_ADMIN, serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";

/**
 * Admin · Courts (`/admin/courts`, plan P6) in a real browser: the list reads, a court opens in a
 * sheet (from the right on a desktop, from the bottom on a phone), prices are credits, and the page
 * passes axe in both themes.
 */

const COURTS = [1, 2, 3].map((n) => ({
  id: `2222222${n}-2222-2222-2222-222222222222`, court_number: n, name: n === 3 ? "Glass court" : `Court ${n}`,
  court_type: "Squash", slice_price_credits: n === 3 ? 12.5 : 8, is_active: n !== 2,
}));

function routes(extra: ApiRoute[] = []): ApiRoute[] {
  return [
    { path: "/api/v1/whoami", body: SESSION_ADMIN },
    { path: "/api/v1/me/profile", body: { full_name: "Crusaders Admin", email: "admin@sample.local", photo_url: null, membership_number: "ADMIN-0001", member_class: "Regular" } },
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

test("lists the courts and edits one in a sheet, in credits", async ({ page }) => {
  const sent: unknown[] = [];
  await openCourts(page, [{
    method: "PATCH", path: "/api/v1/admin/courts/",
    respond: (request) => { sent.push(request.body); return { saved: true }; },
  }]);

  await expect(page.getByText("2 in use · 3 courts")).toBeVisible();
  await page.getByRole("button", { name: "Edit Glass court" }).click();
  const sheet = page.getByRole("dialog", { name: "Edit Glass court" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Close" })).toBeVisible();

  const price = sheet.getByRole("spinbutton", { name: "Price per slice (credits)" });
  await expect(price).toHaveValue("12.5");
  await price.fill("14");
  await sheet.getByRole("button", { name: "Save court" }).click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toEqual({ slicePriceCredits: 14 });
  await expect(sheet).toBeHidden();
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
