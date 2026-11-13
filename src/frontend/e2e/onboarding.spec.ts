import { SESSION_ADMIN, SESSION_ANON, serveApi, signIn, test, expect, type ApiRoute, memberCodeRoutes } from "./fixtures";
import { ADMIN_TOUR, CHECKLIST, CODE_HELP, GET_STARTED, REPLAY_ADMIN_TOUR, REPLAY_WELCOME } from "../src/lib/onboardingCopy";
import { tourStops } from "../src/components/onboarding/adminTourMarks";
import { LOGIN } from "../src/lib/authCopy";

/**
 * Item 16 — "How it works", and the one card that is pushed.
 *
 * <p>
 * Walked as a blind reviewer would: can somebody who has never used the club's box find out
 * what to do, from the three places they might look, and does the product ever claim anything
 * it has not been told? The claims are what these assert — a club with no door never meets the
 * word, a button label nobody served is never quoted, and no drawing carries an instruction on
 * its own.
 * </p>
 */

const SESSION_MEMBER = { ...SESSION_ANON, user_id: "00000000-0000-0000-0000-000000000009", is_authenticated: true };

const BOOKING = {
  starts_at: "2099-01-01T17:00:00Z",
  ends_at: "2099-01-01T17:45:00Z",
  court_number: 3,
  door_opens_at: "2099-01-01T16:30:00Z",
  door_closes_at: "2099-01-01T18:05:00Z",
};

function door(over: Record<string, unknown> = {}) {
  return {
    doors: true, doors_shut: "none", timezone: "Africa/Johannesburg",
    policy: "booking_window", membership: "active", membership_detail: "active",
    is_club_admin: false, next_booking: BOOKING, early_entry_minutes: 30,
    roster_max_entries: 48, contact: { phone: "021 555 0134", email: "info@review.test" },
    door_log_retention_days: 90, last_decision: null, ...over,
  };
}

function home(doorBody: Record<string, unknown>) {
  return [
    { path: "/api/v1/session", body: SESSION_MEMBER },
    { path: "/api/v1/whoami", body: { ...SESSION_MEMBER, is_admin: false } },
    { path: "/api/v1/me/profile", body: { full_name: "Thandi Probe", photo_url: null, email: "thandi@review.test" } },
    { path: "/api/v1/wallet", body: { balance_minutes: 120, entries: [], total_entries: 0, offset: 0, limit: 50 } },
    { path: "/api/v1/me/door", body: doorBody },
  ];
}

