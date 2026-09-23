import { SESSION_ANON, serveApi, test, expect } from "./fixtures";

/**
 * Joining the club: register → confirm the address → wait → sign in.
 *
 * <p>
 * <b>Why this spec exists at all.</b> The whole journey was inert in a real browser and
 * green in the unit suite. `PhotoPicker` rendered the `required` attribute on an `sr-only`
 * file input — one CSS pixel, `clip-path: inset(50%)`, and still a live candidate for the
 * browser's own constraint validation — so Chrome refused to submit the form and had nowhere
 * to draw its bubble. Measured on the running app at 375x812: <code>formValid: false</code>,
 * <code>validationMessage: "Please select a file."</code>, zero <code>role=alert</code>
 * nodes, zero console output, page unchanged. The form's own sentence was dead code because
 * <code>onSubmit</code> never fired. The unit suite had a helper that dispatched `submit` on
 * the form element directly, with a comment explaining the constraint-validation problem as
 * a jsdom quirk — so three tests passed over a screen nobody could use.
 * </p>
 *
 * <p>
 * Nothing in here can be asserted from jsdom: interactive constraint validation on a real
 * click, a real file dropped onto a real input, and what a real layout engine does with a
 * focus call. That is the whole reason it is here rather than beside `MemberAuth.test.tsx`.
 * </p>
 *
 * <p>
 * The API is answered by interception, as every spec in this suite is — see `fixtures.ts`
 * for what that buys and what it does not. The journey's SERVER half (a real row, a real
 * token, a real approval) is the xUnit suite's; what is proved here is that the four screens
 * a person walks compose, refuse honestly, and never leave them with nothing to press.
 * </p>
 */

/**
 * A real 1x1 PNG, because `PhotoPicker` decodes and re-encodes whatever it is handed
 * through a canvas. A text file named `.png` reaches `preparePhoto`, fails to decode, and
 * the spec then measures the error path instead of the happy one.
 */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const PHOTO = { name: "me.png", mimeType: "image/png", buffer: PNG_1X1 };

/** Everything the register screen may call, and nothing it may not. */
function registerRoutes(over: { registerStatus?: number; registerBody?: unknown } = {}) {
  return [
    { path: "/api/v1/session", body: SESSION_ANON },
    { method: "POST", path: "/api/v1/uploads/photo", body: { url: "/uploads/crusaders/photos/x.png" } },
    {
      method: "POST",
      path: "/api/v1/auth/register",
      status: over.registerStatus ?? 200,
      body: over.registerBody ?? { user_id: "u-1", status: "pending_email_verification" },
    },
  ];
}

async function fillTheForm(page: import("@playwright/test").Page) {
  // Addressed at review.test, never a real domain: local mail goes to a sink and a typo in a
  // spec must not cost the club sending reputation.
  await page.getByLabel("Full name").fill("Thandi Probe");
  await page.getByLabel("Email").fill("thandi.probe@review.test");
  await page.getByLabel("Membership number").fill("MEM-9001");
  await page.getByLabel("Password").fill("Review!2345");
}

