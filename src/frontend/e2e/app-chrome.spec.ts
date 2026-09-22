import { type Page } from "@playwright/test";
import { SESSION_ADMIN, serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";

/**
 * The application shell: what a navigation does (C6), what the section strip does at a width
 * or a text size nobody designed it at (C16 / E-L4 / C19 / B12), and where a toast lands
 * (B13).
 *
 * <p>
 * All of it is geometry or focus, and none of it is visible to jsdom — which is why a
 * suite of 1 400 unit tests had nothing to say about a document title that was the same
 * string on every route, a focused tab clipped by the right edge at 400 % zoom, or a header
 * that took 54 % of a phone.
 * </p>
 */

const SETTINGS = {
  slice_minutes: 15, slice_price_credits: 8, advance_booking_days: 14,
  day_start_minute: 360, day_end_minute: 1320, penalty_pct: 30,
  grace_window_minutes: 5, penalty_window_minutes: 15, timezone: "Africa/Johannesburg",
  button_map: ["court:A", "court:B", "court:C", "court:D", "minutes:15", "minutes:30", "minutes:45", "off"],
  operating_hours: { mon: "06:00-22:00" },
  credits_per_zar_regular: 1.6, credits_per_zar_league: 2.4,
  topup_block_zar: 100, topup_max_zar_per_member: 1000,
  member_per_day_max_minutes: 60, peak_hours: "16:00-19:00",
  peak_advance_hours_for_regular: 1, retention_years: 2, no_show_lookback_days: 7,
  walk_up_max_minutes: 90, heartbeat_seconds: 60,
  activation_forward_window_minutes: 120, activation_cue_window_minutes: 10,
  qr_lifetime_seconds: 60, roster_window_minutes: 120, device_alert_cooldown_minutes: 60,
  gate_unlock_seconds: 3, gate_access_policy: "active_member", gate_early_entry_minutes: 30,
  door_log_retention_days: 90, door_refusal_spike_count: 8, door_refusal_spike_minutes: 20,
  club_contact_phone: "076 226 1390", club_contact_email: "squash@example.co.za",
};

/**
 * A balance of ZERO on purpose. B12's wallet-chip half is that the chip truncated the
 * figure to "0…" at a 32 px root font size — the shortest number the club can show, cut in
 * half by the box that exists to show it.
 */
function routes(extra: ApiRoute[] = []): ApiRoute[] {
  return [
    { path: "/api/v1/whoami", body: SESSION_ADMIN },
    { path: "/api/v1/me/profile", body: { full_name: "Crusaders Admin", email: "admin@sample.local", photo_url: null, membership_number: "ADMIN-0001", member_class: "Regular" } },
    { path: "/api/v1/wallet", body: { balance_credits: 0, entries: [], total_entries: 0, offset: 0, limit: 50 } },
    { path: "/api/v1/admin/settings/", body: SETTINGS },
    { path: "/api/v1/admin/courts/", body: [] },
    { path: "/api/v1/admin/members", body: [] },
    { path: "/api/v1/admin/doors", body: { doors: [], shut_together: [], shut_individually: [], timezone: "Africa/Johannesburg" } },
    ...extra,
  ];
}

/**
 * A MEMBER's session, which is a different chrome: three section tabs where an admin has six,
 * no doors badge, no gear menu items. B12 is a measurement, so the two cannot stand in for
 * each other.
 */
function memberRoutes(): ApiRoute[] {
  return [
    { path: "/api/v1/whoami", body: { ...SESSION_ADMIN, is_admin: false } },
    { path: "/api/v1/me/profile", body: { full_name: "Lerato Mokoena", email: "lerato@sample.local", photo_url: null, membership_number: "M-0001", member_class: "Regular" } },
    { path: "/api/v1/wallet", body: { balance_credits: 500, entries: [], total_entries: 0, offset: 0, limit: 50 } },
    {
      path: "/api/v1/me/qr/generate",
      body: {
        code: "7K3M9XQ2RD5A", kind: "booking", expires_in_seconds: 900, court_number: 3,
        starts_at: "2099-01-01T17:00:00Z", doors: true,
        door_opens_at: "2099-01-01T16:30:00Z", door_closes_at: "2099-01-01T18:05:00Z",
      },
    },
    {
      path: "/api/v1/me/door",
      body: {
        doors: true, doors_shut: "none", timezone: "Africa/Johannesburg", policy: "booking_window",
        membership: "active", membership_detail: "active", is_club_admin: false, next_booking: null,
        early_entry_minutes: 30, roster_max_entries: 48,
        contact: { phone: "021 555 0134", email: "info@crusaders.co.za" },
        door_log_retention_days: 90, last_decision: null,
      },
    },
    { path: "/api/v1/me/door/history", body: { items: [], next_cursor: null, retention_days: 90, timezone: "Africa/Johannesburg" } },
  ];
}

async function openAdmin(page: Page, path: string, rootPx = 0) {
  await signIn(page);
  await serveApi(page, routes());
  await page.goto(path);
  await expect(page.getByRole("button", { name: /Open menu/ })).toBeVisible();
  if (rootPx > 0) await page.addStyleTag({ content: `html { font-size: ${rootPx}px; }` });
}

test.describe("C6 — what a navigation does", () => {
  /**
   * Reviewer C measured this on seven routes: `document.title` was "Crusaders Mainframe"
   * everywhere, focus went to `&lt;body&gt;`, and nothing was announced. To a screen-reader
   * user a single-page app that does that has not navigated at all — the reader is still
   * where it was, on a document whose content has silently been replaced underneath it.
   */
  test("retitles the document, announces the page and lands focus on its heading", async ({ page }) => {
    await openAdmin(page, "/admin/settings");
    await expect(page).toHaveTitle("Admin settings — Crusaders Mainframe");

    // D3 §3.1 — Doors left the gear menu for the Monitoring section, so the navigation under
    // test is the tab rather than the menu item. What is being measured is unchanged: a title,
    // an announcement, and focus landing on the new page's own h1.
    /*
     * The VISIBLE Monitoring link, whichever nav is rendering it.
     *
     * The chrome carries two copies of the section tabs — an inline nav above `lg` and the
     * scrolling strip below it — and the hidden one is still in the DOM. Scoping to the strip
     * passed on mobile and timed out on desktop waiting for a link that is `display: none`
     * there. The href is the same in both copies and `:visible` picks whichever is on screen.
     */
    await page.locator('header a[href="/admin/monitoring"]:visible').first().click();

    await expect(page).toHaveTitle("Control board — Crusaders Mainframe");
    await expect(page.getByTestId("route-announcer")).toHaveText("Control board");
    // Focus is on the page's own h1, not on <body> and not on the link that was pressed.
    const focused = await page.evaluate(() => ({
      tag: document.activeElement?.tagName,
      text: (document.activeElement as HTMLElement | null)?.innerText?.slice(0, 40),
    }));
    expect(focused.tag).toBe("H1");

    // Back, and the title follows: a browser-history entry is named after the title it had.
    await page.goBack();
    await expect(page).toHaveTitle("Admin settings — Crusaders Mainframe");
  });

  /**
   * C15 / D9's shell half. A fragment used to scroll and leave focus at the top of the
   * document, and the heading it scrolled to landed underneath the sticky header — measured
   * at y = −29 and y = −335 on `/profile#door-history`. The `scroll-margin-top` is what
   * clears the header; the focus is what makes the jump mean anything to the person it is for.
   */
  test("focuses a fragment's heading and keeps it clear of the sticky header", async ({ page }) => {
    await openAdmin(page, "/admin/settings");

    await page.getByRole("link", { name: "Door gates" }).click();

    const heading = page.getByRole("heading", { name: "Door gates" });
    await expect(heading).toBeFocused();
    const geometry = await page.evaluate(() => {
      const h = [...document.querySelectorAll("h2")].find((n) => n.textContent === "Door gates")!;
      const header = document.querySelector("header")!;
      return { headingTop: h.getBoundingClientRect().top, headerBottom: header.getBoundingClientRect().bottom };
    });
    expect(geometry.headingTop).toBeGreaterThanOrEqual(geometry.headerBottom);
  });
});

test.describe("C16 / E-L4 / C19 — the section strip", () => {
  /**
   * At 400 % zoom reviewer C tabbed to "Members" and it was clipped by the right edge: the
   * strip scrolls sideways, the focus ring was inside it, and nothing told the strip to
   * move. At 390 px reviewer E found "Doors" off-screen for the same reason. A 1280×900
   * screen at 400 % zoom is a 320×225 CSS viewport, which is what this is.
   */
  for (const size of [{ label: "360 px", width: 360, height: 640 }, { label: "400 % zoom", width: 320, height: 225 }]) {
    test(`brings every tab into view as focus reaches it at ${size.label}`, async ({ page }) => {
      await page.setViewportSize(size);
      await openAdmin(page, "/admin/settings");

      const strip = page.locator('header nav[aria-label="Sections"]');
      await expect(strip).toBeVisible();
      const tabs = strip.getByRole("link");
      const count = await tabs.count();
      expect(count).toBe(6);

      for (let i = 0; i < count; i += 1) {
        const tab = tabs.nth(i);
        await tab.focus();
        const name = await tab.innerText();
        // `toBeInViewport` with a ratio, because "partly on screen" is the failure: the
        // measured defect was a tab whose right-hand half was past the edge.
        await expect(tab, `the ${name} tab is clipped at ${size.label}`).toBeInViewport({ ratio: 0.99 });
      }

      // E-L4 named Doors specifically — the sixth tab, the one that was off the end. It is
      // Monitoring now (D3 §3.1); still sixth, still the one this test exists for. The admin
      // lane's "either spelling" hedge was written against a chrome that had not landed yet;
      // it has, so this pins the one destination rather than tolerating two.
      await expect(strip.getByRole("link", { name: /^Monitoring/ })).toHaveAttribute("href", "/admin/monitoring");
    });
  }

  /**
   * C19 — the strip's own container was a tab stop that reached nothing. On a phone it was
   * the second stop on every route, it announced itself as a region, and the next Tab landed
   * on the first tab anyway. It became useless the moment each tab started scrolling itself
   * into view; before that it was the only way to reach the ones off the end.
   */
  test("is not itself a tab stop", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    await openAdmin(page, "/admin/settings");

    const region = page.getByRole("region", { name: "Section tabs" });
    await expect(region).toBeVisible();
    await expect(region).not.toHaveAttribute("tabindex", /.*/);
  });
});

