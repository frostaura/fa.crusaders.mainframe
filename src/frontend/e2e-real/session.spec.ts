import { expect, request as playwrightRequest, test, type APIRequestContext, type Cookie, type Page } from "@playwright/test";
import { TOKEN_KEY, approveMember, devAdminSession, whoami } from "./support/api";
import { avatarFile, uniqueEmail, uniqueMembershipNumber, walkFullName, walkPassword } from "./support/ids";
import { verificationLink } from "./support/mailhog";
import { INBOX_HEADING, VERIFY_OK_HEADING } from "../src/lib/registrationCopy";

/**
 * The session outlives the 15-minute access token (review round 1, B1 / F4.1), proven through
 * whatever serves the app — the nginx gateway by default, the Vite dev proxy with
 * `E2E_REAL_BASE_URL=http://localhost:4173`. Each proxy must pass `Set-Cookie` through untouched,
 * and nothing but a real browser signing in through `/login` shows that it does.
 *
 * <p>
 * What it holds: the sign-in sets `crusaders_rt` httpOnly, `SameSite=Strict`, on
 * `/api/v1/auth` and — the stack runs as Development — not `Secure`; a refresh carrying ONLY the
 * cookie mints a token and rotates it; the spent cookie presented again at once is
 * `401 refresh_superseded` (the two-tabs grace) with no `Set-Cookie`; a page whose stored token
 * is dead is rescued by the cookie instead of being sent to `/login`; and after sign-out the
 * cookie is `401 session_ended`.
 * </p>
 */

const REFRESH = "/api/v1/auth/refresh";

async function storedToken(page: Page): Promise<string | null> {
  return page.evaluate((key) => window.localStorage.getItem(key), TOKEN_KEY);
}

/** A request context that carries exactly this cookie and no bearer. */
async function cookieOnly(baseURL: string, value: string): Promise<APIRequestContext> {
  return playwrightRequest.newContext({ baseURL, extraHTTPHeaders: { cookie: `crusaders_rt=${value}` } });
}

function refreshCookie(cookies: Cookie[]): Cookie | undefined {
  return cookies.find((c) => c.name === "crusaders_rt");
}

test("a password sign-in sets the refresh cookie, and the cookie alone keeps the session", async ({ page, request, baseURL }) => {
  const base = baseURL ?? "http://localhost:8088";
  const email = uniqueEmail("session");
  const password = walkPassword();

  await test.step("a member registers, confirms and is approved", async () => {
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
    await page.goto(await verificationLink(email, base));
    await expect(page.getByRole("heading", { name: VERIFY_OK_HEADING })).toBeVisible();
    await approveMember(request, await devAdminSession(request), email);
  });

  let first: Cookie | undefined;
  await test.step("signing in through /login sets crusaders_rt as the contract says", async () => {
    await page.goto("/login");
    await page.getByLabel(/^email/i).fill(email);
    await page.getByLabel(/^password/i).fill(password);
    await page.getByRole("button", { name: /^sign in$/i }).click();
    await expect(page).not.toHaveURL(/\/login/);
    await expect.poll(() => storedToken(page)).not.toBeNull();

    first = refreshCookie(await page.context().cookies());
    expect(first, "the sign-in answer's Set-Cookie reached the browser").toBeDefined();
    expect(first).toMatchObject({ path: "/api/v1/auth", httpOnly: true, sameSite: "Strict", secure: false });
    expect(first!.expires).toBeGreaterThan(Date.now() / 1000 + 29 * 24 * 3600);
  });

  let rotated = "";
  await test.step("the cookie alone, with no bearer, is traded for a token and rotated", async () => {
    const ctx = await cookieOnly(base, first!.value);
    const res = await ctx.post(REFRESH);
    expect(res.status(), await res.text()).toBe(200);
    const body = (await res.json()) as { access_token?: string };
    expect(typeof body.access_token).toBe("string");
    expect((await whoami(request, { accessToken: body.access_token!, userId: "", isAdmin: false })).is_authenticated).toBe(true);
    const setCookie = res.headersArray().filter((h) => h.name.toLowerCase() === "set-cookie").map((h) => h.value).join("\n");
    const next = /crusaders_rt=([^;]+)/.exec(setCookie)?.[1];
    expect(next, "a rotated cookie came back through the proxy").toBeTruthy();
    expect(next).not.toBe(first!.value);
    rotated = next!;

    // The spent cookie again, inside the grace: superseded, nothing revoked, nothing cleared.
    const again = await ctx.post(REFRESH);
    expect(again.status()).toBe(401);
    expect(await again.json()).toMatchObject({ error: "refresh_superseded" });
    expect(again.headersArray().some((h) => h.name.toLowerCase() === "set-cookie")).toBe(false);
    await ctx.dispose();
  });

  await test.step("a page whose stored token is dead is rescued by the cookie, not sent to /login", async () => {
    // The browser still holds the FIRST cookie, which the step above spent; give it the successor.
    await page.context().addCookies([{ ...first!, value: rotated }]);
    await page.evaluate((key) => window.localStorage.setItem(key, "dead.token.value"), TOKEN_KEY);
    await page.goto("/wallet");
    await expect.poll(() => storedToken(page), { timeout: 15_000 }).not.toBe("dead.token.value");
    await expect(page).toHaveURL(/\/wallet/);
    expect(await storedToken(page)).not.toBeNull();
  });

  await test.step("after sign-out the cookie ends the session", async () => {
    const live = refreshCookie(await page.context().cookies());
    const token = await storedToken(page);
    const out = await page.request.post("/api/v1/auth/logout", { headers: { authorization: `Bearer ${token}` } });
    expect(out.ok(), await out.text()).toBe(true);
    const ctx = await cookieOnly(base, live!.value);
    const res = await ctx.post(REFRESH);
    expect(res.status()).toBe(401);
    expect(await res.json()).toMatchObject({ error: "session_ended" });
    await ctx.dispose();
  });
});
