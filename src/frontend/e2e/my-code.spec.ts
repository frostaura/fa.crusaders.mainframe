import { SESSION_ANON, memberCodeRoutes, serveApi, signIn, test, expect } from "./fixtures";
import { tokensAroundNow } from "./memberCodeOracle";

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

/*
  D1 — the legacy code fixture is gone: the page enrols for the single rotating code through
  `memberCodeRoutes()` (in COMMON). Retired with it, as D1: the full-screen overlay's dead-code
  state, the booking-code-specific refusals, the code-that-dies-with-no-signal case, the
  member-code switch and its way back, the code choice at 320x568, the walk-up wording and the
  item-9 capsule under forced colours / reduced motion / a 32px root. The single code, its
  offline badge and its full-screen view are held by `my-code-pass.spec.ts`.
*/

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
    // WIRE-R2 §4. `doors` means "this club has scanners" now, enabled or not, and how many
    // of them are shut is a separate question with three answers.
    doors_shut: "none",
    // The club's own zone, so every face on this surface is the club's day rather than
    // whichever one the reader's phone happens to be in. O1.
    timezone: "Africa/Johannesburg",
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

/** `GET /me/door/history` with nothing in it — what the self-check reads when pressed. */
const EMPTY_HISTORY = {
  items: [], next_cursor: null, retention_days: 90, timezone: "Africa/Johannesburg",
};

const COMMON = [
  { path: "/api/v1/whoami", body: SESSION_MEMBER },
  { path: "/api/v1/wallet", body: { balance_minutes: 500, entries: [], total_entries: 0, offset: 0, limit: 50 } },
  ...memberCodeRoutes(),
  // E-H2 (2) — the self-check reads the club's own record. Stubbed here rather than per
  // test because `serveApi` is strict and an unstubbed call fails the test it appears in,
  // which for a control every one of these presses would be all of them.
  { path: "/api/v1/me/door/history", body: EMPTY_HISTORY },
];

/**
 * An instant a few seconds ago.
 *
 * <p>
 * The decision fixtures below are pinned to 2099 so a booking's window never drifts into
 * the past while the suite runs. A DECISION is the opposite case: the server sends one only
 * inside a two-minute window, the card reads its own age off it (D6), and the self-check
 * will only lead with a refusal inside fifteen minutes — so a decision stamped 2099 is a
 * response the endpoint cannot produce and a card that is permanently in the future.
 * </p>
 */
const recent = () => new Date(Date.now() - 20_000).toISOString();

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
  // D1/D8: My Code's h1 is visually hidden on a phone (the pass says whose it is), so it is
  // asserted present, and the pass itself visible.
  await expect(page.getByRole("heading", { name: "My Code" })).toBeAttached();
  await expect(page.getByRole("article", { name: "Your member pass" })).toBeVisible();
  // D1: the member's one code, as the club computes it (an independent Node implementation).
  const shown = await page.getByLabel("Your code", { exact: true }).textContent();
  expect(tokensAroundNow()).toContain(shown);
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
    { path: "/api/v1/wallet", body: { balance_minutes: 500, entries: [], total_entries: 0, offset: 0, limit: 50 } },
    ...memberCodeRoutes(),
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
  const controls = page.locator("[data-page-shell] a, [data-page-shell] button");
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

  // D1: the bare 19-character token, nothing around it.
  const qr = page.getByRole("img", { name: /^QR code 1[0-9A-Z]{4}\d{14}$/ });
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
  // A version-2 symbol (19 bytes) is 25 modules; the viewBox carries 4 modules of quiet
  // zone on each side, so its extent is the symbol plus 8.
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
  // reviewers A and C found at 200% zoom (A10 / C14), it belongs to the app shell (`components/shell/`),
  // and a sibling lane owns it. Asserting on the document here would make this spec fail
  // for their defect and pass for mine — or, worse, tempt this lane into editing a shared
  // component two people are landing on.
  const bodyOverflow = await page.evaluate(() => {
    const column = document.querySelector("[data-page-shell]");
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
    // SQUARE, which is the part the reserve buys rather than the shrink valve.
    //
    // The box may shrink so that nothing is ever pushed off the glass, and that valve alone
    // keeps the two assertions above true however wrong the reserve is — it just letterboxes
    // the symbol inside a box that is no longer a square. So the reserve is held here: it is
    // right exactly when the box the symbol is given is the size the symbol wants.
    expect(Math.abs(qr.width - qr.height)).toBeLessThanOrEqual(1);

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
 *
 * <p>
 * Ruling 15 moved the row from "unusual, tell the club" to a failure: the door used to walk
 * straight past the membership check for a user with no row, and the backend now refuses her
 * with a reason of her own. The tick rule is unchanged — it is the one this case exists for.
 * </p>
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
  await expect(panel).toContainText(/the club has to add you/);
  await expect(panel).toContainText(/no membership on file/);
  // And never "not active": there is nothing to reinstate.
  await expect(panel).not.toContainText(/not active/i);
});

