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

    await page.getByRole("button", { name: /Open menu/ }).click();
    await page.getByRole("menuitem", { name: "Doors" }).click();

    await expect(page).toHaveTitle("Doors — Crusaders Mainframe");
    await expect(page.getByTestId("route-announcer")).toHaveText("Doors");
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

      // E-L4 named Doors specifically — it is the sixth tab and the one that was off the end.
      await expect(strip.getByRole("link", { name: /^Doors/ })).toHaveAttribute("href", "/admin/doors");
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
    // eslint-disable-next-line no-console -- the measurement IS the point of this test
    console.log(`[B12] header+strip ${Math.round(share.header)}px of 568; content ${(share.content * 100).toFixed(1)}%`);
    expect(share.content).toBeGreaterThanOrEqual(0.6);
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

      const geometry = await page.evaluate(() => {
        const header = document.querySelector("header")!.getBoundingClientRect();
        const strip = document.querySelector('header nav[aria-label="Sections"]')!.getBoundingClientRect();
        const box = [...document.querySelectorAll('[role="status"]')]
          .find((n) => (n as HTMLElement).innerText.includes("Court name is required"))!
          .getBoundingClientRect();
        return { toastTop: box.top, headerBottom: header.bottom, stripBottom: strip.bottom };
      });
      expect(geometry.toastTop).toBeGreaterThanOrEqual(geometry.headerBottom);
      expect(geometry.toastTop).toBeGreaterThanOrEqual(geometry.stripBottom);
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
  // eslint-disable-next-line no-console -- the measurement IS the point of this test
  console.log(`[C14] door settings reached in ${stops + 1} tab stops from the skip link`);
  expect(stops).toBeLessThan(12);

  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Door gates" })).toBeFocused();
  await expect(page.getByLabel(/Unlock time/)).toBeInViewport();
});
