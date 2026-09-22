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
  amountCredits: Math.abs(signed),
  signedAmountCredits: signed,
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
      body: { balance_credits: 274.25, entries: LEDGER, total_entries: LEDGER.length, offset: 0, limit: 50 },
    },
    {
      path: "/api/v1/me/profile",
      body: {
        full_name: "Nomsa Khumalo", email: "n@test.local", photo_url: null,
        membership_number: "P-1", member_class: "Regular",
      },
    },
  ]);

  await page.goto("/wallet");
  await expect(page.getByRole("region", { name: "Wallet ledger" })).toBeVisible();

  // The three columns that survive the sm breakpoint. From and To are deliberately dropped on a
  // phone (the counterparty rides under the amount instead), so they are not expected here.
  for (const header of ["Time", "Amount", "Comment"]) {
    await expect(page.getByRole("button", { name: header, exact: true })).toBeVisible();
  }

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
  // U+2212 MINUS, not a hyphen — `formatSignedMoney` uses it so a debit lines up under a
  // credit in the tabular-nums column.
  await expect(page.getByText("+1600.00 cr", { exact: false })).toBeVisible();
  await expect(page.getByText("\u22121250.75 cr", { exact: false })).toBeVisible();
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
      body: { balance_credits: 274.25, entries: LEDGER, total_entries: LEDGER.length, offset: 0, limit: 50 },
    },
    {
      path: "/api/v1/me/profile",
      body: {
        full_name: "Nomsa Khumalo", email: "n@test.local", photo_url: null,
        membership_number: "P-1", member_class: "Regular",
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
// A10 / C14 / D6 / A20 — the app header, zoomed and enlarged.
//
// Reviewer A ran the console at 200 % browser zoom on a 360 px phone and the header cluster
// overflowed: the whole document scrolled sideways and the GEAR — the only route to Doors
// and to Sign out — went off the right edge. Reviewer D hit the same row from the other
// direction, at a 32 px root font size, where every rem-based length in it doubles.
//
// Zoom is emulated by the CSS viewport it produces rather than by a device scale factor:
// 200 % zoom at 1280 IS a 640 px CSS viewport, which is the thing layout actually responds
// to, and it is reproducible without asking the browser to zoom itself.
//
// jsdom cannot see any of this — every getBoundingClientRect there is zero — which is why
// these live here and not beside the class assertions in
// `src/components/layout-chrome.test.tsx`.
// ---------------------------------------------------------------------------------------

/** The header's own contents, plus the document, plus where the gear actually ended up. */
async function headerGeometry(page: Page) {
  return page.evaluate(() => {
    const gear = document.querySelector<HTMLElement>('header button[aria-haspopup="menu"]');
    const box = gear?.getBoundingClientRect();
    const header = document.querySelector<HTMLElement>("header")!;
    return {
      innerWidth: window.innerWidth,
      rootFontSize: getComputedStyle(document.documentElement).fontSize,
      docScrollWidth: document.documentElement.scrollWidth,
      docClientWidth: document.documentElement.clientWidth,
      headerScrollWidth: header.scrollWidth,
      headerClientWidth: header.clientWidth,
      gear: box ? { left: box.left, right: box.right, width: box.width, height: box.height } : null,
    };
  });
}

/** An admin session with one shut door, so the club-wide banner is on screen at these sizes too. */
async function serveAdminChrome(page: Page) {
  await signIn(page);
  await serveApi(page, [
    { path: "/api/v1/whoami", body: SESSION_ADMIN },
    { path: "/api/v1/admin/members", body: [] },
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
      body: { balance_credits: 1600, entries: [], total_entries: 0, offset: 0, limit: 50 },
    },
    {
      path: "/api/v1/me/profile",
      body: {
        full_name: "Nomsa Khumalo", email: "n@test.local", photo_url: null,
        membership_number: "P-1", member_class: "Regular",
      },
    },
  ]);
}

test.describe("the header at 200 % zoom", () => {
  // 1280 at 200 % zoom is a 640 px CSS viewport.
  test.use({ viewport: { width: 640, height: 400 } });

  test("does not scroll the page sideways, and keeps the gear on screen", async ({ page }) => {
    await serveAdminChrome(page);
    await page.goto("/wallet");
    await expect(page.getByRole("button", { name: /Open menu/ })).toBeVisible();

    const geo = await headerGeometry(page);
    expect(geo.docScrollWidth, `document overflowed a ${geo.innerWidth}px viewport`)
      .toBeLessThanOrEqual(geo.docClientWidth + 1);
    expect(geo.headerScrollWidth).toBeLessThanOrEqual(geo.headerClientWidth + 1);

    // The gear is the point of the finding: the only route to Doors and to Sign out, and
    // the thing the right edge sliced.
    expect(geo.gear).not.toBeNull();
    expect(geo.gear!.left).toBeGreaterThanOrEqual(-1);
    expect(geo.gear!.right).toBeLessThanOrEqual(geo.innerWidth + 1);
  });
});

test.describe("the header at 200 % zoom on a phone", () => {
  // Reviewer A's own setup, and the harshest width this chrome is ever asked for: a 360 px
  // phone at 200 % zoom is a 180 px CSS viewport. The gear alone is 44 px of it.
  test.use({ viewport: { width: 180, height: 400 } });

  /**
   * <b>This one found the real bug.</b> The 640 px case above passed before this lane's fix
   * as well as after it — 1280 at 200 % is not actually a hard width for this row. 180 px
   * is, and it is the width reviewer A was looking at. Measured before the fix: the
   * right-hand cluster held one 167 px line inside a 148 px content box, the document's
   * scrollWidth was 183 against a 180 px clientWidth, and the gear's right edge sat on 183.
   */
  test("still keeps the gear on screen at 180 CSS pixels", async ({ page }) => {
    await serveAdminChrome(page);
    await page.goto("/wallet");
    await expect(page.getByRole("button", { name: /Open menu/ })).toBeVisible();

    const geo = await headerGeometry(page);
    expect(geo.docScrollWidth, `document overflowed a ${geo.innerWidth}px viewport`)
      .toBeLessThanOrEqual(geo.docClientWidth + 1);
    expect(geo.gear).not.toBeNull();
    expect(geo.gear!.left).toBeGreaterThanOrEqual(-1);
    expect(geo.gear!.right).toBeLessThanOrEqual(geo.innerWidth + 1);
  });
});

test.describe("the header at 360 px with large text", () => {
  test.use({ viewport: { width: 360, height: 780 } });

  /**
   * D6's header half. A 32 px root font size is the browser's own large-text setting, and
   * every length in this row was rem-based, so the cluster doubled while the screen did not.
   */
  test("does not scroll the page sideways at a 32px root font size", async ({ page }) => {
    await serveAdminChrome(page);
    await page.goto("/wallet");
    await expect(page.getByRole("button", { name: /Open menu/ })).toBeVisible();

    await page.evaluate(() => { document.documentElement.style.fontSize = "32px"; });
    // A frame, so the reflow that font-size change causes has actually happened.
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => done(null))));

    const geo = await headerGeometry(page);
    expect(geo.rootFontSize).toBe("32px");
    expect(geo.docScrollWidth, `document overflowed a ${geo.innerWidth}px viewport at a 32px root`)
      .toBeLessThanOrEqual(geo.docClientWidth + 1);
    expect(geo.gear).not.toBeNull();
    expect(geo.gear!.right).toBeLessThanOrEqual(geo.innerWidth + 1);
    // And it is still 44 px, rather than the 88 px the rem form produced.
    expect(Math.round(geo.gear!.width)).toBe(44);
    expect(Math.round(geo.gear!.height)).toBe(44);
  });
});