/**
 * D13/D14, on the assembled page: the escape hatch a member has to be able to find, and
 * the record that was three steps away from the screen where the question gets asked.
 */
test("there is one code and no tabs, and the member's own record is one tap away", async ({ page }) => {
  await signIn(page);
  await serveApi(page, [...COMMON, { path: "/api/v1/me/door", body: door() }]);

  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto("/my-code");

  // D1: one code, so there is no tab control at all any more.
  await expect(page.getByLabel("Your code", { exact: true })).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(0);

  const history = page.getByRole("link", { name: "Your door history" });
  await expect(history).toHaveAttribute("href", "/profile#door-history");
  expect((await history.boundingBox())!.height).toBeGreaterThanOrEqual(44);
});

// --- round 2 ------------------------------------------------------------------------

/**
 * D8. The page opened with a heading, a two-line subtitle and, when there was one, a
 * decision card — so at 320×568, the smallest screen this product supports, the QR was
 * entirely below the fold. A member standing at a scanner had to scroll to find the one
 * thing they opened the page for, one-handed, in the dark.
 *
 * <p>
 * jsdom has no layout, so the unit test can only hold document order. This is the fold
 * itself, measured, with a decision card on the page because that is the case that pushed
 * the QR furthest down.
 * </p>
 */
test("the code is fully above the fold at 320x568, decision card and all", async ({ page }) => {
  await signIn(page);
  await serveApi(page, [...COMMON, {
    path: "/api/v1/me/door",
    body: door({ last_decision: decision({ reason: "ok", released: true, at: recent() }) }),
  }]);

  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/my-code");
  await expect(page.getByLabel("Your code", { exact: true })).toBeVisible();

  const qr = (await page.getByRole("img", { name: /QR code/ }).boundingBox())!;
  expect(qr.y).toBeGreaterThanOrEqual(0);
  expect(qr.y + qr.height).toBeLessThanOrEqual(568);
  // And it did not get there by shrinking to nothing: a symbol a scanner cannot read at
  // arm's length is not above the fold in any sense that helps.
  expect(qr.width).toBeGreaterThanOrEqual(200);

  /*
    The same rule at a 32px root, stated against the part of the screen this page is given.

    At that root the symbol is NOT on the glass, and the arithmetic says why: the app header
    and tab strip take 306px of a 568px screen, leaving `<main>` 262px for a 254px symbol
    plus a heading plus every gap. That is reviewer B12's finding — "the header and tab bar
    take 54% of a 320×568 screen at a 32px root" — it lives in the app shell (`components/shell/`), and
    a sibling lane owns it. Asserting the viewport fold here would make this case fail for
    their defect and pass for mine.

    So what is held is this page's own contribution: measured from the top of the scrolling
    area, the whole symbol sits inside one screen's height. The moment the chrome gives this
    page a screen to work with, the code is on it — and if the page ever starts adding a
    block above its own symbol again, this fails first.
  */
  await page.addStyleTag({ content: "html { font-size: 32px !important; }" });
  await page.waitForTimeout(150);
  const fits = await page.evaluate(() => {
    const main = document.querySelector("main")!.getBoundingClientRect();
    const symbol = document.querySelector('svg[aria-label^="QR code"]')!.getBoundingClientRect();
    return Math.round(symbol.bottom - main.top);
  });
  expect(fits).toBeLessThanOrEqual(568);
});

/**
 * D10. A decision arriving moved the QR down 290 px — on a screen somebody was holding
 * against a scanner — and dismissing it moved the QR back up. Both directions are the same
 * defect: nothing that comes and goes may move the code.
 */