test.describe("the always-reachable guide", () => {
  test("is a list of steps with a heading each, with no carousel and no tour", async ({ page }) => {
    await serveApi(page, [{ path: "/api/v1/session", body: SESSION_ANON }, { path: "/api/v1/me/door", body: door() }]);
    await page.goto("/how-it-works");

    await expect(page.getByRole("heading", { level: 1, name: "How it works" })).toBeVisible();
    // Eight since P13: "Buy minutes" comes first, because every step after it spends them.
    const steps = page.getByRole("listitem");
    await expect(steps).toHaveCount(8);
    await expect(page.getByRole("heading", { level: 2 })).toHaveCount(8);
    await expect(page.getByRole("heading", { level: 2 }).first()).toHaveAccessibleName("Buy minutes");
    await expect(steps.first()).toContainText(/a booking costs exactly its playing time/);
    expect(await page.locator("main").innerText()).not.toMatch(/credit|top.?up|\bcr\b/i);
    // The three drawings, each a real image with a real name.
    const images = page.getByRole("img");
    await expect(images).toHaveCount(3);
    for (const image of await images.all()) {
      expect((await image.getAttribute("aria-label"))!.length).toBeGreaterThan(20);
    }
  });

  test("describes the box's own flow: scan, card, court, time", async ({ page }) => {
    await serveApi(page, [{ path: "/api/v1/session", body: SESSION_ANON }, { path: "/api/v1/me/door", body: door() }]);
    await page.goto("/how-it-works");

    const box = page.getByRole("listitem").filter({ hasText: "Turn the lights on at the court box" });
    await expect(box).toContainText("SCAN YOUR QR CODE");
    // A booked member presses nothing: the panel has no OK button, so there is nothing that
    // "confirm" could map onto. That asymmetry is the whole point of the step.
    await expect(box).toContainText(/lights come on by themselves/);
    await expect(box).toContainText(/there is nothing to press/);
    // The greeting the box actually paints, and the two presses a walk-up makes, in order.
    await expect(box).toContainText(/HI and your name/);
    await expect(box).toContainText(/the green buttons marked A, B, C and D/);
    await expect(box).toContainText(/the black buttons marked 15, 30, 45 and 60/);
    // And nothing quotes a label nobody served.
    expect(await box.innerText()).not.toMatch(/"/);
  });

  test("says nothing whatever about doors at a club that has none", async ({ page }) => {
    await serveApi(page, [
      { path: "/api/v1/session", body: SESSION_ANON },
      { path: "/api/v1/me/door", body: door({ doors: false }) },
    ]);
    await page.goto("/how-it-works");
    /*
      Wait for the ANSWER, not for the first heading. "Does this club have a door" starts
      `unknown` and settles to `no` one round trip later, and `unknown` deliberately keeps the
      door step — a member who HAS a door and is not told about it is stuck outside a
      building. Reading the page between those two states is reading a screen that is still
      asking, which is what made this assertion flaky rather than wrong.
    */
    await expect(page.getByRole("heading", { level: 2 })).toHaveCount(7);
    expect(await page.locator("body").innerText()).not.toMatch(/door/i);
  });

  test("is reachable from the home screen, the code page and the profile", async ({ page }) => {
    await signIn(page);
    await serveApi(page, [
      ...home(door()),
      ...memberCodeRoutes(),
      { path: "/api/v1/me/door/history", body: { items: [], has_more: false } },
      /*
       * An ARRAY, because that is what the endpoint returns: `webauthnList` is typed
       * `WebAuthnCredentialRow[]`, and `PasskeysCard` hands the result straight to `rows.map`.
       *
       * Stubbed as `{ credentials: [] }` this spec crashed the whole Profile tree with
       * "rows.map is not a function" — and passed anyway for as long as the link below
       * happened to render before the passkeys read resolved. That is a race, not a test: it
       * went red the first time an unrelated change shifted render timing by a few
       * milliseconds, having been wrong the entire time.
       */
      { path: "/api/v1/me/webauthn/credentials", body: [] },
    ]);

    // Home is My Code for a member, and its guide sits behind the help icon there too.
    await page.goto("/");
    await page.getByRole("button", { name: CODE_HELP.label }).click();
    await expect(page.getByRole("link", { name: /How it works/ })).toBeVisible();

    // On My Code the guide sits behind the help icon (0c8fdc0): the page stays the code.
    await page.goto("/my-code");
    await page.getByRole("button", { name: CODE_HELP.label }).click();
    await expect(page.getByRole("link", { name: /How it works, step by step/ })).toBeVisible();

    await page.goto("/profile?tab=account");
    await expect(page.getByRole("link", { name: "How it works" })).toBeVisible();
  });

  test("at 320px nothing runs off the side, at a 16px root or a 32px one", async ({ page }) => {
    await serveApi(page, [{ path: "/api/v1/session", body: SESSION_ANON }, { path: "/api/v1/me/door", body: door() }]);
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/how-it-works");
    // The guide is a lazy route (P10): measure the page, not the skeleton that holds its place.
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    for (const root of [16, 32]) {
      await page.addStyleTag({ content: `html { font-size: ${root}px }` });
      const past = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("body *")]
        .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1).length);
      expect(past, `elements past the right edge at a ${root}px root`).toBe(0);
    }
  });
});