test.describe("the six admin tabs at lg", () => {
  // 1024 is exactly where the inline nav switches on, so it is the width at which a sixth
  // tab either fits or does not. A20's whole condition was that it must not re-buy the
  // 795px-against-768 defect the `lg` breakpoint exists to have fixed.
  test.use({ viewport: { width: 1024, height: 800 } });

  test("fit the header row without putting the page into sideways scroll", async ({ page }) => {
    await serveAdminChrome(page);
    await page.goto("/wallet");
    await expect(page.getByRole("button", { name: /Open menu/ })).toBeVisible();

    const tabs = await page.evaluate(() => {
      const nav = document.querySelector<HTMLElement>("header nav:not([aria-label])")!;
      const links = [...nav.querySelectorAll<HTMLElement>("a")];
      const row = nav.parentElement!;
      const used = [...row.children]
        .filter((c) => getComputedStyle(c as HTMLElement).display !== "none")
        .reduce((total, c) => total + c.getBoundingClientRect().width, 0);
      return {
        // The pathname, not the text: a tab's textContent carries its badge's digits too
        // ("Doors1" while a door needs attention), which makes a text match a match on the
        // fixture's state rather than on the tab being present at all.
        destinations: links.map((a) => new URL(a.href).pathname),
        // One line, not two: every tab shares the first tab's top edge.
        tops: [...new Set(links.map((a) => Math.round(a.getBoundingClientRect().top)))],
        navVisible: getComputedStyle(nav).display !== "none",
        navWidth: Math.round(nav.getBoundingClientRect().width),
        // What the row's own content box has to give, and what its children take.
        rowContentWidth: Math.round(row.clientWidth - 32),
        rowUsedWidth: Math.round(used),
      };
    });
    expect(tabs.navVisible).toBe(true);
    // D3 §3.1 — the sixth tab is Monitoring now; Doors is a destination inside it. Still six
    // tabs, still the width at which a sixth either fits or does not, which is what A20's
    // condition was about.
    expect(tabs.destinations).toContain("/admin/monitoring");
    expect(tabs.destinations).toHaveLength(6);
    expect(tabs.tops, "the admin tabs wrapped onto a second line").toHaveLength(1);

    const geo = await headerGeometry(page);
    // Printed rather than only asserted: the 795-against-768 number in `Layout.tsx`'s nav
    // comment is the reason this breakpoint is where it is, and the sixth tab's equivalent
    // number is what a future reader will want when they consider a seventh.
    // eslint-disable-next-line no-console -- the measurement IS the point of this test
    console.log(`[A20] six admin tabs at 1024: nav ${tabs.navWidth}px, row uses ${tabs.rowUsedWidth}px of ${tabs.rowContentWidth}px; header scrollWidth ${geo.headerScrollWidth} vs clientWidth ${geo.headerClientWidth}; document ${geo.docScrollWidth} vs ${geo.docClientWidth}`);
    // Slack, stated as a number. A row that fits by two pixels fits until somebody renames
    // a tab, and the whole reason this test exists is that exactly that happened at 768.
    expect(tabs.rowUsedWidth).toBeLessThan(tabs.rowContentWidth);
    expect(geo.docScrollWidth).toBeLessThanOrEqual(geo.docClientWidth + 1);
    expect(geo.headerScrollWidth).toBeLessThanOrEqual(geo.headerClientWidth + 1);
  });
});