test("nothing that arrives or leaves moves the QR", async ({ page }) => {
  await signIn(page);
  // The door read answers WITHOUT a decision first, and with one from the second call on.
  // The page polls it, so the card genuinely arrives under the member's thumb rather than
  // being there from the first paint — which is the event the finding is about.
  let doorReads = 0;
  await serveApi(page, COMMON);
  await page.route("**/api/v1/me/door", (route) => {
    doorReads += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(doorReads > 1
        ? door({ last_decision: decision({ reason: "ok", released: true, at: recent() }) })
        : door()),
    });
  });

  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/my-code");
  const qr = page.getByRole("img", { name: /QR code/ });
  await expect(qr).toBeVisible();

  /*
    Where the symbol sits in the SCROLLED CONTENT, not in the viewport.

    The two are the same number for as long as nobody scrolls, and the arrival case below
    checks both — which is the case the finding is about, a card appearing under a thumb
    holding the phone still. Dismissal is not: the control sits below the fold at 320×568, so
    pressing it scrolls the page there, and a viewport-relative reading afterwards reports
    that scroll as a 429px layout jump. Reading the content position asks the question the
    finding actually asks — did the layout move the code — rather than the question the test
    harness's own scrolling happens to answer.

    It has to find the scroller rather than ask the window, and that is not a detail: this
    app scrolls inside `<main class="overflow-auto">`, so `window.scrollY` is nought on every
    route and a `window.scrollTo` does nothing at all. A helper written against the window
    reads every scroll of this page as a layout jump, which is how this assertion came to be
    measuring the harness.

    And the scroller is found by its OVERFLOW, not by whether its content is taller than its
    box. Every wrapper between the symbol and `<main>` is taller than the box it sits in —
    that is what it means to be inside something that scrolls — so the first-overflowing
    test stops one element short, on a div whose `scrollTop` is permanently nought. It reads
    the right number for a position and silently does nothing at all when asked to scroll.
  */
  const contentY = async () => Math.round(await qr.evaluate((el) => {
    let scroller = el.parentElement;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) {
      scroller = scroller.parentElement;
    }
    if (!scroller) return el.getBoundingClientRect().top + window.scrollY;
    return el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  }));
  const toTop = () => qr.evaluate((el) => {
    let scroller = el.parentElement;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) {
      scroller = scroller.parentElement;
    }
    scroller?.scrollTo(0, 0);
    window.scrollTo(0, 0);
  });
  const viewportY = async () => Math.round((await qr.boundingBox())!.y);

  const before = await contentY();
  const beforeInView = await viewportY();

  /*
    Scoped to the card itself, because R3-29 gave the headline a twin: while the card is
    below the fold a one-line copy of it is pinned to the bottom of the glass, and an
    unscoped text locator resolves to both. That pin is `aria-hidden` and out of the tab
    order — it is a visual affordance, not a second announcement — and what this test is
    about is where the CARD sits, so the card is what it names.
  */
  const card = page.locator("#door-decision").getByText("The lock released.");
  await expect(card).toBeVisible({ timeout: 15_000 });
  expect(await contentY()).toBe(before);
  // Arrival moves nothing at all, on a page nobody has scrolled: this is the 290px jump.
  expect(await viewportY()).toBe(beforeInView);

  await page.getByRole("button", { name: "Dismiss" }).click();
  await expect(card).toBeHidden();
  expect(await contentY()).toBe(before);
  // And back where the member was, the fold is where it was: the code has not been pulled
  // up the page by the card's removal either.
  await toTop();
  expect(await viewportY()).toBe(beforeInView);
});

/**
 * D7. The symbol got SMALLER as the reader's text got bigger — 190 px at a 32 px root
 * against 254 px at the default — because every container between it and the viewport pads
 * in `rem`. A member who has turned the type up has done so because reading is hard, and
 * the product answered by shrinking the one thing on the page that is not text.
 */
test("the QR never shrinks when the root font grows", async ({ page }) => {
  await signIn(page);
  await serveApi(page, [...COMMON, { path: "/api/v1/me/door", body: door() }]);

  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/my-code");
  const qr = page.getByRole("img", { name: /QR code/ });
  await expect(qr).toBeVisible();
  const normal = (await qr.boundingBox())!.width;

  await page.addStyleTag({ content: "html { font-size: 32px !important; }" });
  await page.waitForTimeout(150);
  const large = (await qr.boundingBox())!.width;

  // Not merely "no smaller": the SAME. Every length between the glass and the symbol is a
  // pixel or a viewport unit now, so there is nothing left in the chain for a root font to
  // move — and "no smaller" would also be satisfied by a symbol that grew off the edge of
  // the screen, which is how the first fix for this passed while breaking the page.
  expect(large).toBe(normal);
  // And still on the glass, which is the constraint the old expression was honouring.
  const box = (await qr.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width).toBeLessThanOrEqual(321);
});


