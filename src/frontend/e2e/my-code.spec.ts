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

/**
 * `GET /api/v1/me/door`, with every key `MeDoorEndpoints.DoorAsync` returns.
 *
 * <p>
 * Spelled out in full rather than trimmed to what a test reads, because a stub narrower
 * than the API is how this page came to be built against one that was. Every value here
 * is the endpoint's own default: `gate_early_entry_minutes` at 30,
 * `DeviceGateRosterBuilder.GateRosterMaxEntries` at 48, `DoorSettings`' 90-day retention.
 * </p>
 */
function door(over: Record<string, unknown> = {}) {
  return {
    doors: true,
    policy: "booking_window",
    membership: "active",
    membership_detail: "active",
    is_club_admin: false,
    next_booking: {
      starts_at: "2099-01-01T17:00:00Z",
      ends_at: "2099-01-01T17:45:00Z",
      court_number: 3,
      door_opens_at: "2099-01-01T16:30:00Z",
      door_closes_at: "2099-01-01T18:05:00Z",
    },
    early_entry_minutes: 30,
    roster_max_entries: 48,
    contact: CONTACT,
    door_log_retention_days: 90,
    last_decision: null,
    ...over,
  };
}

/**
 * One decision, with every field WIRE-R1 §2 and §8 put on it.
 *
 * <p>
 * `delivered_at` is null by default and non-null EXACTLY when `offline` is true: `at` is
 * the instant the code was held up, and a delivery instant exists only for a door that had
 * lost the network and told the club later. A fixture carrying one on an online row
 * describes a journey the endpoint cannot produce.
 * </p>
 */
function decision(over: Record<string, unknown> = {}) {
  return {
    at: "2099-01-01T16:02:00Z",
    delivered_at: null,
    door_name: "front-door",
    released: false,
    reason: "too_early",
    offline: false,
    opens_at: null,
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
    // The shape the endpoint really sends for this refusal: `opens_at` on the decision
    // and NO `next_booking`, because `too_early` means the booking's window has not
    // opened and that is exactly when `NextBookingAsync` returns null. Before the
    // decision carried its own instant, the commonest too-early card had no countdown.
    body: door({
      next_booking: null,
      last_decision: decision({ opens_at: "2099-01-01T16:30:00Z" }),
    }),
  }]);

  await page.goto("/my-code");

  const card = page.getByRole("status");
  await expect(card).toContainText(/Too early — the door opens for you in \d/);
  await expect(card).toContainText("front-door");
  await expect(card.locator("[role='alert']")).toHaveCount(0);
  await expect(card).toHaveClass(/border-info-strong/);
  await expect(card).not.toHaveClass(/danger/);
});

/**
 * §6.1's second `ok` arm, in a real browser because what distinguishes it is a sentence
 * rather than a class — and because a success chrome around a sentence about an outage is
 * the pairing worth seeing assembled.
 */
