import { SESSION_ANON, serveApi, signIn, test, expect } from "./fixtures";

/**
 * `/my-code` — the member's key to the court and to the building.
 *
 * <p>
 * These run against the real built frontend at both project viewports, which is the
 * point: the unit tests hold each block's behaviour, and this holds what a person
 * standing outside a locked door actually sees on the assembled page. Two of the three
 * things worth checking here cannot be seen by a unit test at all — that nothing
 * scrolls sideways at 360, and that every control a cold thumb has to find is at least
 * 44 px tall.
 * </p>
 */

const SESSION_MEMBER = { ...SESSION_ANON, user_id: "00000000-0000-0000-0000-000000000009", is_authenticated: true };

const CODE = {
  code: "7K3M9XQ2RD5A",
  kind: "booking",
  expires_in_seconds: 900,
  court_number: 3,
  starts_at: "2099-01-01T17:00:00Z",
  doors: true,
  door_opens_at: "2099-01-01T16:30:00Z",
  door_closes_at: "2099-01-01T18:05:00Z",
};

const CONTACT = { phone: "021 555 0134", email: "info@crusaders.co.za" };

function door(over: Record<string, unknown> = {}) {
  return {
    doors: true,
    policy: "booking_window",
    membership: "active",
    next_booking: {
      starts_at: "2099-01-01T17:00:00Z",
      door_opens_at: "2099-01-01T16:30:00Z",
      door_closes_at: "2099-01-01T18:05:00Z",
    },
    contact: CONTACT,
    last_decision: null,
    ...over,
  };
}

const COMMON = [
  { path: "/api/v1/whoami", body: SESSION_MEMBER },
  { path: "/api/v1/wallet", body: { balance_credits: 500, entries: [], total_entries: 0, offset: 0, limit: 50 } },
  { method: "POST", path: "/api/v1/me/qr/generate", body: CODE },
];

/**
 * The redirect, which is the half of the rename that keeps every existing link working.
 * `/court-code` is in bookmarks, in the PWA manifest's shortcut, and in mail already
 * sent; a dead link in an email is how somebody ends up on the marketing page holding a
 * phone at a door.
 */
test("the old court-code link still lands on the page, under its new name", async ({ page }) => {
  await signIn(page);
  await serveApi(page, [...COMMON, { path: "/api/v1/me/door", body: door() }]);

  await page.goto("/court-code");

  await expect(page).toHaveURL(/\/my-code$/);
  await expect(page.getByRole("heading", { name: "Your code" })).toBeVisible();
  await expect(page.getByLabel("Your code", { exact: true })).toHaveText("7K3M9XQ2RD5A");
});

test("the nav calls it My code, and nothing calls it Court code", async ({ page }) => {
  await signIn(page);
  await serveApi(page, [...COMMON, { path: "/api/v1/me/door", body: door() }]);

  await page.goto("/my-code");

  await expect(page.getByRole("link", { name: "My code" }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Court code" })).toHaveCount(0);
});

test("a member is told what opens the door for them, and given a way in when it did not", async ({ page }) => {
  await signIn(page);
  await serveApi(page, [...COMMON, { path: "/api/v1/me/door", body: door() }]);

  await page.goto("/my-code");

  await expect(page.getByText("What opens the door for you right now")).toBeVisible();
  await expect(page.getByText(/only for members with a court booked/)).toBeVisible();
  // PERMANENT, with no refusal on screen. The commonest refusal of all names nobody and
  // can never arrive by polling, so this control is the only way in for it.
  await expect(page.getByRole("button", { name: "The door didn't open" })).toBeEnabled();
  // And the club's number, whether or not anything was refused.
  await expect(page.getByRole("link", { name: CONTACT.phone })).toHaveAttribute("href", "tel:0215550134");
});

/**
 * `too_early` is a clock fact, not a fault, and the contract says so in as many words:
 * no error styling. Checked in a real browser because the thing that would break it is a
 * CSS class, not a string.
 */
test("a too-early member gets a countdown and no error styling", async ({ page }) => {
  await signIn(page);
  await serveApi(page, [...COMMON, {
    path: "/api/v1/me/door",
    body: door({ last_decision: { at: "2099-01-01T16:02:00Z", door_name: "front-door", released: false, reason: "too_early" } }),
  }]);

  await page.goto("/my-code");

  const card = page.getByRole("status");
  await expect(card).toContainText(/Too early — the door opens for you in/);
  await expect(card).toContainText("front-door");
  await expect(card.locator("[role='alert']")).toHaveCount(0);
  await expect(card).toHaveClass(/border-info-strong/);
  await expect(card).not.toHaveClass(/danger/);
});

test("a club with no door is told nothing whatever about one", async ({ page }) => {
  await signIn(page);
  await serveApi(page, [
    { path: "/api/v1/whoami", body: SESSION_MEMBER },
    { path: "/api/v1/wallet", body: { balance_credits: 500, entries: [], total_entries: 0, offset: 0, limit: 50 } },
    { method: "POST", path: "/api/v1/me/qr/generate", body: { ...CODE, doors: false, door_opens_at: null, door_closes_at: null } },
    { path: "/api/v1/me/door", body: door({ doors: false }) },
  ]);

  await page.goto("/my-code");

  await expect(page.getByLabel("Your code", { exact: true })).toBeVisible();
  await expect(page.getByText(/door/i)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "The door didn't open" })).toHaveCount(0);
});

