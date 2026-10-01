import type { Page } from "@playwright/test";
import { SESSION_ADMIN, serveApi, signIn, test, expect } from "./fixtures";

/**
 * E-F18 — the wallet ledger on a 375px phone.
 *
 * <p>
 * The finding was that the Amount column — the one figure a member opens their wallet to read —
 * sat off the right edge at 375px with nothing to say it was there. Two rounds of fixes went in
 * on the strength of the second half of that claim (the missing affordance, now `ScrollArea`)
 * while the first half was never measured: the columns were already responsive, and no run in
 * either round opened the page at 375px and looked.
 * </p>
 *
 * <p>
 * So this measures. It is a browser test rather than a jsdom one because jsdom has no layout
 * engine at all — every `getBoundingClientRect` there is zero, so a unit test literally cannot
 * see this class of defect, which is why the original claim survived two rounds unsettled.
 * </p>
 */

const AT = "2026-09-05T08:15:00Z";

const row = (id: string, signed: number, comment: string) => ({
  id,
  at: AT,
  from: signed >= 0 ? "PayFast top-up" : "Nomsa Khumalo",
  to: signed >= 0 ? "Nomsa Khumalo" : "Court 3 · 18:00",
  amountMinutes: Math.abs(signed),
  signedAmountMinutes: signed,
  type: signed >= 0 ? "TopUp" : "BookingCharge",
  comment,
  subjectUserId: "00000000-0000-0000-0000-000000000002",
  subjectName: "Nomsa Khumalo",
  actorUserId: "00000000-0000-0000-0000-000000000002",
  actorName: "Nomsa Khumalo",
  relatedBookingId: null,
});

const LEDGER = [
  row("1", 1600, "Top-up of R1000.00 at 1.60 credits per rand"),
  row("2", -137.5, "Court 3, 18:00-19:00, peak rate"),
  row("3", -1250.75, "Court 1, 06:00-08:00, off-peak block booking"),
  row("4", 62.5, "Late-cancellation refund less penalty"),
];

test.use({ viewport: { width: 375, height: 812 } });

test("every wallet ledger column a member needs is on screen at 375px", async ({ page }) => {
  await signIn(page);
  await serveApi(page, [
    { path: "/api/v1/whoami", body: SESSION_ADMIN },
    {
      path: "/api/v1/wallet",
      body: { balance_minutes: 274.25, entries: LEDGER, total_entries: LEDGER.length, offset: 0, limit: 50 },
    },
    {
      path: "/api/v1/me/profile",
      body: {
        full_name: "Nomsa Khumalo", email: "n@test.local", photo_url: null,
        membership_number: "P-1",
      },
    },
  ]);

  await page.goto("/wallet");
  await expect(page.getByRole("region", { name: "Wallet ledger" })).toBeVisible();

  // The two columns that survive the sm breakpoint (P3 mobile rows): the movement and the money.
  // From and To fold away (the counterparty rides under the amount), and so does Time — it rides
  // under the comment — so neither is lost, only moved.
  for (const header of ["Comment", "Amount"]) {
    await expect(page.getByRole("button", { name: header, exact: true })).toBeVisible();
  }
  await expect(page.locator("table tbody tr").first().locator("td time")).toBeVisible();

  // The measurement, not an impression: every rendered amount cell must end inside the viewport.
  const overflowing = await page.evaluate(() => {
    const width = window.innerWidth;
    const cells = [...document.querySelectorAll("table tbody tr")].map((tr) => {
      const amount = tr.querySelector<HTMLElement>("td.text-right");
      const box = amount?.getBoundingClientRect();
      return { text: amount?.textContent ?? "", left: box?.left ?? 0, right: box?.right ?? 0 };
    });
    return { width, offScreen: cells.filter((c) => c.right > width + 0.5 || c.left < -0.5), total: cells.length };
  });

  expect(overflowing.total).toBe(LEDGER.length);
  expect(overflowing.offScreen, "amount cells rendered outside the 375px viewport").toEqual([]);

  // And the amounts are readable as text, not merely present in the DOM.
  // U+2212 MINUS, not a hyphen — `formatSignedCredits` uses it so a debit lines up under a
  // credit in the tabular-nums column.
  // `.filter({ visible: true })`: since R5 the amount is also drawn inside the movement's cell for
  // the one-column form (a phone at 200 % text), hidden at this width — one of the two shows.
  await expect(page.getByText("+1600.00 cr", { exact: false }).filter({ visible: true })).toHaveCount(1);
  await expect(page.getByText("\u22121250.75 cr", { exact: false }).filter({ visible: true })).toHaveCount(1);
});