test("an open the door decided alone says so, and still says the lock released", async ({ page }) => {
  await signIn(page);
  await serveApi(page, [...COMMON, {
    path: "/api/v1/me/door",
    body: door({
      last_decision: decision({
        reason: "ok", released: true, offline: true, delivered_at: "2099-01-01T16:11:00Z",
      }),
    }),
  }]);

  await page.goto("/my-code");

  const card = page.getByRole("status");
  await expect(card).toContainText(/from the door's own list/);
  // WIRE-R1 §2: both instants on screen, because the gap between them is why the club's
  // own screens showed nothing while this member was being let in.
  await expect(card).toContainText(/the club heard at \d{2}:\d{2}/);
  await expect(card).toContainText(/couldn't reach the club/);
  await expect(card).toHaveClass(/border-success-strong/);
  // A1.2, which outranks the UX spec's own literal wording for this arm.
  await expect(card).not.toContainText(/door opened|let you in|walked in/);
});

/**
 * §6.2 row 7. `GateAccess` lets a club admin past the booking check under
 * `booking_window`, and the page used to send its own club's admins to book a court.
 */
test("a club admin is told a door opens without a booking, and what a cut-off door holds", async ({ page }) => {
  await signIn(page);
  await serveApi(page, [...COMMON, {
    path: "/api/v1/me/door",
    body: door({ is_club_admin: true, next_booking: null }),
  }]);

  await page.goto("/my-code");

  const line = page.getByText(/You're a club admin/);
  await expect(line).toBeVisible();
  await expect(line).toContainText(/without one/);
  await expect(line).toContainText(/bookings, not admins/);
  await expect(page.getByRole("link", { name: "Book a court" })).toHaveCount(0);
});

/**
 * The club's own numbers, both of them, on the assembled page: the early-entry window in
 * the standing line, and the roster cap inside the offline disclosure. Neither may be a
 * constant this page holds — one is a tenant setting and the other belongs to the
 * firmware — and a `<details>` that never opens is exactly the place a wrong number
 * survives a code review.
 */
test("the page names the club's own numbers rather than its own constants", async ({ page }) => {
  await signIn(page);
  await serveApi(page, [...COMMON, {
    path: "/api/v1/me/door",
    body: door({ next_booking: null, early_entry_minutes: 45, roster_max_entries: 12 }),
  }]);

  await page.goto("/my-code");

  await expect(page.getByText(/nothing booked in the next 45 minutes/)).toBeVisible();

  await page.getByText("What if the door is offline?").click();
  const half = page.getByText(/decides from a list of bookings/);
  await expect(half).toContainText("next 12 bookings");
  await expect(half).not.toContainText("48");
});

/**
 * §6.2 row 3. Three not-actives, three different things for a person outside a building
 * to do next — and the page used to say the same sentence to all three.
 */
for (const [detail, word] of [
  ["pending_approval", "not yet approved"],
  ["suspended", "suspended"],
  ["rejected", "turned down"],
] as const) {
  test(`a member the club has as ${detail} is told which not-active that is`, async ({ page }) => {
    await signIn(page);
    await serveApi(page, [...COMMON, {
      path: "/api/v1/me/door",
      body: door({ membership: "not_active", membership_detail: detail }),
    }]);

    await page.goto("/my-code");

    await expect(page.getByText(new RegExp(`The club has yours as ${word},`))).toBeVisible();
    await expect(page.getByText(/The club has yours as not active,/)).toHaveCount(0);
  });
}

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
  await serveApi(page, [...COMMON, { path: "/api/v1/me/door", body: door({ membership: "not_active", membership_detail: "suspended" }) }]);

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
    body: door({ next_booking: null, last_decision: decision({ reason: "no_booking" }) }),
  }]);

  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto("/my-code");
  // Waited on by its own SENTENCE, not by `role="status"`: the boot splash carries that
  // role too while the session is being confirmed, so under load the assertion passed
  // over a page that had not rendered and the sweep then found no controls at all.
  await expect(page.getByText("The door needs a court booked.").first()).toBeVisible();

  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  // Every button and link inside the page column, not the app chrome.
  //
  // <b>There used to be one exemption and there is none now.</b> The code card's Refresh
  // was `h-9`, 36 px, pinned at that size by the UX wireframe and named here so the sweep
  // would still fail for anything NEW that came in under 44. Round 1's member reviewer
  // found it anyway, one-handed in the dark, which is the answer to the wireframe: the
  // whole argument for 44 px on this page is a person who does not aim, and a control that
  // is the exception is the one they were reaching for.
  const controls = page.locator(".max-w-xl a, .max-w-xl button");
  const count = await controls.count();
  expect(count).toBeGreaterThan(0);
  let checked = 0;
  for (let i = 0; i < count; i++) {
    const box = await controls.nth(i).boundingBox();
    if (!box) continue;
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

// --- round 1 fixes, proved in a real browser ------------------------------------------
//
// Every check below is one a unit test cannot make. Four of the five member findings that
// reached a person were geometry or history, and jsdom computes neither.

/**
 * D6. `max-w-xs` is 20 REM, and a rem is whatever the reader has set. At a root font of
 * 32px it resolved to 640px inside a 360px phone: the symbol ran off both edges, the
 * twelve-character fallback ran off with it, and the whole page scrolled sideways —
 * measured by the reviewer at 490px of code text on a 360px screen.
 *
 * <p>
 * The root font is turned up on the DOCUMENT rather than by zooming, because that is what
 * a person with low vision actually does and it is the setting `rem` follows. A page that
 * survives browser zoom can still break here.
 * </p>
 */
test("the code and the QR stay on the glass at a root font of 32px", async ({ page }) => {
  await signIn(page);
  await serveApi(page, [...COMMON, { path: "/api/v1/me/door", body: door() }]);

  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto("/my-code");
  await expect(page.getByLabel("Your code", { exact: true })).toBeVisible();
  await page.addStyleTag({ content: "html { font-size: 32px !important; }" });
  // A frame for the new sizes to settle before anything is measured.
  await page.waitForTimeout(150);

  const viewport = page.viewportSize()!.width;
  for (const target of [
    page.getByRole("img", { name: /QR code/ }),
    page.getByLabel("Your code", { exact: true }),
  ]) {
    const box = (await target.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(-1);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport + 1);
  }

  // And the page COLUMN, which is this lane's half of the finding.
  //
  // Not the document. At a root font of 32px the document still scrolls sideways by about
  // sixty pixels, and every element responsible is app chrome: the wallet chip and gear
  // cluster in the header, and the nav tab strip under it. That is the same overflow
  // reviewers A and C found at 200% zoom (A10 / C14), it belongs to `components/Layout.tsx`,
  // and a sibling lane owns it. Asserting on the document here would make this spec fail
  // for their defect and pass for mine — or, worse, tempt this lane into editing a shared
  // component two people are landing on.
  const bodyOverflow = await page.evaluate(() => {
    const column = document.querySelector(".max-w-xl");
    if (!column) return Number.NaN;
    const widest = [...column.querySelectorAll("*")]
      .reduce((max, el) => Math.max(max, el.getBoundingClientRect().right), 0);
    return Math.round(widest - document.documentElement.clientWidth);
  });
  expect(bodyOverflow).toBeLessThanOrEqual(1);
});

/**
 * D10. `min(92vw, 92vh)` in landscape is a square as tall as the viewport with a code line
 * and a Done button still to place under it, so a `justify-center` column overflowed at
 * BOTH ends: the symbol's top quiet zone went off the top of the glass (measured at −15px)
 * and Done went off the bottom as a 22px sliver of a 44px control. The app header showed
 * through the top edge as well.
 */
for (const [name, size] of [
  ["portrait", { width: 360, height: 780 }],
  ["landscape", { width: 780, height: 360 }],
] as const) {
  test(`the full-screen code fills the screen and keeps Done reachable in ${name}`, async ({ page }) => {
    await signIn(page);
    await serveApi(page, [...COMMON, { path: "/api/v1/me/door", body: door() }]);

    await page.setViewportSize(size);
    await page.goto("/my-code");
    await page.getByRole("button", { name: "Show your code full screen" }).click();

    const dialog = page.getByRole("dialog", { name: /full screen/i });
    await expect(dialog).toBeVisible();

    // Nothing of the app shows through: the overlay covers the viewport and sits above
    // the sticky header, and the topmost element at the header's own coordinates is the
    // overlay rather than the club's name.
    const covers = await page.evaluate(() => {
      const top = document.elementFromPoint(20, 20);
      return !!top?.closest('[role="dialog"]');
    });
    expect(covers).toBe(true);

    // The symbol, whole, with its quiet zone inside the glass on every side.
    const qr = (await dialog.getByRole("img", { name: /QR code/ }).boundingBox())!;
    expect(qr.y).toBeGreaterThanOrEqual(0);
    expect(qr.x).toBeGreaterThanOrEqual(0);
    expect(qr.y + qr.height).toBeLessThanOrEqual(size.height + 1);
    expect(qr.x + qr.width).toBeLessThanOrEqual(size.width + 1);

    // And bigger than the inline one, which is the only reason to open it.
    expect(Math.min(qr.width, qr.height)).toBeGreaterThan(200);

    const done = dialog.getByRole("button", { name: "Done" });
    const doneBox = (await done.boundingBox())!;
    expect(doneBox.height).toBeGreaterThanOrEqual(44);
    expect(doneBox.y + doneBox.height).toBeLessThanOrEqual(size.height + 1);
    // Reachable means pressable: nothing is over it, and it closes the overlay.
    await done.click();
    await expect(dialog).toBeHidden();
  });
}

/**
 * D11. Back is the close gesture on a phone, and pressing it left the page entirely — a
 * member holding a code up at a door landed on the schedule. The router-level test beside
 * `FullScreenQr.tsx` holds the history mechanics; this holds what a thumb does.
 */
test("the hardware back button closes the full-screen code without leaving the page", async ({ page }) => {
  await signIn(page);
  await serveApi(page, [...COMMON, { path: "/api/v1/me/door", body: door() }]);

  await page.goto("/my-code");
  await page.getByRole("button", { name: "Show your code full screen" }).click();
  await expect(page.getByRole("dialog", { name: /full screen/i })).toBeVisible();

  await page.goBack();

  await expect(page.getByRole("dialog", { name: /full screen/i })).toBeHidden();
  await expect(page).toHaveURL(/\/my-code$/);
  await expect(page.getByLabel("Your code", { exact: true })).toBeVisible();
});

/**
 * And the other half: closing by tap unwinds the entry, so back still means back. Without
 * this, every open leaves a dead step and a member who opened the code three times has to
 * press back three times to leave the page.
 */
test("closing the code by tapping Done leaves the back button meaning back", async ({ page }) => {
  await signIn(page);
  await serveApi(page, [...COMMON, { path: "/api/v1/me/door", body: door() }]);

  await page.goto("/schedule").catch(() => { /* the landing route is stubbed elsewhere */ });
  await page.goto("/my-code");
  await page.getByRole("button", { name: "Show your code full screen" }).click();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("dialog", { name: /full screen/i })).toBeHidden();

  await page.goBack();
  await expect(page).not.toHaveURL(/\/my-code$/);
});