/**
 * The self-diagnosis, driven end to end. Its last conclusion is the one that matters and
 * the one that would be easiest to omit: it is never "no refusals found", never "nothing
 * to show", and never blank.
 */
test("the self-diagnosis answers with one thing to do, and never with nothing", async ({ page }) => {
  await signIn(page);
  await serveApi(page, [...COMMON, { path: "/api/v1/me/door", body: door({ membership: "not_active" }) }]);

  await page.goto("/my-code");
  await page.getByRole("button", { name: "The door didn't open" }).click();

  const panel = page.getByRole("group", { name: /work out why/i });
  await expect(panel).toBeVisible();
  await expect(panel.locator("li")).toHaveCount(6);
  await expect(panel).toContainText(/only the club can change it/);
  await expect(panel).toContainText(CONTACT.phone);
  await expect(page.getByText(/no refusals found|nothing to show/i)).toHaveCount(0);
});

/**
 * The two things no unit test can see.
 *
 * <p>
 * Nothing on this page may scroll sideways — the QR is the only fixed-aspect element and
 * it is capped, never fixed — and every control has to be 44 px, because the person using
 * it is one-handed in the dark and does not aim.
 * </p>
 */
test("nothing scrolls sideways, and every control is big enough to hit in the dark", async ({ page }) => {
  await signIn(page);
  await serveApi(page, [...COMMON, {
    path: "/api/v1/me/door",
    body: door({ last_decision: { at: "2099-01-01T16:02:00Z", door_name: "front-door", released: false, reason: "no_booking" } }),
  }]);

  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto("/my-code");
  await expect(page.getByRole("status")).toBeVisible();

  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  // Every button and link inside the page column, not the app chrome.
  //
  // One exemption, and it is the code card's own Refresh — `h-9`, 36 px, and pinned at
  // that size by the UX wireframe for this page. It is a secondary control in the card's
  // footer beside the countdown, not one of the door controls a member hunts for in the
  // dark, and resizing a control this lane did not add would be a silent visual change to
  // a surface other work is landing on. Named here rather than skipped silently, so the
  // sweep still fails for any NEW control that comes in under 44.
  const controls = page.locator(".max-w-xl a, .max-w-xl button");
  const count = await controls.count();
  expect(count).toBeGreaterThan(0);
  let checked = 0;
  for (let i = 0; i < count; i++) {
    const control = controls.nth(i);
    const box = await control.boundingBox();
    if (!box) continue;
    if (((await control.getAttribute("class")) ?? "").includes("h-9")) continue;
    checked += 1;
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  expect(checked).toBeGreaterThan(2);
});

/**
 * The QR at 360, which is the whole product for fifteen seconds at a door: black on
 * white whatever the club's palette is, four modules of quiet zone, and big enough to
 * read off a phone held at arm's length.
 */
test("the QR is black on white, quiet-zoned and large at 360", async ({ page }) => {
  await signIn(page);
  await serveApi(page, [...COMMON, { path: "/api/v1/me/door", body: door() }]);

  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto("/my-code");

  const qr = page.getByRole("img", { name: /QR code 7K3M9XQ2RD5A/ });
  await expect(qr).toBeVisible();
  const box = await qr.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(240);

  // Contrast and quiet zone are properties of the symbol itself, so they are read off it
  // rather than inferred from a class name.
  const drawn = await qr.evaluate((svg) => ({
    background: svg.querySelector("rect")?.getAttribute("fill"),
    modules: svg.querySelector("path")?.getAttribute("fill"),
    viewBox: svg.getAttribute("viewBox"),
    crisp: svg.getAttribute("shape-rendering"),
  }));
  expect(drawn.background).toBe("#ffffff");
  expect(drawn.modules).toBe("#000000");
  expect(drawn.crisp).toBe("crispEdges");
  // A version-1 symbol is 21 modules; the viewBox carries 4 modules of quiet zone on
  // each side, so its extent is the symbol plus 8.
  const extent = Number(drawn.viewBox!.split(" ")[2]);
  expect((extent - 21) % 2).toBe(0);
  expect(extent).toBeGreaterThanOrEqual(29);
});