test.describe("the card that is pushed", () => {
  test("names the real court and time, and goes away for that booking when dismissed", async ({ page }) => {
    await signIn(page);
    await serveApi(page, home(door()));
    await page.goto("/");

    const card = page.locator("section, div").filter({ hasText: "You're booked. Here's what happens next." }).first();
    await expect(page.getByText(/court 3 on \w{3} \d{1,2} \w{3}, from 19:00 to 19:45/i)).toBeVisible();
    await expect(card).toContainText(/lights come on by themselves/);

    await page.getByRole("button", { name: "Got it" }).click();
    await expect(page.getByText(/court 3 on \w{3} \d{1,2} \w{3}, from 19:00 to 19:45/i)).toHaveCount(0);

    // And it stays gone across a reload, because the dismissal is that booking's own end.
    await page.reload();
    await expect(page.getByText(/court 3 on \w{3} \d{1,2} \w{3}, from 19:00 to 19:45/i)).toHaveCount(0);
  });

  test("says nothing at all to a member with no booking", async ({ page }) => {
    await signIn(page);
    await serveApi(page, home(door({ next_booking: null })));
    await page.goto("/");

    await expect(page.getByText("You're booked. Here's what happens next.")).toHaveCount(0);
  });

  test("raises exactly no live region of its own", async ({ page }) => {
    await signIn(page);
    await serveApi(page, home(door()));
    await page.goto("/");
    await expect(page.getByText(/court 3 on \w{3} \d{1,2} \w{3}, from 19:00/i)).toBeVisible();

    // The booking toast already announces the court and the time. A second region for the
    // same event is the defect the toast viewport records having paid for twice.
    const live = await page.evaluate(() => {
      const card = [...document.querySelectorAll("*")]
        .find((el) => el.textContent?.startsWith("You're booked."));
      return card ? card.querySelectorAll("[aria-live], [role=status], [role=alert]").length : -1;
    });
    expect(live).toBe(0);
  });
});

/* ------------------------------------------------------------------------------------------
 * P8 — the welcome wizard, the first-run gate, the setup checklist and the admin tour.
 *
 * Walked the way a new member and a new admin meet them: sign in, land, and see what the
 * product does next. Every string comes from `lib/onboardingCopy.ts` so the spec reads as
 * the screens do. Runs in both projects — the phone (section bar, bottom tab bar) and the
 * desktop (the admin rail from xl).
 * ---------------------------------------------------------------------------------------- */


const PREFS = {
  theme: "system",
  member_onboarding_completed_at: null as string | null,
  member_onboarding_dismissed_at: null as string | null,
  member_onboarding_last_step: null as string | null,
  admin_onboarding_completed_at: null as string | null,
  onboarding_version: 1,
  current_onboarding_version: 1,
};

type Recorder = { calls: Array<{ method: string; path: string; body: unknown }> };

function p8Routes(opts: { admin?: boolean; prefs?: Partial<typeof PREFS>; recorder: Recorder; extra?: ApiRoute[] }): ApiRoute[] {
  const session = opts.admin ? SESSION_ADMIN : SESSION_MEMBER;
  const prefs = { ...PREFS, ...(opts.prefs ?? {}) };
  const record = (answer: (body: unknown) => unknown) => (r: { method: string; path: string; body: unknown }) => {
    opts.recorder.calls.push(r);
    return answer(r.body);
  };
  return [
    ...(opts.extra ?? []),
    { path: "/api/v1/session", body: session },
    { path: "/api/v1/whoami", body: { ...session, is_admin: Boolean(opts.admin) } },
    {
      path: "/api/v1/me/profile",
      body: {
        user_id: session.user_id, email: "thandi@review.test", is_admin: Boolean(opts.admin), tenant_slug: "crusaders",
        full_name: "Thandi Probe", membership_number: "M-9", photo_url: null, status: "active", preferences: prefs,
      },
    },
    { path: "/api/v1/wallet", body: { balance_minutes: 0, entries: [], total_entries: 0, offset: 0, limit: 50 } },
    { path: "/api/v1/me/webauthn/credentials", body: [] },
    // P11 / D13 — the wizard's last step and Profile's Privacy card read the social switches.
    { path: "/api/v1/me/preferences", body: { ...prefs, findable: false, show_in_leaderboards: false } },
    { path: "/api/v1/me/door", body: door({ next_booking: null }) },
    { path: "/api/v1/me/door/history", body: { items: [], has_more: false } },
    ...memberCodeRoutes(),
    { method: "PUT", path: "/api/v1/me/onboarding/member/step", respond: record((b) => ({ ...prefs, member_onboarding_last_step: (b as { step: string }).step })) },
    { method: "POST", path: "/api/v1/me/onboarding/member/complete", respond: record(() => ({ ...prefs, member_onboarding_completed_at: "2026-09-23T10:00:00Z" })) },
    { method: "POST", path: "/api/v1/me/onboarding/member/dismiss", respond: record(() => ({ ...prefs, member_onboarding_dismissed_at: "2026-09-23T10:00:00Z" })) },
    { method: "POST", path: "/api/v1/me/onboarding/admin/complete", respond: record(() => ({ ...prefs, admin_onboarding_completed_at: "2026-09-23T10:00:00Z" })) },
    { path: "/api/v1/admin/members", body: [] },
    { path: "/api/v1/admin/monitoring/summary", body: { open: {} } },
    { path: "/api/v1/admin/doors", body: { day_started_at: "2026-09-23T00:00:00Z", timezone: "Africa/Johannesburg", shut_all_active: false, doors: [] } },
  ];
}