/**
 * D1/D2. The screenshot that opened the finding: `/me/door` never landed, and the page
 * told a member standing outside a locked building that their club has given the app no
 * number — then told them to fix it under Admin settings, which is not a screen a member
 * has. Both failures, because the page used to describe them identically.
 */
for (const [name, failure] of [
  ["never answers", { abort: true }],
  ["answers with an error", { status: 500, body: { error: "boom" } }],
] as const) {
  test(`a /me/door that ${name} never claims the club has no number`, async ({ page }) => {
    await signIn(page);
    await serveApi(page, COMMON);
    // Declared after `serveApi` so it wins: the fixture's own handler is strict and would
    // otherwise fail the test for an unstubbed call.
    await page.route("**/api/v1/me/door", (route) => (
      "abort" in failure ? route.abort("failed") : route.fulfill({
        status: failure.status,
        contentType: "application/json",
        body: JSON.stringify(failure.body),
      })
    ));

    await page.goto("/my-code");
    await expect(page.getByLabel("Your code", { exact: true })).toBeVisible();

    await expect(page.getByText(/Couldn't load the club's number/)).toBeVisible();
    await expect(page.getByText(/hasn't given the app a number/)).toHaveCount(0);
    await expect(page.getByText(/Admin settings/i)).toHaveCount(0);
  });
}

/**
 * D2's other half, on the assembled page: the self-check scored the phone's own line ✗
 * Failed over an HTTP 500 the club's API had answered with, in front of somebody whose
 * phone had just carried the request there and back.
 */
test("a club system that answers with an error does not fail the phone's own row", async ({ page }) => {
  await signIn(page);
  await serveApi(page, COMMON);
  await page.route("**/api/v1/me/door", (route) => route.fulfill({
    status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }),
  }));

  await page.goto("/my-code");
  await expect(page.getByLabel("Your code", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "The door didn't open" }).click();

  const panel = page.getByRole("group", { name: /work out why/i });
  await expect(panel).toContainText(/answered with an error/);
  await expect(panel).toContainText(/not your phone/);
  await expect(page.getByText("Your phone can't reach the club")).toHaveCount(0);
});