test.describe("B12 — the chrome at a large root font size", () => {
  /**
   * Reviewer B measured the header plus the tab strip at 54 % of a 320×568 screen with a
   * 32 px root font. Every box in that row was sized in `rem`, so a 44 px touch target
   * became an 88 px one and the page the chrome exists to get you to had less than half the
   * phone. The text still scales; the boxes stop at the size a fingertip needs.
   */
  test("leaves the page at least 60 % of a 320×568 screen", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await openAdmin(page, "/admin/settings", 32);

    const share = await page.evaluate(() => {
      const header = document.querySelector("header")!.getBoundingClientRect().height;
      return { header, content: (window.innerHeight - header) / window.innerHeight };
    });
    console.log(`[B12] header+strip ${Math.round(share.header)}px of 568; content ${(share.content * 100).toFixed(1)}%`);
    expect(share.content).toBeGreaterThanOrEqual(0.6);
  });

  /**
   * And the rule underneath the percentage: <b>the text scales, the boxes do not</b>.
   *
   * <p>
   * Found by mutation. Putting the header row's paddings and gaps back into `rem`, and putting
   * the tab strip's touch minimum back to `h-11`, each left the test above green — at 60.2 %,
   * which is inside a 60 % bar by two tenths of a point. A threshold the shipped code clears by
   * eight points and a regression clears by nothing is a threshold that will be crossed by the
   * change after next, silently, and the reviewer's finding will be back.
   * </p>
   *
   * <p>
   * So this measures the mechanism rather than the symptom. Every box in the chrome is sized in
   * pixels precisely so that doubling the root font size grows the header by the height of its
   * TEXT and nothing else: measured on a 320 px phone, 154 px at a 16 px root and 182 px at a
   * 32 px one. In `rem` the whole row doubles — 44 px touch targets become 88 px ones — and the
   * growth is two and a half times that. The bound is set with room for a genuine text change
   * and none for a unit change.
   * </p>
   */
  test("grows only by its text when the root font size doubles", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await openAdmin(page, "/admin/settings");

    const heightAt = async (rootPx: number) => {
      await page.addStyleTag({ content: `html { font-size: ${rootPx}px !important; }` });
      return page.evaluate(() => document.querySelector("header")!.getBoundingClientRect().height);
    };

    const small = await heightAt(16);
    const large = await heightAt(32);
    const growth = large - small;
    console.log(`[B12] header ${Math.round(small)}px at a 16px root, ${Math.round(large)}px at 32px — grew ${Math.round(growth)}px`);
    expect(growth, `the chrome grew ${Math.round(growth)}px for a doubling of the text: its boxes are scaling, not just its words`)
      .toBeLessThanOrEqual(45);
  });

  /**
   * And on the MEMBER route, which is where the finding actually bites.
   *
   * <p>
   * Every case above signs in as an admin and measures `/admin/settings`, which is a page of
   * fields: chrome taking a third of it is ugly and costs nothing you cannot scroll to.
   * `/my-code` is the screen a member holds up to a scanner, its QR is about 254 px, and the
   * question is whether the page has room to put one on the glass. It is also a DIFFERENT
   * measurement — a member has three section tabs where an admin has six — so the admin number
   * does not stand in for it.
   * </p>
   *
   * <p>
   * Measured at a 32 px root on a 320×568 phone, against the 44 px targets a coarse pointer
   * gets: 234 px of chrome and 334 px of page before the club name stopped padding itself to a
   * size its own text already exceeded, 214 and 354 after. The bound is the page's share, not
   * the chrome's, because the page's share is the thing the member needs.
   * </p>
   */
  test("leaves a member enough of the phone to hold a QR up to a scanner", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await signIn(page);
    await serveApi(page, memberRoutes());
    await page.goto("/my-code");
    await expect(page.getByRole("heading", { name: "Your code" })).toBeVisible();
    await page.addStyleTag({ content: "html { font-size: 32px !important; }" });

    const measured = await page.evaluate(() => {
      const header = document.querySelector("header")!.getBoundingClientRect().height;
      const main = document.querySelector("main")!.getBoundingClientRect().height;
      return { header, main, vh: window.innerHeight };
    });
    console.log(`[B12/member] chrome ${Math.round(measured.header)}px, page ${Math.round(measured.main)}px`
      + ` of ${measured.vh} — ${Math.round((1 - measured.main / measured.vh) * 100)}% chrome`);

    expect(measured.header / measured.vh, "the chrome takes more than 40 % of the phone")
      .toBeLessThanOrEqual(0.4);
    // And the number underneath the percentage: a 254 px code, with something left over.
    expect(measured.main, "there is no room to put a QR on the glass").toBeGreaterThanOrEqual(254);
  });

  /**
   * The other half of that change, so it cannot be "fixed" by shrinking a touch target.
   *
   * <p>
   * The club name's 44 px came from `py-[10px]`, and the trim replaced it with a `min-h`. At a
   * 32 px root that is the whole gain — the text already exceeds 44 px, so the minimum adds
   * nothing — and at a 16 px root it has to be doing exactly what the padding did, or this is
   * not a trim, it is a regression on a fingertip.
   * </p>
   */
  test("keeps the club name a 44 px target on a phone at ordinary text", async ({ page }, testInfo) => {
    // The mobile project only, and not as a convenience: the minimum is behind
    // `@media (pointer: coarse)`, so on the desktop project it correctly does not apply and
    // the name is 24 px. Asserting 44 there would be asserting that a mouse is a fingertip.
    test.skip(testInfo.project.name !== "mobile", "the 44 px minimum is for a coarse pointer");
    await page.setViewportSize({ width: 320, height: 568 });
    await signIn(page);
    await serveApi(page, memberRoutes());
    await page.goto("/my-code");

    const name = page.locator('header a[href="/"]').first();
    const box = (await name.boundingBox())!;
    console.log(`[B12/member] club name ${Math.round(box.width)}×${Math.round(box.height)}`);
    expect(box.height, "the club name is smaller than a fingertip").toBeGreaterThanOrEqual(44);
  });

  /** The wallet chip showed a balance of 0 as "0…". */
  test("never abbreviates the wallet balance", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await openAdmin(page, "/admin/settings", 32);

    const chip = page.locator('header a[aria-label^="Wallet balance"]');
    await expect(chip).toBeVisible();
    const figure = await chip.locator("span[aria-hidden]").evaluate((el) => ({
      text: (el as HTMLElement).innerText,
      clipped: el.scrollWidth > el.clientWidth + 1,
    }));
    expect(figure.text).not.toContain("…");
    expect(figure.text).toBe("0.00 cr");
    expect(figure.clipped, "the balance is cut off inside its own box").toBe(false);
  });

  /**
   * And the gear's alert dot, which at 12 px sat across the 26 px cog rather than beside it
   * — so it read as part of the icon rather than as a flag on it. Measured as an overlap of
   * two boxes, because "looks like part of the glyph" is a geometry question.
   */
  test("keeps the gear's alert dot off the glyph", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await signIn(page);
    // One unnamed door, which is one of the three states the gear counts — so the dot is on.
    //
    // The doors route REPLACES the base one rather than being appended to it: the fixture
    // picks the longest matching prefix and ties break on declaration order, so an extra
    // route with the same path as a base route is never reached. That is a silent pass, not
    // a failure, which is exactly the kind this suite is not allowed to have.
    await serveApi(page, [...routes().filter((r) => r.path !== "/api/v1/admin/doors"), ...([
      {
        path: "/api/v1/admin/doors",
        body: {
          day_started_at: new Date(new Date().setHours(0, 0, 0, 0)).toISOString(),
          timezone: "Africa/Johannesburg",
          shut_all_active: false,
          shut_together: [],
          shut_individually: [],
          doors: [{
            device: {
              id: "99999999-9999-9999-9999-999999999999", device_code: "gate-0a1b2c",
              name: "Door gate", kind: "Gate", hardware: "Esp32", court_numbers: [],
              gate_key: null, mac_address: "5ccf7f0a1b2c", enabled: true,
              last_seen_at: new Date().toISOString(), last_ip_address: "192.168.68.160",
              running_version: "1.0.0", mega_version: null, created_at: new Date().toISOString(),
              auto_registered: true, effective_heartbeat_seconds: 60, location_note: null,
              power_loss_behaviour: "not_established", out_of_service_since: null,
            },
            today: { released: 0, refused: 0 },
            signals: [],
          }],
        },
      },
    ] as ApiRoute[])]);
    await page.goto("/admin/settings");
    await page.addStyleTag({ content: "html { font-size: 32px; }" });

    const gear = page.getByRole("button", { name: /Open menu — .*door/ });
    await expect(gear).toBeVisible();

    const overlap = await gear.evaluate((button) => {
      const dot = button.querySelector("span")!.getBoundingClientRect();
      const glyph = button.querySelector("svg")!.getBoundingClientRect();
      const x = Math.min(dot.right, glyph.right) - Math.max(dot.left, glyph.left);
      const y = Math.min(dot.bottom, glyph.bottom) - Math.max(dot.top, glyph.top);
      return x > 0 && y > 0 ? { x, y } : null;
    });
    expect(overlap, "the alert dot sits on top of the cog").toBeNull();
  });
});