test.describe("Register — the application actually goes somewhere", () => {
  test("refuses out loud when there is no photo, instead of doing nothing for ever", async ({ page }) => {
    await serveApi(page, registerRoutes());
    await page.goto("/register");
    await fillTheForm(page);

    await page.getByRole("button", { name: "Submit application" }).click();

    /*
      The guard, in the terms the defect was measured in. Before the fix this locator never
      resolved: Chrome swallowed the click and the page said nothing at all.
    */
    const alert = page.getByRole("alert");
    await expect(alert).toBeVisible({ timeout: 2_000 });
    await expect(alert).toContainText(/add a photo of yourself/i);
    // Exactly one live region. The picker used to raise its message to the page's own Alert
    // as well as rendering it, and both are role="alert".
    await expect(page.getByRole("alert")).toHaveCount(1);

    // The form itself is submittable — the file input no longer blocks it.
    await expect.poll(() => page.evaluate(() => document.querySelector("form")?.checkValidity())).toBe(true);

    // And the keyboard was taken to the field the complaint is about, which on a phone is
    // the only way the member finds it.
    const focused = await page.evaluate(() => {
      const active = document.activeElement as HTMLInputElement | null;
      return { type: active?.type ?? null, describedBy: active?.getAttribute("aria-describedby") ?? "" };
    });
    expect(focused.type).toBe("file");
    expect(focused.describedBy).toContain("-error");
  });

  test("takes a photo from the picker, sends the application, and says what happens next", async ({ page }) => {
    const posted: string[] = [];
    await serveApi(page, registerRoutes());
    // AFTER serveApi: Playwright runs the most recently registered handler first, so a capture
    // installed before the responder never sees the request at all.
    await page.route("**/api/v1/auth/register", async (route) => {
      posted.push(route.request().postData() ?? "");
      await route.fallback();
    });
    await page.goto("/register");
    await fillTheForm(page);

    // `setInputFiles` on the real input is what a phone's camera roll does: `accept="image/*"`
    // offers Photo Library as well as Take Photo, and neither goes through a label.
    await page.getByLabel("Photo of yourself").setInputFiles(PHOTO);
    await expect(page.getByText("Photo ready")).toBeVisible();

    await page.getByRole("button", { name: "Submit application" }).click();

    await expect(page.getByRole("heading", { name: "Check your inbox" })).toBeVisible();
    // Three steps, and the one fact that stops somebody registering twice: how long it takes.
    await expect(page.getByRole("listitem")).toHaveCount(3);
    await expect(page.getByText(/day or two/i)).toBeVisible();
    // Never a dead end: there is a way back to the screen they will next need.
    await expect(page.getByRole("button", { name: /Back to sign in/i })).toBeVisible();
    expect(posted.join("")).toContain("thandi.probe@review.test");
  });

  test("works from the keyboard alone, with a visible ring on the photo tile", async ({ page }) => {
    await serveApi(page, registerRoutes());
    await page.goto("/register");
    await fillTheForm(page);

    // Focus the file input the way a Tab from the password field does, then check the VISIBLE
    // control shows it. The tile used to carry `focus-within:ring-2`, which can never fire —
    // the input is the label's sibling, not its child — so the one control on the screen that
    // is not self-evidently a control had no focus indicator at all.
    await page.getByLabel("Photo of yourself").focus();
    const ring = await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('input[type="file"]');
      const tile = input?.parentElement?.querySelector("label");
      return tile ? getComputedStyle(tile).boxShadow : "none";
    });
    expect(ring).not.toBe("none");

    await page.getByLabel("Photo of yourself").setInputFiles(PHOTO);
    await expect(page.getByText("Photo ready")).toBeVisible();
    // Enter from a text field submits, which is the keyboard path a member takes.
    await page.getByLabel("Membership number").press("Enter");
    await expect(page.getByRole("heading", { name: "Check your inbox" })).toBeVisible();
  });

  test("at 320px nothing on the form runs off the side of the screen", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await serveApi(page, registerRoutes());
    await page.goto("/register");

    const overflow = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth,
      win: window.innerWidth,
      past: [...document.querySelectorAll<HTMLElement>("form *")]
        .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1)
        .map((el) => el.tagName + "." + el.className.split(" ")[0]),
    }));
    expect(overflow.past).toEqual([]);
    expect(overflow.doc).toBeLessThanOrEqual(overflow.win);
  });
});