/**
 * D3. Kayla, who has no membership row at all, scored six green ticks — "an active
 * membership ✓ Passed" for a rule she is not held to, beside "nothing on file ✓ Passed".
 * The glyph is what a person reads, so the glyph is what is counted here.
 */
test("a member with no membership on file is shown no tick for one", async ({ page }) => {
  await signIn(page);
  await serveApi(page, [...COMMON, {
    path: "/api/v1/me/door",
    body: door({ policy: "active_member", membership: "none", membership_detail: "none", next_booking: null }),
  }]);

  await page.goto("/my-code");
  await expect(page.getByLabel("Your code", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "The door didn't open" }).click();

  const panel = page.getByRole("group", { name: /work out why/i });
  await expect(panel).toBeVisible();
  const ticks = await panel.locator("li", { hasText: /./ }).evaluateAll((rows) =>
    rows.filter((row) => row.textContent?.includes("✓")).length);
  // Her code and her signal, and nothing else. A rule is not a check she passed.
  expect(ticks).toBeLessThanOrEqual(2);
  await expect(panel).toContainText("Unusual — tell the club");
  await expect(panel).toContainText(/no membership on file/);
});

/**
 * D13/D14, on the assembled page: the escape hatch a member has to be able to find, and
 * the record that was three steps away from the screen where the question gets asked.
 */
test("the walk-up switch is a target, and the member's own record is one tap away", async ({ page }) => {
  await signIn(page);
  await serveApi(page, [...COMMON, { path: "/api/v1/me/door", body: door() }]);

  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto("/my-code");

  const label = page.locator('label[for="walk-up"]');
  // 16px was the finding — a quarter the height of everything else on the page, on the one
  // control a member reaches for when the code on screen is the wrong one.
  expect((await label.boundingBox())!.height).toBeGreaterThanOrEqual(44);

  const history = page.getByRole("link", { name: "Your door history" });
  await expect(history).toHaveAttribute("href", "/profile#door-history");
  expect((await history.boundingBox())!.height).toBeGreaterThanOrEqual(44);
});
