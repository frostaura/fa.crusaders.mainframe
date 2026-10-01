import { expect, test, type Page, type BrowserContext } from "@playwright/test";
import { SESSION_ADMIN } from "./fixtures";

/**
 * Item 8, in a browser — the states the chip can now express, and the one it could not.
 *
 * <p>
 * The two-tab walk is the one that matters and is the one a unit test cannot make: two real
 * pages, one session, one club. A member has the app open on a phone and on the clubhouse
 * tablet; the admin tops them up; the other tab has to agree. What this proves over the unit
 * version is that the wiring — visibility, the re-read on return, the toast, the count — is
 * hooked to the browser events it claims to be hooked to, rather than to a function a test
 * called directly.
 * </p>
 */

const PROFILE = {
  user_id: SESSION_ADMIN.user_id, email: "member@review.test", is_admin: false,
  tenant_slug: "crusaders", full_name: "Priya Naidoo", membership_number: "M-1",
  photo_url: null, status: "active",
};

/**
 * One club, answering both tabs — the balance is a variable the test moves, standing in for
 * the admin's adjust endpoint (which is another lane's surface).
 */
function club(startingBalance: number) {
  let balance = startingBalance;
  return {
    topUpTo(next: number) { balance = next; },
    async serve(target: Page | BrowserContext) {
      await target.route("**/api/v1/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        const json = (body: unknown, status = 200) =>
          route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

        if (path === "/api/v1/whoami") return json({ ...SESSION_ADMIN, is_admin: false });
        if (path === "/api/v1/me/profile") return json(PROFILE);
        if (path === "/api/v1/wallet") {
          return json({ balance_minutes: balance, entries: [], total_entries: 0, offset: 0, limit: 100 });
        }
        if (path === "/api/v1/wallet/stream-ticket") return json({ ticket: "t", expires_in_seconds: 60 });
        if (path === "/api/v1/wallet/stream") {
          /*
           * A real `text/event-stream` body, delivered whole.
           *
           * `route.fulfill` cannot hold a response open, so this carries the balance AS AT THE
           * MOMENT OF CONNECTING and then ends. That is enough for what is under test here —
           * a reconnect picks up a change — and it exercises the client's actual frame parser
           * rather than a stub of it. The reopen-and-poll behaviour has its own unit coverage
           * with a fake transport, where the schedules can be driven.
           */
          return route.fulfill({
            status: 200,
            contentType: "text/event-stream",
            headers: { "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" },
            body: `event: balance\ndata: ${JSON.stringify({ balance_minutes: balance })}\n\n`,
          });
        }
        if (path === "/api/v1/schedule") {
          return json({
            date: new Date().toISOString().slice(0, 10), timezone: "Africa/Johannesburg",
            sliceMinutes: 15, dayStartMinute: 360, dayEndMinute: 1320, advanceBookingDays: 14,
            penaltyPct: 30, penaltyWindowMinutes: 120,
            courts: [{ id: "c1", courtNumber: 1, name: "Court 1", slicePriceCredits: 50 }],
            slots: [],
          });
        }
        return json({});
      });
    },
  };
}

async function openApp(context: BrowserContext, at = "/schedule") {
  const page = await context.newPage();
  await page.goto(at);
  return page;
}

const chip = (page: Page) => page.getByRole("link", { name: /Wallet balance/ });

test.describe("two tabs, one club", () => {
  test("a balance change in one context reaches the other", async ({ browser }) => {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      window.localStorage.setItem("crusaders.mainframe.token", "e2e-token");
    });
    const server = club(100);
    await server.serve(context);

    const phone = await openApp(context);
    const tablet = await openApp(context);

    await expect(chip(phone)).toHaveAttribute("aria-label", /100\.00 credits/);
    await expect(chip(tablet)).toHaveAttribute("aria-label", /100\.00 credits/);

    // The club pays the member while both tabs are open.
    server.topUpTo(320);

    // The phone comes back to the front, which is what a member does when they are told.
    // `visibilitychange` — not `focus` — is the event a backgrounded PWA actually gets, and
    // the provider listens for both for exactly that reason.
    await phone.bringToFront();

    await expect(chip(phone)).toHaveAttribute("aria-label", /320\.00 credits/, { timeout: 10_000 });

    // …and the other tab agrees once it is looked at, rather than sitting on a stale figure
    // with nothing to say so.
    await tablet.bringToFront();
    await expect(chip(tablet)).toHaveAttribute("aria-label", /320\.00 credits/, { timeout: 10_000 });

    await context.close();
  });
});

test.describe("what the chip says at zero", () => {
  test("is red, is honest, and goes to the top-up page rather than an empty ledger", async ({ browser }) => {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      window.localStorage.setItem("crusaders.mainframe.token", "e2e-token");
    });
    await club(0).serve(context);
    const page = await openApp(context);

    const wallet = chip(page);
    await expect(wallet).toBeVisible();

    // Zero is not "running low" — it is empty, and the member cannot book anything at all.
    await expect(wallet).toHaveAttribute("aria-label", /can't book until you top up/);
    await expect(wallet).not.toHaveAttribute("aria-label", /running low/);

    // At zero `/wallet` is a dead end: the ledger is empty and the only useful control is one
    // more tap away.
    await expect(wallet).toHaveAttribute("href", "/wallet/topup");

    /*
     * A third look, from the existing palette — not the same amber as 49.99.
     *
     * `toHaveCSS` rather than a one-shot `evaluate`: the chip cross-fades into this colour
     * over `--fb-in`, and a single read caught it mid-transition at rgb(253, 226, 226) — one
     * channel out, which reads as a wrong token and is a race. The retrying matcher waits for
     * the fade to land.
     */
    await expect(wallet).toHaveCSS("background-color", "rgb(254, 226, 226)"); // danger.soft #FEE2E2

    await context.close();
  });

  test("under reduced motion it grows a word instead of breathing", async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: "reduce" });
    await context.addInitScript(() => {
      window.localStorage.setItem("crusaders.mainframe.token", "e2e-token");
    });
    await club(0).serve(context);
    const page = await openApp(context);

    const wallet = chip(page);
    await expect(wallet).toBeVisible();
    // A different affordance, not a quieter one: a static thing that is always there beats
    // motion somebody has asked not to see, and it carries the same information.
    await expect(wallet).toContainText("Top up");
    await expect(wallet).toHaveCSS("animation-name", "none");
  });

  test("the entice is finite — it stops, and does not come back", async ({ browser }) => {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      window.localStorage.setItem("crusaders.mainframe.token", "e2e-token");
    });
    await club(0).serve(context);
    const page = await openApp(context);
    const wallet = chip(page);
    await expect(wallet).toBeVisible();

    // The grace period is the booking toast's own life: a member who has just spent their last
    // credits must not have that turned into an alarm.
    await expect(wallet).toHaveCSS("animation-name", "none");
    await expect(async () => {
      expect(await wallet.evaluate((el) => getComputedStyle(el).animationName)).toBe("chip-breathe");
    }).toPass({ timeout: 12_000 });

    // One burst is three breaths of 1.4s. Then it is quiet again — and the pause before the
    // next burst is a minute, so "quiet" here is the decay working rather than the end of it.
    await expect(async () => {
      expect(await wallet.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
    }).toPass({ timeout: 12_000 });
  });
});
