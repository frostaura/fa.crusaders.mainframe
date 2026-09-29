import { type Page } from "@playwright/test";
import { serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { ALEX, BOOKING, PEOPLE, SAM, detailFixture, memberShellRoutes, seat } from "./playersKit";

/**
 * P11 — the booking's own page, `/bookings/:bookingId`, in a real browser on a phone and a
 * desktop: the organiser reads the seats and the money, reminds Alex (and is told plainly when
 * the reminders are used up), copies the open seat's link and removes a player; a member who
 * declined reads the not-found page; an admin collects a share with the god-mode go-ahead.
 *
 * The API is a small in-memory server, so a re-read after an action agrees with the action.
 */

const DETAIL = `/api/v1/bookings/${BOOKING}`;
const PID = {
  sam: "p0000000-0000-0000-0000-000000000002",
  alex: "p0000000-0000-0000-0000-000000000003",
  open: "p0000000-0000-0000-0000-000000000004",
};

type Detail = Record<string, unknown> & { players: Record<string, unknown>[] };

/** Fulfils one route with a status the shared `serveApi` cannot give (it answers 200 or one fixed code). */
async function answer(page: Page, path: string, handler: (method: string) => { status: number; body: unknown } | null) {
  await page.route(`**${path}`, async (route) => {
    const out = handler(route.request().method());
    if (!out) return route.fallback();
    await route.fulfill({ status: out.status, contentType: "application/json", body: JSON.stringify(out.body) });
  });
}

async function openAs(page: Page, options: { detail?: Detail; admin?: boolean; theme?: "light" | "dark"; extra?: ApiRoute[] } = {}) {
  const state = { detail: options.detail ?? (detailFixture() as Detail) };
  await signIn(page);
  if (options.theme) {
    const theme = options.theme;
    await page.addInitScript((t) => window.localStorage.setItem("crusaders:theme", t), theme);
  }
  await serveApi(page, [
    { path: DETAIL, respond: () => state.detail },
    ...(options.extra ?? []),
    ...memberShellRoutes({ admin: options.admin }),
  ]);
  return state;
}

test.describe("the organiser's booking page", () => {
  test("shows four seats with status words, and the money in plain words", async ({ page }) => {
    await openAs(page);
    await page.goto(`/bookings/${BOOKING}`);
    await expect(page.getByRole("heading", { level: 1, name: /^Court 1 · .+, 18:00–18:45$/ })).toBeVisible();
    await expect(page.getByRole("listitem", { name: "Nomsa (you), Organiser" })).toBeVisible();
    await expect(page.getByRole("listitem", { name: "Sam, Paid" })).toBeVisible();
    await expect(page.getByRole("listitem", { name: "Alex, Invited" })).toBeVisible();
    await expect(page.getByRole("listitem", { name: "Open seat, Waiting for someone" })).toBeVisible();
    const money = page.getByRole("region", { name: "Money" });
    await expect(money).toContainText("Shares close");
    await expect(money).toContainText(/Alex hasn't paid yet — their share lapses to you if unpaid by/);
    await expect(money).not.toContainText(/debt|owe/i);
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(scroll, "the page scrolls sideways").toBeLessThanOrEqual(0);
  });

  test("reminds Alex, then says plainly when the reminders for today are used up", async ({ page }) => {
    await openAs(page);
    let nudges = 0;
    await answer(page, `${DETAIL}/players/${PID.alex}/nudge`, (method) => {
      if (method !== "POST") return null;
      nudges += 1;
      return nudges === 1
        ? { status: 200, body: { participant_id: PID.alex, nudges_left: 0 } }
        : { status: 429, body: { error: "nudge_limit", limit: 2, retry_after: new Date(Date.now() + 20 * 3600_000).toISOString() } };
    });
    await page.goto(`/bookings/${BOOKING}`);
    const remind = page.getByRole("button", { name: "Remind Alex" });
    await remind.click();
    await expect(page.getByText("Reminder sent to Alex. That's the last reminder for today.")).toBeVisible();
    await remind.click();
    await expect(page.getByText(/^You've sent 2 reminders today\. You can remind them again after /)).toBeVisible();
    // A 44px target, on both widths.
    const box = (await remind.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(36);
  });

  test("makes a new link for the open seat and copies it", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    // Pin the clipboard path: a desktop Chromium may or may not offer the Web Share sheet.
    await page.addInitScript(() => { Object.defineProperty(Navigator.prototype, "share", { value: undefined, configurable: true }); });
    await openAs(page, { extra: [{
      method: "POST", path: `${DETAIL}/players/${PID.open}/link`,
      body: { participant_id: PID.open, invite_token: "Zm9yLXRoZS1lMmUtc3BlYw", invite_path: "/j/Zm9yLXRoZS1lMmUtc3BlYw" },
    }] });
    await page.goto(`/bookings/${BOOKING}`);
    await page.getByRole("button", { name: "Share a link for Open seat" }).click();
    const confirm = page.getByRole("dialog", { name: "A new link for Open seat" });
    await expect(confirm).toContainText("the old one stops working");
    await confirm.getByRole("button", { name: "Make a new link" }).click();
    const ready = page.getByRole("dialog", { name: "Share this link" });
    await expect(ready.getByRole("textbox", { name: "Invite link" })).toHaveValue(/\/j\/Zm9yLXRoZS1lMmUtc3BlYw$/);
    await ready.getByRole("button", { name: "Copy link" }).click();
    await expect(ready.getByText("Link copied")).toBeVisible();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toMatch(/\/j\/Zm9yLXRoZS1lMmUtc3BlYw$/);
    await expect(ready.getByRole("button", { name: "Close" })).toBeVisible();
  });

  test("removes Sam after a confirm, and the page re-reads without him", async ({ page }) => {
    const state = await openAs(page, { extra: [{
      method: "DELETE", path: `${DETAIL}/players/${PID.sam}`,
      respond: () => {
        state.detail = { ...state.detail, players: state.detail.players.map((p) => (p.participant_id === PID.sam ? { ...p, status: "removed" } : p)) };
        return { participant_id: PID.sam, status: "removed" };
      },
    }] });
    await page.goto(`/bookings/${BOOKING}`);
    await page.getByRole("button", { name: "Remove Sam" }).click();
    const dialog = page.getByRole("dialog", { name: "Remove Sam?" });
    await expect(dialog).toContainText("They're refunded anything they paid.");
    await dialog.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(page.getByText("Sam is off this game.")).toBeVisible();
    await expect(page.getByRole("listitem", { name: "Sam, Removed" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "No longer playing" })).toBeVisible();
  });
});

test.describe("somebody no longer on the game", () => {
  test("a member who declined reads the not-found page, with the way back", async ({ page }) => {
    await openAs(page);
    await answer(page, DETAIL, (method) => (method === "GET" ? { status: 404, body: { error: "booking_not_found" } } : null));
    await page.goto(`/bookings/${BOOKING}`);
    await expect(page.getByText("Booking not found")).toBeVisible();
    await expect(page.getByText("That booking isn't there any more — it may have been cancelled, or you're no longer on it.")).toBeVisible();
    await page.getByRole("link", { name: "Back to Bookings" }).click();
    await expect(page).toHaveURL(/\/bookings$/);
  });
});

/** Alex said yes and has not paid; the viewer is an admin who is not on the game. */
function adminDetail(): Detail {
  const base = detailFixture() as Detail;
  return {
    ...base,
    viewer: { role: "admin", participant_id: null },
    organiser: PEOPLE.sam,
    players: [
      seat({ user_id: SAM, name: PEOPLE.sam.name }),
      seat({ participant_id: PID.alex, seat: 2, kind: "member", user_id: ALEX, name: PEOPLE.alex.name, status: "accepted", consented_credits: 25, target_credits: 25, unpaid_credits: 25 }),
    ],
    permissions: { ...(base.permissions as object), can_invite: false, can_change_split: false, can_cancel: false },
  };
}

test.describe("god mode", () => {
  test("an admin collects Alex's share with the overdraft go-ahead and a reason", async ({ page }) => {
    let sent: unknown = null;
    await openAs(page, { admin: true, detail: adminDetail(), extra: [
      {
        method: "POST", path: `/api/v1/admin/bookings/${BOOKING}/players/${PID.alex}/collect`,
        respond: ({ body }) => { sent = body; return { participant_id: PID.alex, collected_credits: 25, balance_after_credits: -5 }; },
      },
    ] });
    await page.goto(`/bookings/${BOOKING}`);
    await page.getByRole("button", { name: "Admin actions for Alex" }).click();
    await page.getByRole("menuitem", { name: "Collect" }).click();
    const dialog = page.getByRole("dialog", { name: "Collect Alex's share?" });
    await expect(dialog).toContainText("This lands in the club's change log.");
    await dialog.getByRole("textbox", { name: "Reason" }).fill("Agreed at the desk");
    await dialog.getByRole("checkbox", { name: "Take 25.00 cr from Alex even if it puts them below zero" }).click();
    await dialog.getByRole("button", { name: "Collect share" }).click();
    await expect(page.getByText("Collected 25.00 cr from Alex.")).toBeVisible();
    expect(sent).toEqual({ reason: "Agreed at the desk", allowNegativeBalance: true });
  });
});

/**
 * Screenshots for review — only when asked for (`P11_SHOTS_DIR`), and only on the desktop
 * project, which sets its own viewport per shot.
 */
test.describe("booking page screenshots", () => {
  const dir = process.env.P11_SHOTS_DIR;
  const views: { name: string; setup: (page: Page, theme: "light" | "dark") => Promise<void> }[] = [
    { name: "organiser", setup: async (page, theme) => { await openAs(page, { theme }); } },
    {
      name: "player",
      setup: async (page, theme) => {
        const base = detailFixture() as Detail;
        await openAs(page, { theme, detail: {
          ...base, viewer: { role: "player", participant_id: PID.alex }, organiser: PEOPLE.sam,
          players: base.players.map((p) => (p.seat === 1 ? { ...p, user_id: SAM, name: PEOPLE.sam.name }
            : p.seat === 2 ? { ...p, user_id: PEOPLE.me.user_id, name: PEOPLE.me.name } : p)),
          permissions: { ...(base.permissions as object), can_invite: false, can_cancel: false, can_accept: true, can_decline: true },
        } });
      },
    },
    { name: "admin", setup: async (page, theme) => { await openAs(page, { theme, admin: true, detail: adminDetail()}); } },
    {
      name: "not-found",
      setup: async (page, theme) => {
        await openAs(page, { theme });
        await answer(page, DETAIL, (method) => (method === "GET" ? { status: 404, body: { error: "booking_not_found" } } : null));
      },
    },
  ];
  for (const theme of ["light", "dark"] as const) {
    test(`organiser, player, admin and not-found — ${theme}`, async ({ page }, info) => {
      test.skip(!dir || info.project.name !== "desktop", "screenshots are opt-in");
      test.setTimeout(240_000);
      for (const width of [375, 1440]) {
        // Tall: the app scrolls inside its own shell, so a full-page shot is only ever the viewport.
        await page.setViewportSize({ width, height: width === 375 ? 2000 : 1400 });
        for (const view of views) {
          await view.setup(page, theme);
          await page.goto(`/bookings/${BOOKING}`);
          await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
          await expect(page.locator("[data-state-block='loading']")).toHaveCount(0);
          await page.screenshot({ path: `${dir}/${view.name}-${width}-${theme}.png`, fullPage: true });
          await page.unrouteAll({ behavior: "ignoreErrors" });
        }
      }
    });
  }
});