/**
 * A-M11 / R3-29 — the header is ONE row on a phone.
 *
 * <p>
 * Measured at 360×700: the row was 80 px tall with the wallet chip, the avatar and the gear on
 * a line of their own, for a member and for an admin alike — 126 px of chrome before the page
 * begins. On the member's code page that is what pushes the door-decision banner, the most
 * urgent thing on the screen, below the fold; at 390 px the identical header is 56 px.
 * </p>
 *
 * <p>
 * <b>Both sessions, because they are different headers.</b> An admin has six section tabs and a
 * doors badge; a member has three tabs and no gear items. The cluster on the right is what
 * wraps, and it is not the same width in the two cases.
 * </p>
 *
 * <p>
 * At a 32 px root font size the row legitimately takes two lines — the words are genuinely
 * wider than the phone by then, and B12 above measures what that must cost. This is the
 * ordinary text size, where it cost 24 px for nothing.
 * </p>
 */
test.describe("A-M11 — the header on a phone", () => {
  for (const width of [320, 360, 375]) {
    for (const admin of [true, false]) {
      test(`is a single row at ${width} px for ${admin ? "an admin" : "a member"}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 700 });
        await signIn(page);
        await serveApi(page, admin ? routes() : memberRoutes());
        await page.goto("/my-code");
        await expect(page.getByRole("button", { name: /Open menu/ })).toBeVisible();

        const row = await page.evaluate(() => {
          const el = document.querySelector("header > div") as HTMLElement;
          // Anything with width: the inline nav is `hidden` below `lg` and measures 0×0, which
          // is not on a line at all.
          const boxes = [...el.children]
            .map((k) => k.getBoundingClientRect())
            .filter((box) => box.width > 0);
          return {
            height: Math.round(el.getBoundingClientRect().height),
            // Every item shares a line when the lowest top is above the highest bottom.
            // NOT "how many distinct tops": `items-center` gives a 44 px chip and a 24 px
            // link different tops on the same row, which read as two lines on the desktop
            // project and as one on the mobile one — a measurement that depended on which
            // project ran it.
            lowestTop: Math.round(Math.max(...boxes.map((b) => b.top))),
            highestBottom: Math.round(Math.min(...boxes.map((b) => b.bottom))),
            kids: [...el.children].map((k) => {
              const b = k.getBoundingClientRect();
              return `${k.tagName}@${Math.round(b.x)},${Math.round(b.y)} w${Math.round(b.width)}`;
            }),
          };
        });

        expect(
          row.lowestTop,
          `the header row wrapped: ${JSON.stringify(row.kids)}`,
        ).toBeLessThan(row.highestBottom);
        // 56 px is the row at every ordinary width; 80 is what the wrap cost.
        expect(row.height, `the header row is ${row.height} px tall`).toBeLessThanOrEqual(60);
      });
    }
  }
});

/**
 * B13 — the offline error toast covered the tab bar, which on a phone is the only way
 * between sections. `top-[100px]` was a guess at the header's height and it is wrong at any
 * text size but one; `Layout` publishes what the header actually measures.
 */
test.describe("B13 — where a toast lands", () => {
  for (const rootPx of [16, 32]) {
    test(`sits below the header and the tab strip at a ${rootPx} px root font`, async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 568 });
      await openAdmin(page, "/admin/settings", rootPx === 16 ? 0 : rootPx);

      // The one toast on this page that needs no network: adding a court with no name.
      await page.getByRole("button", { name: "Add court" }).click();
      const toast = page.getByRole("status").filter({ hasText: "Court name is required." });
      await expect(toast).toBeVisible();
      // Measured once it has ARRIVED. The strip animates in from 12 px below its resting place
      // now that it is anchored to the bottom, so an entry frame is 12 px past the bottom edge
      // and a measurement that races it reads as a toast hanging off the screen.
      await expect(toast).toHaveCSS("opacity", "1");

      const geometry = await page.evaluate(() => {
        const header = document.querySelector("header")!.getBoundingClientRect();
        const strip = document.querySelector('header nav[aria-label="Sections"]')!.getBoundingClientRect();
        const box = [...document.querySelectorAll('[role="status"]')]
          .find((n) => (n as HTMLElement).innerText.includes("Court name is required"))!
          .getBoundingClientRect();
        const heading = document.querySelector("#main-content h1")!.getBoundingClientRect();
        return {
          toastTop: box.top, toastBottom: box.bottom,
          headerBottom: header.bottom, stripBottom: strip.bottom,
          headingBottom: heading.bottom, viewport: window.innerHeight,
        };
      });
      expect(geometry.toastTop).toBeGreaterThanOrEqual(geometry.headerBottom);
      expect(geometry.toastTop).toBeGreaterThanOrEqual(geometry.stripBottom);

      /**
       * R3-28 / B10 — and it is nowhere near the line it argues with.
       *
       * <p>
       * Under the chrome is exactly where this product puts a page's own status line, and a
       * failure toast landing on top of one is a screen where the only two sentences that
       * matter are stacked, with the wrong one on top. The far edge of the screen is the one
       * place no heading, chip or status line lives — so the assertion is that the strip is in
       * the bottom half and clear of the page's heading, which is what a top anchor cannot be.
       * </p>
       */
      expect(
        geometry.toastTop,
        `the toast starts at y=${Math.round(geometry.toastTop)} of ${geometry.viewport} — it is anchored to the top`,
      ).toBeGreaterThan(geometry.viewport / 2);
      expect(geometry.toastTop, "the toast covers the page's own heading")
        .toBeGreaterThan(geometry.headingBottom);
      // And still on screen, safe-area inset and all.
      expect(geometry.toastBottom).toBeLessThanOrEqual(geometry.viewport);
    });
  }
});

/**
 * C14 — reviewer C counted seventy-six tab stops from the top of the document to the first
 * door setting. The jump nav is what closes that, and the number it has to close it to is
 * the thing worth pinning: a nav that is itself twenty stops long has moved the problem.
 */
test("reaches the door settings within twelve tab stops of the skip link", async ({ page }) => {
  await openAdmin(page, "/admin/settings");

  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
  await page.keyboard.press("Enter");

  let stops = 0;
  for (; stops < 12; stops += 1) {
    await page.keyboard.press("Tab");
    const name = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
    if (name === "Door gates") break;
  }
  console.log(`[C14] door settings reached in ${stops + 1} tab stops from the skip link`);
  expect(stops).toBeLessThan(12);

  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Door gates" })).toBeFocused();
  await expect(page.getByLabel(/Unlock time/)).toBeInViewport();
});
