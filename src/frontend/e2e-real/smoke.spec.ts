import { expect, test, type Page } from "@playwright/test";
import { INBOX_HEADING, VERIFY_OK_HEADING } from "../src/lib/registrationCopy";
import { TOKEN_KEY, approveMember, devAdminSession, findMember, useSession, whoami } from "./support/api";
import { avatarFile, uniqueEmail, uniqueMembershipNumber, walkFullName, walkPassword } from "./support/ids";
import { verificationLink } from "./support/mailhog";

/**
 * The smallest proof that the real stack works end to end: an admin can get in, and a stranger
 * can become a member — register, confirm by email, be approved, sign in.
 *
 * <p>
 * Selectors are roles and labels matched by regex, and copy comes from the app's own copy
 * modules, because every screen here is about to be redesigned. What must not change is the
 * journey, and that is all this asserts.
 * </p>
 */

async function storedToken(page: Page): Promise<string | null> {
  return page.evaluate((key) => window.localStorage.getItem(key), TOKEN_KEY);
}

test("the seeded admin signs in through the dev path and reaches the members console", async ({ page, request }) => {
  const admin = await devAdminSession(request);
  expect(admin.isAdmin).toBe(true);

  await useSession(page, admin);
  await page.goto("/admin/members");

  await expect(page).toHaveURL(/\/admin\/members/);
  await expect(page.getByRole("heading", { name: /members/i }).first()).toBeVisible();
  await expect(page.getByLabel(/^password$/i)).toHaveCount(0);

  const me = await whoami(request, admin);
  expect(me).toMatchObject({ is_authenticated: true, is_admin: true, user_id: admin.userId });
});

test("a new member registers, confirms by email, is approved, and signs in", async ({ page, request, baseURL }) => {
  const email = uniqueEmail();
  const password = walkPassword();

  await test.step("apply through the real register form", async () => {
    await page.goto("/register");
    await page.getByLabel(/full name/i).fill(walkFullName());
    await page.getByLabel(/^email/i).fill(email);
    await page.getByLabel(/membership number/i).fill(uniqueMembershipNumber());
    await page.getByLabel(/^password/i).fill(password);
    await page.locator('input[type="file"]').first().setInputFiles(avatarFile());
    const submit = page.getByRole("button", { name: /submit|apply|join/i });
    await expect(submit).toBeEnabled();
    await expect(submit).not.toHaveText(/preparing/i);
    await submit.click();
    await expect(page.getByRole("heading", { name: INBOX_HEADING })).toBeVisible();
  });

  await test.step("open the confirmation link from MailHog", async () => {
    const link = await verificationLink(email, baseURL ?? "http://localhost:8088");
    await page.goto(link);
    await expect(page.getByRole("heading", { name: VERIFY_OK_HEADING })).toBeVisible();
  });

  await test.step("the admin approves the application", async () => {
    const admin = await devAdminSession(request);
    const pending = await findMember(request, admin, email);
    expect(pending?.status).toMatch(/pending/i);
    await approveMember(request, admin, email);
    expect((await findMember(request, admin, email))?.status).toMatch(/active/i);
  });

  await test.step("the member signs in with their password", async () => {
    await page.goto("/login");
    await page.getByLabel(/^email/i).fill(email);
    await page.getByLabel(/^password/i).fill(password);
    await page.getByRole("button", { name: /^sign in$/i }).click();

    await expect(page).not.toHaveURL(/\/login/);
    await expect.poll(() => storedToken(page)).not.toBeNull();
    const token = (await storedToken(page)) as string;
    const me = await whoami(request, { accessToken: token, userId: "", isAdmin: false });
    expect(me).toMatchObject({ is_authenticated: true, is_admin: false });
    expect(me.user_id).toBe((await findMember(request, await devAdminSession(request), email))?.user_id);
  });
});