test.describe("the header's touch targets", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  /**
   * C16 — the tabs, the avatar and the wallet chip were all 36 px tall, which is under every
   * touch-target minimum there is. The increase is gated on `(pointer: coarse)`, so this
   * asserts what the pointer the test is actually running with should produce: 44 px under
   * the mobile project, the unchanged 36 px under the desktop one. A test that asserted 44
   * everywhere would be asserting a rule this deliberately does not apply.
   */
  test("are 44 px wherever the pointer is a fingertip", async ({ page }) => {
    await serveAdminChrome(page);
    await page.goto("/wallet");
    await expect(page.getByRole("button", { name: /Open menu/ })).toBeVisible();

    const measured = await page.evaluate(() => {
      const height = (el: Element | null) => (el ? Math.round(el.getBoundingClientRect().height) : null);
      const strip = document.querySelector<HTMLElement>('header nav[aria-label="Sections"]')!;
      return {
        coarse: window.matchMedia("(pointer: coarse)").matches,
        tab: height(strip.querySelector("a")),
        avatar: height(document.querySelector('header a[aria-label="Edit profile"]')),
        wallet: height(document.querySelector('header a[aria-label^="Wallet balance"]')),
        gear: height(document.querySelector('header button[aria-haspopup="menu"]')),
      };
    });

    const expected = measured.coarse ? 44 : 36;
    expect(measured.tab).toBe(expected);
    expect(measured.avatar).toBe(expected);
    expect(measured.wallet).toBe(expected);
    // The gear is 44 px at every pointer: it is the control that must never be the small one.
    expect(measured.gear).toBe(44);
  });
});