/**
 * F4.8 — the wizard is offered on the landing a SIGN-IN delivers the member to, so these walks
 * sign in through the form. A token planted before load is a member reopening the app — at a
 * door, most likely — and that must land on the code.
 */
async function signInThroughForm(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.getByLabel(LOGIN.email, { exact: true }).fill("thandi@review.test");
  await page.getByLabel(LOGIN.password, { exact: true }).fill("correct horse");
  await page.getByRole("button", { name: LOGIN.submit, exact: true }).click();
}

function loginRoute(): ApiRoute {
  return { method: "POST", path: "/api/v1/auth/login", body: { access_token: "e2e-token", user_id: SESSION_MEMBER.user_id, is_admin: false } };
}

test.describe("P8: the welcome wizard", () => {
  test("never puts the wizard between a member and their code when My Code is opened directly", async ({ page }) => {
    const recorder: Recorder = { calls: [] };
    await signIn(page);
    await serveApi(page, p8Routes({ recorder }));
    await page.goto("/my-code");
    await expect(page.getByRole("article", { name: "Your member pass" })).toBeVisible();
    await expect(page.getByText(GET_STARTED.stepOf(1, 7))).toHaveCount(0);
    await expect(page).toHaveURL(/\/my-code$/);
  });

  test("a newly approved member lands on it once, walks it, and finishes on My Code", async ({ page }) => {
    const recorder: Recorder = { calls: [] };
    await serveApi(page, p8Routes({ recorder, extra: [loginRoute()] }));
    await signInThroughForm(page);

    await expect(page).toHaveURL(/\/get-started$/);
    await expect(page.getByRole("heading", { level: 1, name: GET_STARTED.title })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: GET_STARTED.steps.welcome.title })).toBeVisible();

    const titles = [
      GET_STARTED.steps.code.title, GET_STARTED.steps.passkey.title,
      GET_STARTED.steps.buy.title, GET_STARTED.steps.book.title, GET_STARTED.steps.install.title,
      GET_STARTED.steps.privacy.title,
    ];
    for (const [i, title] of titles.entries()) {
      await page.getByRole("button", { name: GET_STARTED.next, exact: true }).click();
      await expect(page.getByRole("heading", { level: 2, name: title })).toBeVisible();
      await expect(page.getByText(GET_STARTED.stepOf(i + 2, 7))).toBeVisible();
    }
    await page.getByRole("button", { name: GET_STARTED.finish }).click();
    await expect(page).toHaveURL(/\/my-code$/);
    expect(recorder.calls.some((c) => c.path.endsWith("/member/complete"))).toBe(true);
    expect(recorder.calls.filter((c) => c.path.endsWith("/member/step")).map((c) => (c.body as { step: string }).step))
      .toEqual(["code", "passkey", "buy", "book", "install", "privacy"]);

    // Once per sign-in: arriving at the landing again does not send the member round again.
    await page.goto("/my-code");
    // D1/D8: My Code's h1 is visually hidden on a phone (the pass says whose it is), so it is
    // asserted present, and the pass itself visible.
    await expect(page.getByRole("heading", { level: 1, name: "My Code" })).toBeAttached();
    await expect(page.getByRole("article", { name: "Your member pass" })).toBeVisible();
    await expect(page).toHaveURL(/\/my-code$/);
  });

  test("can be skipped, which the club records as a dismissal", async ({ page }) => {
    const recorder: Recorder = { calls: [] };
    await serveApi(page, p8Routes({ recorder, extra: [loginRoute()] }));
    await signInThroughForm(page);
    await expect(page).toHaveURL(/\/get-started$/);

    await page.getByRole("button", { name: GET_STARTED.skip }).click();
    await expect(page).toHaveURL(/\/my-code$/);
    expect(recorder.calls.some((c) => c.path.endsWith("/member/dismiss"))).toBe(true);
  });

  test("is never pushed at a member who finished it, and is reopened from the account menu", async ({ page }) => {
    const recorder: Recorder = { calls: [] };
    await signIn(page);
    await serveApi(page, p8Routes({ recorder, prefs: { member_onboarding_completed_at: "2026-09-01T10:00:00Z", member_onboarding_last_step: "book" } }));
    await page.goto("/my-code");
    // D1/D8: My Code's h1 is visually hidden on a phone (the pass says whose it is), so it is
    // asserted present, and the pass itself visible.
    await expect(page.getByRole("heading", { level: 1, name: "My Code" })).toBeAttached();
    await expect(page.getByRole("article", { name: "Your member pass" })).toBeVisible();
    await expect(page).toHaveURL(/\/my-code$/);

    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("menuitem", { name: REPLAY_WELCOME }).click();
    await expect(page).toHaveURL(/\/get-started\?replay=1$/);
    // A replay starts at the beginning, whatever the resume point says.
    await expect(page.getByRole("heading", { level: 2, name: GET_STARTED.steps.welcome.title })).toBeVisible();
  });

  // Go-live BM-07 — a 36rem column in a 1440 window left two thirds of it empty.
  test("uses a wide screen: the steps stand in a rail beside the step in hand", async ({ page }) => {
    const recorder: Recorder = { calls: [] };
    await signIn(page);
    await serveApi(page, p8Routes({ recorder }));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/get-started?step=passkey");
    const rail = page.getByRole("navigation", { name: GET_STARTED.stepsLabel });
    await expect(rail).toBeVisible();
    await expect(rail.locator("[aria-current='step']")).toContainText(GET_STARTED.steps.passkey.title);
    const used = await page.evaluate(() => {
      const main = document.querySelector("#main-content")!.getBoundingClientRect();
      const boxes = [...document.querySelectorAll<HTMLElement>("[data-step-rail], [data-onboarding-progress]")].map((el) => el.getBoundingClientRect());
      const left = Math.min(...boxes.map((b) => b.left));
      const right = Math.max(...boxes.map((b) => b.right));
      return (right - left) / main.width;
    });
    expect(used).toBeGreaterThan(0.6);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(rail).toBeHidden();
  });

  test("fits a 320px phone at a 16px root or a 32px one", async ({ page }) => {
    const recorder: Recorder = { calls: [] };
    await signIn(page);
    await serveApi(page, p8Routes({ recorder }));
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/get-started?step=install");
    await expect(page.getByRole("heading", { level: 2, name: GET_STARTED.steps.install.title })).toBeVisible();
    for (const root of [16, 32]) {
      await page.addStyleTag({ content: `html { font-size: ${root}px }` });
      const past = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("main *")]
        .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1).length);
      expect(past, `elements past the right edge at a ${root}px root`).toBe(0);
    }
  });
});