test("the page itself never scrolls sideways at 375px", async ({ page }) => {
  // The other half of the original claim: a table wider than the phone must scroll inside its
  // own region, not drag the whole document sideways. A horizontally scrolling body is how a
  // member loses the header and the navigation as well as the column.
  await signIn(page);
  await serveApi(page, [
    { path: "/api/v1/whoami", body: SESSION_ADMIN },
    {
      path: "/api/v1/wallet",
      body: { balance_minutes: 274.25, entries: LEDGER, total_entries: LEDGER.length, offset: 0, limit: 50 },
    },
    {
      path: "/api/v1/me/profile",
      body: {
        full_name: "Nomsa Khumalo", email: "n@test.local", photo_url: null,
        membership_number: "P-1",
      },
    },
  ]);

  await page.goto("/wallet");
  await expect(page.getByRole("region", { name: "Wallet ledger" })).toBeVisible();

  const doc = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(doc.scrollWidth).toBeLessThanOrEqual(doc.clientWidth + 1);
});

// ---------------------------------------------------------------------------------------
// A10 / C14 / D6 — the app's top bar, zoomed and enlarged (rebuilt in P2).
//
// Reviewer A ran the console at 200 % browser zoom on a 360 px phone and the header overflowed:
// the whole document scrolled sideways and the control that was the only route to Sign out went
// off the right edge. Reviewer D hit the same row at a 32 px root font size. The P2 top bar holds
// the crest, the credits chip and the account menu (the tabs are a fixed bottom bar below `md`);
// the account menu is now that only-route-to-Sign-out control, so it is what is measured.
//
// Zoom is emulated by the CSS viewport it produces: 200 % zoom at 1280 IS a 640 px CSS viewport.
// jsdom cannot see any of this, which is why these live here.
// ---------------------------------------------------------------------------------------

/** The top bar's own contents, plus the document, plus where the account menu ended up. */
async function headerGeometry(page: Page) {
  return page.evaluate(() => {
    const account = document.querySelector<HTMLElement>("header[data-app-header] button[data-account-menu]");
    const box = account?.getBoundingClientRect();
    const header = document.querySelector<HTMLElement>("header[data-app-header]")!;
    return {
      innerWidth: window.innerWidth,
      rootFontSize: getComputedStyle(document.documentElement).fontSize,
      docScrollWidth: document.documentElement.scrollWidth,
      docClientWidth: document.documentElement.clientWidth,
      headerScrollWidth: header.scrollWidth,
      headerClientWidth: header.clientWidth,
      account: box ? { left: box.left, right: box.right, width: box.width, height: box.height } : null,
    };
  });
}

/** An admin session with one shut door, so the club-wide banner is on screen at these sizes too. */
async function serveAdminChrome(page: Page) {
  await signIn(page);
  await serveApi(page, [
    { path: "/api/v1/whoami", body: SESSION_ADMIN },
    { path: "/api/v1/admin/members", body: [] },
    { path: "/api/v1/admin/monitoring/summary", body: { open: {} } },
    {
      path: "/api/v1/admin/doors",
      body: {
        day_started_at: new Date(new Date().setHours(0, 0, 0, 0)).toISOString(),
        timezone: "Africa/Johannesburg",
        shut_all_active: true,
        doors: [{
          device: {
            id: "99999999-9999-9999-9999-999999999999", device_code: "gate-0a1b2c",
            name: "Side door", kind: "Gate", hardware: "Esp32", court_numbers: [],
            gate_key: "side-door", mac_address: "5ccf7f0a1b2c", enabled: false,
            last_seen_at: new Date().toISOString(), last_ip_address: "192.168.68.160",
            running_version: "1.0.0", mega_version: null, auto_registered: false,
            created_at: new Date().toISOString(), location_note: null,
            power_loss_behaviour: "not_established",
            out_of_service_since: new Date().toISOString(),
          },
          today: { released: 0, refused: 0 },
          signals: [],
        }],
      },
    },
    {
      path: "/api/v1/wallet",
      body: { balance_minutes: 1600, entries: [], total_entries: 0, offset: 0, limit: 50 },
    },
    {
      path: "/api/v1/me/profile",
      body: {
        full_name: "Nomsa Khumalo", email: "n@test.local", photo_url: null,
        membership_number: "P-1",
      },
    },
  ]);
}