test.describe("Confirming the address — neither settled state is a dead end", () => {
  test("a good link says what happens next and offers the way to it", async ({ page }) => {
    await serveApi(page, [
      { path: "/api/v1/session", body: SESSION_ANON },
      { method: "POST", path: "/api/v1/auth/verify-email/", body: { verified: true } },
    ]);
    await page.goto("/verify-email/good-token");

    await expect(page.getByRole("heading", { name: "Email confirmed" })).toBeVisible();
    await expect(page.getByText(/checks your membership number/i)).toBeVisible();
    await page.getByRole("button", { name: /Back to sign in/i }).click();
    await expect(page).toHaveURL(/\/login$/);
  });

  test("a spent link offers signing in first, never 'register again'", async ({ page }) => {
    await serveApi(page, [
      { path: "/api/v1/session", body: SESSION_ANON },
      { method: "POST", path: "/api/v1/auth/verify-email/", status: 400, body: { error: "invalid_or_expired" } },
    ]);
    await page.goto("/verify-email/spent-token");

    await expect(page.getByRole("heading", { name: /didn't work/i })).toBeVisible();
    /*
      The old arm said "Try registering again or contact the club admin." — and the ordinary
      way to reach this screen is opening the same email twice, at which point the address IS
      confirmed and registering again is answered `email_in_use`. The primary control is now
      the one that works.
    */
    await expect(page.getByRole("button", { name: "Go to sign in" })).toBeVisible();
    await expect(page.getByText(/already opened this one/i)).toBeVisible();
  });
});

test.describe("Waiting, and then getting in", () => {
  /** The refusal body `AuthEndpoints` sends for a pending membership, contact and all. */
  const pendingRefusal = {
    method: "POST" as const,
    path: "/api/v1/auth/login",
    status: 403,
    body: {
      error: "not_approved",
      status: "Pending",
      contact: { phone: "021 555 0134", email: "desk@review.test" },
    },
  };

  test("a pending member is told how long, and given somebody to ask", async ({ page }) => {
    await serveApi(page, [{ path: "/api/v1/session", body: SESSION_ANON }, pendingRefusal]);
    await page.goto("/login");
    await page.getByLabel("Email").fill("thandi.probe@review.test");
    await page.getByLabel("Password").fill("Review!2345");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();

    await expect(page.getByRole("alert")).toContainText(/waiting for the club to approve/i);
    await expect(page.getByRole("alert")).toContainText(/day or two/i);
    // The sentence tells them to speak to the club; these are what they speak to it with.
    await expect(page.getByRole("link", { name: "021 555 0134" })).toBeVisible();
    await expect(page.getByRole("link", { name: "desk@review.test" })).toBeVisible();
    // And nothing is offered that cannot help: confirming an address does not approve a member.
    await expect(page.getByRole("button", { name: /Resend the confirmation email/i })).toHaveCount(0);
  });

  /**
   * <b>Enter signs you in, because that is what everybody does.</b>
   *
   * <p>
   * Every other test on this screen CLICKS the button, so all of them would still pass on a
   * form that could only ever be submitted by clicking. Implicit submission is a property of
   * the form's markup rather than of its handler — a stray <code>type="button"</code> on the
   * submit control, an input moved out from under the <code>&lt;form&gt;</code>, or a hidden
   * <code>required</code> field failing constraint validation all break it while leaving the
   * button working — and this spec's own preamble is about a form that was inert in a real
   * browser for exactly that last reason.
   * </p>
   *
   * <p>
   * It has to be Playwright rather than jsdom or a screenshot harness: implicit submission is
   * driven by the browser's real key-event sequence, and a tool that dispatches keydown
   * without the rest of it reports a working form as broken. That mattered — a walkthrough of
   * the running app read this as a defect until the missing keypress explained it.
   * </p>
   */
  test("Enter in the password field signs in, not just the button", async ({ page }) => {
    await serveApi(page, [
      { path: "/api/v1/session", body: { ...SESSION_ANON, user_id: "u-1", is_authenticated: true } },
      { method: "POST", path: "/api/v1/auth/login", body: { access_token: "t", user_id: "u-1", is_admin: false } },
      { path: "/api/v1/whoami", body: { user_id: "u-1", is_admin: false, must_change_password: false } },
      { path: "/api/v1/me/profile", body: { full_name: "Thandi Probe", photo_url: null, email: "thandi.probe@review.test" } },
      { path: "/api/v1/wallet", body: { balance_credits: 0, entries: [], total_entries: 0 } },
      { path: "/api/v1/schedule", body: { days: [] } },
    ]);
    await page.goto("/login");
    await page.getByLabel("Email").fill("thandi.probe@review.test");
    // Typed into rather than filled, and Enter pressed from there, so the whole thing is the
    // key sequence a person produces — not a value assignment followed by a synthetic event.
    await page.getByLabel("Password").click();
    await page.keyboard.type("Review!2345");
    await page.keyboard.press("Enter");

    // R15 — the signed-in landing moved from /schedule to My Code.
    await expect(page).toHaveURL(/\/my-code/);
  });

  test("once approved, the same credentials land on My Code", async ({ page }) => {
    await serveApi(page, [
      { path: "/api/v1/session", body: { ...SESSION_ANON, user_id: "u-1", is_authenticated: true } },
      { method: "POST", path: "/api/v1/auth/login", body: { access_token: "t", user_id: "u-1", is_admin: false } },
      { path: "/api/v1/whoami", body: { user_id: "u-1", is_admin: false, must_change_password: false } },
      { path: "/api/v1/me/profile", body: { full_name: "Thandi Probe", photo_url: null, email: "thandi.probe@review.test" } },
      { path: "/api/v1/wallet", body: { balance_credits: 0, entries: [], total_entries: 0 } },
      { path: "/api/v1/schedule", body: { days: [] } },
    ]);
    await page.goto("/login");
    await page.getByLabel("Email").fill("thandi.probe@review.test");
    await page.getByLabel("Password").fill("Review!2345");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();

    // R15 — the signed-in landing moved from /schedule to My Code.
    await expect(page).toHaveURL(/\/my-code/);
  });
});