test.describe("P8: the setup checklist on My Code", () => {
  test("counts what is done from real reads, links to each, and can be hidden", async ({ page }) => {
    const recorder: Recorder = { calls: [] };
    await signIn(page);
    await serveApi(page, p8Routes({
      recorder,
      prefs: { member_onboarding_dismissed_at: "2026-09-01T10:00:00Z" },
      extra: [
        { path: "/api/v1/me/webauthn/credentials", body: [{ id: "p", label: "iPhone", transports: null, created_at: "2026-09-01T10:00:00Z", last_used_at: null }] },
      ],
    }));
    // The checklist sits behind My Code's help icon (0c8fdc0), not down the page by default.
    await page.goto("/my-code");
    await page.getByRole("button", { name: CODE_HELP.label }).click();

    const card = page.getByRole("region", { name: CHECKLIST.title });
    await expect(card).toBeVisible();
    await expect(card).toContainText(CHECKLIST.progress(1, 4));
    await expect(card.getByRole("link", { name: CHECKLIST.items.passkey.done })).toBeVisible();
    await expect(card.getByRole("link", { name: CHECKLIST.items.buy.label })).toHaveAttribute("href", "/wallet/buy");

    await card.getByRole("button", { name: CHECKLIST.hide }).click();
    await expect(card).toHaveCount(0);
    await page.reload();
    // D1/D8: My Code's h1 is visually hidden on a phone (the pass says whose it is), so it is
    // asserted present, and the pass itself visible. Hidden stays hidden, help opened or not.
    await expect(page.getByRole("heading", { level: 1, name: "My Code" })).toBeAttached();
    await expect(page.getByRole("article", { name: "Your member pass" })).toBeVisible();
    await page.getByRole("button", { name: CODE_HELP.label }).click();
    await expect(page.getByRole("link", { name: /How it works, step by step/ })).toBeVisible();
    await expect(page.getByRole("region", { name: CHECKLIST.title })).toHaveCount(0);
  });
});

