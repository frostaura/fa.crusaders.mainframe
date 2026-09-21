import { SESSION_ANON, serveApi, signIn, test, expect } from "./fixtures";

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
    { path: "/api/v1/wallet", body: { balance_credits: 120, entries: [], total_entries: 0, offset: 0, limit: 50 } },
    { path: "/api/v1/me/door", body: doorBody },
  ];
}

test.describe("the always-reachable guide", () => {
  test("is a list of steps with a heading each, with no carousel and no tour", async ({ page }) => {
    await serveApi(page, [{ path: "/api/v1/session", body: SESSION_ANON }, { path: "/api/v1/me/door", body: door() }]);
    await page.goto("/how-it-works");

    await expect(page.getByRole("heading", { level: 1, name: "How it works" })).toBeVisible();
    const steps = page.getByRole("listitem");
    await expect(steps).toHaveCount(7);
    await expect(page.getByRole("heading", { level: 2 })).toHaveCount(7);
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
    await expect(box).toContainText("SCAN YOUR CODE");
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
    await expect(page.getByRole("heading", { level: 2 })).toHaveCount(6);
    expect(await page.locator("body").innerText()).not.toMatch(/door/i);
  });

  test("is reachable from the home screen, the code page and the profile", async ({ page }) => {
    await signIn(page);
    await serveApi(page, [
      ...home(door()),
      { method: "POST", path: "/api/v1/me/qr/generate", body: { code: "ZZ9P4T6WQ8HN", kind: "ident", expires_in_seconds: 60, doors: true } },
      { path: "/api/v1/me/door/history", body: { items: [], has_more: false } },
      { path: "/api/v1/me/webauthn/credentials", body: { credentials: [] } },
    ]);

    await page.goto("/");
    await expect(page.getByRole("link", { name: /How it works/ })).toBeVisible();

    await page.goto("/my-code");
    await expect(page.getByRole("link", { name: /How it works, step by step/ })).toBeVisible();

    await page.goto("/profile");
    await expect(page.getByRole("link", { name: "How it works" })).toBeVisible();
  });

  test("at 320px nothing runs off the side, at a 16px root or a 32px one", async ({ page }) => {
    await serveApi(page, [{ path: "/api/v1/session", body: SESSION_ANON }, { path: "/api/v1/me/door", body: door() }]);
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/how-it-works");

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
    await expect(page.getByText(/court 3, from 19:00 to 19:45/i)).toBeVisible();
    await expect(card).toContainText(/lights come on by themselves/);

    await page.getByRole("button", { name: "Got it" }).click();
    await expect(page.getByText(/court 3, from 19:00 to 19:45/i)).toHaveCount(0);

    // And it stays gone across a reload, because the dismissal is that booking's own end.
    await page.reload();
    await expect(page.getByText(/court 3, from 19:00 to 19:45/i)).toHaveCount(0);
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
    await expect(page.getByText(/court 3, from 19:00/i)).toBeVisible();

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