/**
 * C9 / D14. `aria-modal="true"` was a claim this overlay did not honour: Tab walked
 * straight out of it and through the page underneath, and dragging on it scrolled the page
 * behind — so a member closed the code and found themselves somewhere else on the page
 * than where they left it.
 */
test("the full-screen code traps Tab, inerts the page behind it and locks the scroll", async ({ page }) => {
  await signIn(page);
  await serveApi(page, [...COMMON, { path: "/api/v1/me/door", body: door() }]);

  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto("/my-code");
  await expect(page.getByLabel("Your code", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Show your code full screen" }).click();
  await expect(page.getByRole("dialog", { name: /full screen/i })).toBeVisible();

  // Every sibling of the overlay is inert, so a pointer, a caret browser, a screen
  // reader's virtual cursor and find-in-page all stop at it — not only Tab.
  const inert = await page.evaluate(() =>
    [...document.body.children]
      .filter((n) => n.getAttribute("role") !== "dialog")
      .every((n) => n.hasAttribute("inert")));
  expect(inert).toBe(true);
  expect(await page.evaluate(() => document.body.style.overflow)).toBe("hidden");

  // Six presses round a dialog with one stop: focus never leaves it.
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Tab");
    const inside = await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'));
    expect(inside).toBe(true);
  }

  // Back still closes only the overlay, and the page is usable again afterwards.
  await page.goBack();
  await expect(page.getByRole("dialog", { name: /full screen/i })).toBeHidden();
  await expect(page).toHaveURL(/\/my-code$/);
  expect(await page.evaluate(() => document.body.style.overflow)).toBe("");
  const released = await page.evaluate(() =>
    [...document.body.children].every((n) => !n.hasAttribute("inert")));
  expect(released).toBe(true);
});

/**
 * B4 / E-H1. `/my-code` stayed affirmative — "a live code of yours opens the club door" —
 * while the club's only usable door was shut. `doors` means "this club has scanners" now,
 * so the page no longer goes silent on the evening a member most needs telling something;
 * what it must not do is promise.
 */
for (const shut of ["some", "all"] as const) {
  test(`a member is told when ${shut} of the club's doors are shut, and promised nothing`, async ({ page }) => {
    await signIn(page);
    await serveApi(page, [...COMMON, {
      path: "/api/v1/me/door",
      body: door({ policy: "active_member", early_entry_minutes: null, next_booking: null, doors_shut: shut }),
    }]);

    await page.goto("/my-code");

    await expect(page.getByText(/The club has shut/)).toContainText(/turns every code away/);
    // Both halves: a door that has LOST the network decides from the list it downloaded
    // earlier, and this screen cannot see which of those a door is doing.
    await expect(page.getByText(/The club has shut/)).toContainText(/lost the network/);
    await expect(page.getByText("A live member code of yours opens the club door.")).toHaveCount(0);
    // The section is still there, which is the half `doors` used to get wrong.
    await expect(page.getByText("What opens the door for you right now")).toBeVisible();
    await expect(page.getByRole("link", { name: "Your door history" })).toBeVisible();
  });
}


/**
 * D1. Each read failing alone was handled well; the two failing together reverted the page
 * to court-only copy — no door section, no self-check, no history link and not one `tel:`
 * on the screen, for the member standing at the door in the dark.
 */
test("both reads failing still leaves a door section, a self-check and a way to a human", async ({ page }) => {
  await signIn(page);
  await serveApi(page, [
    { path: "/api/v1/whoami", body: SESSION_MEMBER },
    { path: "/api/v1/wallet", body: { balance_minutes: 500, entries: [], total_entries: 0, offset: 0, limit: 50 } },
    { path: "/api/v1/me/door/history", body: EMPTY_HISTORY },
  ]);
  // D1: a phone with no key, and no club to enrol with.
  await page.route("**/api/v1/me/code/enrol", (route) => route.abort("failed"));
  await page.route("**/api/v1/me/door", (route) => route.abort("failed"));

  await page.goto("/my-code");

  await expect(page.getByText("What opens the door for you right now")).toBeVisible();
  await expect(page.getByRole("button", { name: "The door didn't open" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Your door history" })).toBeVisible();
  // It says what it could not do, and claims nothing about the club — including whether
  // the club has a door at all.
  await expect(page.getByText(/can't tell you what its doors need from you/))
    .toContainText(/or whether this club has any/);
  await expect(page.getByText(/hasn't given the app a number/)).toHaveCount(0);
});

/**
 * <b>R3-4.</b> The round-3 review stack's API predated WIRE-R2 §4 and sent no `doors_shut`
 * at all, so every sentence built from it compared `undefined` against `"none"`, failed, and
 * fell through to the "some" arm — while the arm that picks the promise fell through the
 * other way. Every account in the evidence read "The club has shut some of its doors for
 * now" above "A live member code of yours opens the club door", at a club that had shut
 * nothing. One missing field, two sentences, arguing with each other.
 */
test("a response with no doors_shut says nothing about shut doors, and promises nothing", async ({ page }) => {
  await signIn(page);
  const partial = door({ policy: "active_member", early_entry_minutes: null, next_booking: null });
  delete (partial as Record<string, unknown>).doors_shut;
  await serveApi(page, [...COMMON, { path: "/api/v1/me/door", body: partial }]);

  await page.goto("/my-code");

  await expect(page.getByText("What opens the door for you right now")).toBeVisible();
  await expect(page.getByText(/The club has shut/)).toHaveCount(0);
  await expect(page.getByText("A live member code of yours opens the club door.")).toHaveCount(0);
});

/** WIRE-R3 §5: the club knows which doors it shut, and the member cannot tell by looking. */
test("a member is told which doors the club has shut", async ({ page }) => {
  await signIn(page);
  await serveApi(page, [...COMMON, {
    path: "/api/v1/me/door",
    body: door({
      policy: "active_member", early_entry_minutes: null, next_booking: null,
      doors_shut: "some", doors_shut_names: ["Front door", "Side door"],
    }),
  }]);

  await page.goto("/my-code");
  await expect(page.getByText(/The club has shut some/)).toContainText("Front door");
  await expect(page.getByText(/The club has shut some/)).toContainText("Side door");
});



/**
 * <b>R3-10, the MEM half.</b> Escape, Done and the hardware back button all left focus on
 * `<body>`: for a keyboard user that is the top of the document, so closing the code threw
 * away their place on the page, and for a screen-reader user the dialog simply vanished with
 * nothing announced in its place.
 */
test("closing the full-screen code by Escape puts focus back on the code", async ({ page }) => {
  await signIn(page);
  await serveApi(page, [...COMMON, { path: "/api/v1/me/door", body: door() }]);

  await page.goto("/my-code");
  await page.getByRole("button", { name: "Show your code full screen" }).click();
  await expect(page.getByRole("dialog", { name: /full screen/i })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const focused = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName);
  expect(focused).toBe("Show your code full screen");
});

/**
 * <b>R3-29.</b> Measured at 390×844 by the reviewer: the decision card's top edge at y=829
 * against a 734px scrollport — the club's own answer to "why didn't the door open", ninety-five
 * pixels below the fold, on the screen of somebody standing at the door.
 *
 * <p>
 * It is pinned rather than moved, because moving it above the code re-opens D10. What is
 * asserted here is the outcome rather than the mechanism: with the card off the glass, one
 * line of it is on the glass.
 * </p>
 */
test("a decision below the fold is still on the glass", async ({ page }) => {
  await signIn(page);
  await serveApi(page, [...COMMON, {
    path: "/api/v1/me/door",
    body: door({ last_decision: decision({ reason: "ok", released: true, at: recent() }) }),
  }]);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/my-code");
  await expect(page.getByText("The lock released.").first()).toBeVisible();

  const visible = await page.evaluate(() => {
    const card = document.getElementById("door-decision")!.getBoundingClientRect();
    const peek = document.querySelector('[data-testid="decision-peek"]')?.getBoundingClientRect() ?? null;
    return {
      cardOnGlass: card.top < innerHeight && card.bottom > 0,
      peekOnGlass: !!peek && peek.top < innerHeight && peek.bottom > 0,
    };
  });
  // One of the two, always. Either the card itself is readable without scrolling, or the
  // pinned line is — never neither, which is what the reviewer photographed.
  expect(visible.cardOnGlass || visible.peekOnGlass).toBe(true);
});