test.describe("P8: the admin tour", () => {
  test("fires on the first Admin visit, points at each section, and is recorded when done", async ({ page }, info) => {
    const recorder: Recorder = { calls: [] };
    await signIn(page);
    await serveApi(page, p8Routes({ admin: true, recorder, prefs: { member_onboarding_dismissed_at: "2026-09-01T10:00:00Z" } }));
    await page.goto("/admin");

    // The stops this console has a section for (P13's Packages joins with its nav item).
    const stops = tourStops();
    for (const [i, stop] of stops.entries()) {
      const mark = page.getByRole("dialog", { name: stop.title });
      await expect(mark).toBeVisible();
      await expect(mark).toContainText(ADMIN_TOUR.stepOf(i + 1, stops.length));
      const box = (await mark.boundingBox())!;
      const viewport = page.viewportSize()!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
      // Anchored to the real control: beside the rail row on a wide screen, under the section
      // bar on a phone — where the section actually is at this width.
      const railRow = page.locator(`[data-admin-rail] [data-admin-nav="${stop.navId}"]`);
      if (await railRow.isVisible()) {
        expect(box.x).toBeGreaterThan((await railRow.boundingBox())!.x);
      } else {
        const bar = (await page.locator("[data-admin-section-bar] button").boundingBox())!;
        expect(box.y).toBeGreaterThanOrEqual(bar.y + bar.height - 1);
        await expect(mark).toContainText(ADMIN_TOUR.bar);
      }
      const last = i === stops.length - 1;
      await mark.getByRole("button", { name: last ? ADMIN_TOUR.done : ADMIN_TOUR.next, exact: true }).click();
    }
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(recorder.calls.some((c) => c.path.endsWith("/admin/complete"))).toBe(true);
    expect(info.project.name === "desktop" || info.project.name === "mobile").toBe(true);
  });

  test("is skippable, stays away on a deep link, and is replayed from the account menu", async ({ page }) => {
    const recorder: Recorder = { calls: [] };
    await signIn(page);
    await serveApi(page, p8Routes({
      admin: true, recorder,
      prefs: { member_onboarding_dismissed_at: "2026-09-01T10:00:00Z", admin_onboarding_completed_at: "2026-09-01T10:00:00Z" },
    }));
    await page.goto("/admin/members");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("menuitem", { name: REPLAY_ADMIN_TOUR }).click();
    const first = page.getByRole("dialog", { name: ADMIN_TOUR.stops[0].title });
    await expect(first).toBeVisible();
    await first.getByRole("button", { name: ADMIN_TOUR.skip }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page).toHaveURL(/\/admin$/);
  });
});