for (const [label, width] of [["200 % zoom", 640], ["200 % zoom on a phone", 180]] as const) {
  test.describe(`the top bar at ${label}`, () => {
    // 1280 at 200 % is 640 px; reviewer A's own setup, a 360 px phone at 200 %, is 180 px — the
    // harshest width this chrome is ever asked for, and the one that found the real bug.
    test.use({ viewport: { width, height: 400 } });

    test("does not scroll the page sideways, and keeps the account menu on screen", async ({ page }) => {
      await serveAdminChrome(page);
      await page.goto("/wallet");
      await expect(page.getByRole("button", { name: "Account menu" })).toBeVisible();

      const geo = await headerGeometry(page);
      expect(geo.docScrollWidth, `document overflowed a ${geo.innerWidth}px viewport`)
        .toBeLessThanOrEqual(geo.docClientWidth + 1);
      expect(geo.headerScrollWidth).toBeLessThanOrEqual(geo.headerClientWidth + 1);
      expect(geo.account).not.toBeNull();
      expect(geo.account!.left).toBeGreaterThanOrEqual(-1);
      expect(geo.account!.right).toBeLessThanOrEqual(geo.innerWidth + 1);
    });
  });
}

test.describe("the top bar at 360 px with large text", () => {
  test.use({ viewport: { width: 360, height: 780 } });

  /** D6's header half: a 32 px root is the browser's own large-text setting. */
  test("does not scroll the page sideways at a 32px root font size", async ({ page }) => {
    await serveAdminChrome(page);
    await page.goto("/wallet");
    await expect(page.getByRole("button", { name: "Account menu" })).toBeVisible();

    await page.evaluate(() => { document.documentElement.style.fontSize = "32px"; });
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => done(null))));

    const geo = await headerGeometry(page);
    expect(geo.rootFontSize).toBe("32px");
    expect(geo.docScrollWidth, `document overflowed a ${geo.innerWidth}px viewport at a 32px root`)
      .toBeLessThanOrEqual(geo.docClientWidth + 1);
    expect(geo.account).not.toBeNull();
    expect(geo.account!.right).toBeLessThanOrEqual(geo.innerWidth + 1);
    // 44 px in pixels, not the 88 px a rem-sized box would become.
    expect(Math.round(geo.account!.width)).toBe(44);
    expect(Math.round(geo.account!.height)).toBe(44);
  });
});

test.describe("the chrome's touch targets", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  /**
   * C16 — the old tabs, avatar and wallet chip were 36 px, under every touch-target minimum.
   * The tabs are 64 px bottom-bar targets on a phone; the account menu, the crest and the credits
   * chip are 44 px at every pointer.
   */
  test("are a fingertip wherever the pointer is one", async ({ page }) => {
    await serveAdminChrome(page);
    await page.goto("/wallet");
    await expect(page.getByRole("button", { name: "Account menu" })).toBeVisible();

    const measured = await page.evaluate(() => {
      const height = (el: Element | null) => (el ? Math.round(el.getBoundingClientRect().height) : null);
      return {
        tabs: [...document.querySelectorAll('nav[aria-label="Main"] a')].map(height),
        account: height(document.querySelector("header[data-app-header] button[data-account-menu]")),
        crest: height(document.querySelector("header[data-app-header] a[data-crest-link]")),
        wallet: height(document.querySelector('header[data-app-header] a[aria-label^="Wallet balance"]')),
      };
    });

    for (const tab of measured.tabs) expect(tab).toBeGreaterThanOrEqual(64);
    expect(measured.account).toBe(44);
    expect(measured.crest).toBeGreaterThanOrEqual(44);
    expect(measured.wallet).toBe(44);
  });
});
