import { type Page } from "@playwright/test";
import { SESSION_ADMIN, serveApi, signIn, test, expect, type ApiRoute, memberCodeRoutes } from "./fixtures";

/**
 * The application shell (P2): what a navigation does (C6), what the primary nav does as the
 * phone's bottom tab bar and as the desktop's top bar, at a width or a text size nobody designed
 * it at (C16 / E-L4 / B12 / A-M11), where a toast lands (B13), what the account menu's
 * Appearance does (D7), and where the renamed URLs go (R15).
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
    { path: "/api/v1/me/profile", body: { full_name: "Crusaders Admin", email: "admin@sample.local", photo_url: null, membership_number: "ADMIN-0001" } },
    { path: "/api/v1/wallet", body: { balance_minutes: 0, entries: [], total_entries: 0, offset: 0, limit: 50 } },
    { path: "/api/v1/admin/settings/", body: SETTINGS },
    // B13's toast is the settings page's own "Settings saved." — a save needs somewhere to land.
    { method: "PUT", path: "/api/v1/admin/settings/", body: { saved: true } },
    { path: "/api/v1/admin/courts/", body: [] },
    { path: "/api/v1/admin/members", body: [] },
    { path: "/api/v1/admin/doors", body: { doors: [], shut_together: [], shut_individually: [], timezone: "Africa/Johannesburg" } },
    { path: "/api/v1/admin/monitoring/summary", body: { open: {} } },
    ...extra,
  ];
}

/**
 * A MEMBER's session, which is a different chrome: three tabs where an admin has four, and no
 * attention badge. B12 is a measurement, so the two cannot stand in for each other.
 */
function memberRoutes(): ApiRoute[] {
  return [
    { path: "/api/v1/whoami", body: { ...SESSION_ADMIN, is_admin: false } },
    { path: "/api/v1/me/profile", body: { full_name: "Lerato Mokoena", email: "lerato@sample.local", photo_url: null, membership_number: "M-0001" } },
    { path: "/api/v1/wallet", body: { balance_minutes: 500, entries: [], total_entries: 0, offset: 0, limit: 50 } },
    ...memberCodeRoutes(),
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
  await expect(page.getByRole("button", { name: "Account menu" })).toBeVisible();
  if (rootPx > 0) await page.addStyleTag({ content: `html { font-size: ${rootPx}px; }` });
}

async function openMember(page: Page, path = "/my-code") {
  await signIn(page);
  await serveApi(page, memberRoutes());
  await page.goto(path);
  await expect(page.getByRole("button", { name: "Account menu" })).toBeVisible();
}

const mainNav = (page: Page) => page.getByRole("navigation", { name: "Main" });

/** Where the chrome is: the top bar, the primary nav, and what `--app-bottom-bar-height` says. */
async function chromeGeometry(page: Page) {
  return page.evaluate(() => {
    const header = document.querySelector<HTMLElement>("header[data-app-header]")!.getBoundingClientRect();
    const nav = document.querySelector<HTMLElement>("nav[data-primary-nav]")!;
    const bar = nav.getBoundingClientRect();
    const main = document.querySelector<HTMLElement>("main")!;
    return {
      vh: window.innerHeight,
      vw: window.innerWidth,
      headerBottom: header.bottom,
      headerHeight: header.height,
      navPosition: getComputedStyle(nav).position,
      barTop: bar.top,
      barBottom: bar.bottom,
      barHeight: bar.height,
      published: getComputedStyle(document.documentElement).getPropertyValue("--app-bottom-bar-height").trim(),
      mainPaddingBottom: getComputedStyle(main).paddingBottom,
      docScrollWidth: document.documentElement.scrollWidth,
      docClientWidth: document.documentElement.clientWidth,
    };
  });
}

test.describe("C6 — what a navigation does", () => {
  /**
   * Reviewer C measured this on seven routes: `document.title` was "Crusaders Mainframe"
   * everywhere, focus went to `<body>`, and nothing was announced. To a screen-reader user a
   * single-page app that does that has not navigated at all.
   */
  test("retitles the document, announces the page and lands focus on its heading", async ({ page }) => {
    await openAdmin(page, "/admin/settings");
    await expect(page).toHaveTitle("Settings — Crusaders Squash");

    // The primary nav is ONE list in both layouts (the phone's bottom bar, the desktop's top
    // bar), so the same locator works on both projects.
    await mainNav(page).getByRole("link", { name: "Wallet" }).click();

    await expect(page).toHaveTitle("Wallet — Crusaders Squash");
    await expect(page.getByTestId("route-announcer")).toHaveText("Wallet");
    await expect(page.locator("h1:focus")).toHaveCount(1);
    await expect(mainNav(page).getByRole("link", { name: "Wallet" })).toHaveAttribute("aria-current", "page");

    // Back, and the title follows: a browser-history entry is named after the title it had.
    await page.goBack();
    await expect(page).toHaveTitle("Settings — Crusaders Squash");
  });

  /**
   * C15 / D9's shell half. A fragment used to scroll and leave focus at the top of the
   * document, and the heading landed underneath the sticky header. The `scroll-margin-top` is
   * what clears the header; the focus is what makes the jump mean anything.
   */
  /*
   * R13 retired the settings page's "Jump to section" nav — the sections are an accordion now,
   * and `#settings-<section>` is how a link reaches one. The invariant is unchanged: a fragment
   * lands focus on the section it names (its header button, which is the section's <h2>), and
   * that header is clear of the sticky top bar.
   */
  test("focuses a fragment's heading and keeps it clear of the sticky header", async ({ page }) => {
    await openAdmin(page, "/admin/settings#settings-doors");

    const trigger = page.getByRole("button", { name: "Door gates" });
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    const geometry = await page.evaluate(() => {
      const h = document.querySelector("#settings-doors h2")!;
      const header = document.querySelector("header[data-app-header]")!;
      return { headingTop: h.getBoundingClientRect().top, headerBottom: header.getBoundingClientRect().bottom };
    });
    expect(geometry.headingTop).toBeGreaterThanOrEqual(geometry.headerBottom);
  });
});

test.describe("R15 — where the old addresses go", () => {
  test("a signed-in member opening the club's address lands on My Code", async ({ page }) => {
    await openMember(page, "/");
    await expect(page).toHaveURL(/\/my-code$/);
    // D1/D8: My Code's h1 is visually hidden on a phone (the pass says whose it is), so it is
    // asserted present, and the pass itself visible.
    await expect(page.getByRole("heading", { name: "My Code" })).toBeAttached();
    await expect(page.getByRole("article", { name: "Your member pass" })).toBeVisible();
    await expect(mainNav(page).getByRole("link", { name: "My Code" })).toHaveAttribute("aria-current", "page");
  });

  test("the old bookings address keeps its query on the way to /bookings", async ({ page }) => {
    await openMember(page, "/schedule?date=2099-01-01");
    await expect(page).toHaveURL(/\/bookings\?date=2099-01-01$/);
    await expect(page).toHaveTitle("Bookings — Crusaders Squash");
  });
});

test.describe("the phone's bottom tab bar", () => {
  /**
   * C16 / E-L4's successor. The old scrolling strip clipped its sixth tab at 390 px and at
   * 400 % zoom; the bottom bar holds four equal tabs, so the question is only whether each is
   * whole, a fingertip tall, and pinned to the bottom edge with the page kept clear of it.
   * A 1280×900 screen at 400 % zoom is a 320×225 CSS viewport.
   */
  for (const size of [{ label: "360 px", width: 360, height: 640 }, { label: "400 % zoom", width: 320, height: 225 }]) {
    test(`holds every destination whole and a fingertip tall at ${size.label}`, async ({ page }) => {
      await page.setViewportSize(size);
      await openAdmin(page, "/admin/settings");

      const tabs = mainNav(page).getByRole("link");
      await expect(tabs).toHaveCount(4);
      for (let i = 0; i < 4; i += 1) {
        const tab = tabs.nth(i);
        const name = await tab.innerText();
        await expect(tab, `the ${name} tab is clipped at ${size.label}`).toBeInViewport({ ratio: 0.99 });
        const box = (await tab.boundingBox())!;
        expect(box.height, `the ${name} tab is ${box.height}px tall`).toBeGreaterThanOrEqual(44);
      }
      await expect(tabs.nth(3)).toHaveAttribute("href", "/admin");
      await expect(tabs.nth(3)).toHaveAttribute("aria-current", "page");

      const geo = await chromeGeometry(page);
      expect(geo.navPosition).toBe("fixed");
      expect(Math.abs(geo.barBottom - geo.vh), "the bar is not on the bottom edge").toBeLessThanOrEqual(1);
      // What it publishes is what it measures, and the page is padded by exactly that much, so
      // the last line of any page scrolls clear of the bar instead of hiding behind it.
      expect(geo.published).toBe(`${Math.round(geo.barHeight)}px`);
      expect(geo.mainPaddingBottom).toBe(`${Math.round(geo.barHeight)}px`);
      expect(geo.docScrollWidth).toBeLessThanOrEqual(geo.docClientWidth + 1);
    });
  }

  /**
   * The Admin tab's count sits ON the icon, clear of the word under it — a number over a label
   * reads as part of the label. Measured at a 32 px root on a 320 px phone, where it is tightest.
   */
  test("keeps the Admin badge off its label, at the largest text", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await signIn(page);
    await serveApi(page, [
      ...routes().filter((r) => r.path !== "/api/v1/admin/members"),
      { path: "/api/v1/admin/members", body: [{ id: "m1", full_name: "Pending Person", email: "p@x.review.test", status: "PendingApproval" }] },
    ]);
    await page.goto("/admin/settings");
    const badge = mainNav(page).getByLabel("1 membership application awaiting review");
    await expect(badge).toBeVisible();
    await page.addStyleTag({ content: "html { font-size: 32px; }" });

    const overlap = await badge.evaluate((el) => {
      const link = el.closest("a")!;
      const label = [...link.querySelectorAll("span")].find((s) => s.textContent === "Admin")!;
      const a = el.getBoundingClientRect();
      const b = label.getBoundingClientRect();
      const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      return { overlaps: x > 0 && y > 0, inside: a.right <= window.innerWidth + 1 };
    });
    expect(overlap.overlaps, "the badge sits on top of the word Admin").toBe(false);
    expect(overlap.inside, "the badge runs off the right edge").toBe(true);
  });
});

test.describe("the desktop top bar", () => {
  /**
   * From `md` the same nav sits inline in the top bar: no fixed bar, nothing published, and the
   * whole row — crest, four tabs, credits chip, avatar — on one line at the narrowest width it
   * is used at, with the document never scrolling sideways (the old chrome's 795-against-768).
   */
  for (const width of [768, 1024, 1440]) {
    test(`holds crest, four tabs, chip and avatar on one line at ${width} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await openAdmin(page, "/admin/settings");

      const geo = await chromeGeometry(page);
      expect(geo.navPosition).toBe("static");
      expect(geo.published).toBe("0px");
      expect(geo.mainPaddingBottom).toBe("0px");
      expect(geo.docScrollWidth, `document overflowed a ${width}px viewport`).toBeLessThanOrEqual(geo.docClientWidth + 1);
      // 56 px is the bar; anything taller means a second line.
      expect(geo.headerHeight, `the top bar is ${geo.headerHeight}px tall`).toBeLessThanOrEqual(58);

      const tops = await mainNav(page).getByRole("link").evaluateAll((links) =>
        [...new Set(links.map((a) => Math.round(a.getBoundingClientRect().top)))]);
      expect(tops, "the tabs wrapped").toHaveLength(1);
    });
  }
});

test.describe("B12 — the chrome at a large root font size", () => {
  /**
   * Reviewer B measured the old header plus its tab strip at 54 % of a 320×568 screen with a
   * 32 px root font. The P2 chrome is a top bar and a bottom bar; together they must still leave
   * the page most of the phone. The text scales; the boxes stop at the size a fingertip needs.
   */
  test("leaves the page at least 60 % of a 320×568 screen", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await openAdmin(page, "/admin/settings", 32);

    const geo = await chromeGeometry(page);
    const content = (geo.barTop - geo.headerBottom) / geo.vh;
    console.log(`[B12] top ${Math.round(geo.headerHeight)}px + bottom ${Math.round(geo.barHeight)}px of 568; page ${(content * 100).toFixed(1)}%`);
    expect(content).toBeGreaterThanOrEqual(0.6);
  });

  /**
   * And the rule underneath the percentage, measured as the mechanism rather than the symptom:
   * doubling the root font grows each bar by the height of its TEXT and nothing else. A fixed
   * `h-9` on the credits chip measured 72 px here and grew the top bar by 97 px; in `rem` every
   * 44 px target would become 88 px. Measured at 440 px, where the top bar stays one row at both
   * sizes, so the number is box growth rather than the row wrapping — at 320 px and a 32 px root
   * the words are genuinely wider than the phone and the row takes two lines, which the
   * percentage above prices in. (It was 390 px until P11 put the 44 px notification bell in the
   * row: at a 32 px root the row then needs about 440 px to stay on one line. The bell is a fixed
   * 44 px box, so it adds no growth of its own; only the width at which one line holds moved.)
   */
  test("grows only by its text when the root font size doubles", async ({ page }) => {
    await page.setViewportSize({ width: 440, height: 700 });
    await openAdmin(page, "/admin/settings");

    const at = async (rootPx: number) => {
      await page.addStyleTag({ content: `html { font-size: ${rootPx}px !important; }` });
      return chromeGeometry(page);
    };
    const small = await at(16);
    const large = await at(32);
    const top = large.headerHeight - small.headerHeight;
    const bottom = large.barHeight - small.barHeight;
    console.log(`[B12] top bar grew ${Math.round(top)}px, bottom bar ${Math.round(bottom)}px for a doubling of the text`);
    expect(top, "the top bar's boxes are scaling, not just its words").toBeLessThanOrEqual(45);
    expect(bottom, "the bottom bar's boxes are scaling, not just its words").toBeLessThanOrEqual(45);
  });

  /**
   * On the MEMBER's code page, where it bites: the QR is about 254 px and the question is whether
   * the page has room to put one on the glass between the two bars.
   */
  test("leaves a member enough of the phone to hold a QR up to a scanner", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await openMember(page);
    // D1/D8: My Code's h1 is visually hidden on a phone (the pass says whose it is), so it is
    // asserted present, and the pass itself visible.
    await expect(page.getByRole("heading", { name: "My Code" })).toBeAttached();
    await expect(page.getByRole("article", { name: "Your member pass" })).toBeVisible();
    await page.addStyleTag({ content: "html { font-size: 32px !important; }" });

    const geo = await chromeGeometry(page);
    const room = geo.barTop - geo.headerBottom;
    console.log(`[B12/member] ${Math.round(room)}px of page between the bars, of ${geo.vh}`);
    expect(room, "there is no room to put a QR on the glass").toBeGreaterThanOrEqual(254);
  });

  /** The crest is the way home and a fingertip target at every text size. */
  test("keeps the crest a 44 px target", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await openMember(page);
    const box = (await page.getByRole("link", { name: "Crusaders Squash — home" }).boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
  });

  /**
   * The wallet chip once showed a balance of 0 as "0…". V5-4 (review round 5): on a phone at this
   * text size the chip folds into the account menu so the bar is one row — the figure is whole in
   * both places it can be.
   */
  test("never abbreviates the wallet balance", async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 800 });
    await openAdmin(page, "/admin/settings", 32);

    const chip = page.locator('header[data-app-header] a[aria-label^="Wallet balance"]');
    await expect(chip).toBeVisible();
    const figure = await chip.locator("span[aria-hidden]").first().evaluate((el) => ({
      text: (el as HTMLElement).innerText,
      clipped: el.scrollWidth > el.clientWidth + 1,
    }));
    expect(figure.text).not.toContain("…");
    expect(figure.text).toBe("0 min");
    expect(figure.clipped, "the balance is cut off inside its own box").toBe(false);

    await page.setViewportSize({ width: 320, height: 568 });
    await expect(chip).toBeHidden();
    await page.getByRole("button", { name: "Account menu" }).click();
    const item = page.getByRole("menuitem", { name: /^Wallet/ });
    await expect(item).toBeVisible();
    // The figure a sighted member reads: <Minutes> pairs it (aria-hidden) with an sr-only spoken twin,
    // which is clipped by design and must not be the span measured here.
    const inMenu = await item.locator('span[aria-hidden="true"]').last().evaluate((el) => ({
      text: (el as HTMLElement).innerText,
      clipped: el.scrollWidth > el.clientWidth + 1 || el.getBoundingClientRect().right > window.innerWidth,
    }));
    // R19 L19-3 — <Minutes> glues each figure to its unit (a no-break space); read as words.
    expect(inMenu.text.replace(/\u00a0/g, " ")).toBe("0 min");
    expect(inMenu.clipped, "the balance is cut off in the menu").toBe(false);
  });
});

/**
 * A-M11 / R3-29 — the top bar is ONE row on a phone, for an admin and a member alike. The
 * primary nav is `position: fixed` there and is not part of the row, so it is left out.
 */
test.describe("A-M11 — the top bar on a phone", () => {
  for (const width of [320, 360, 375]) {
    for (const admin of [true, false]) {
      test(`is a single row at ${width} px for ${admin ? "an admin" : "a member"}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 700 });
        await signIn(page);
        await serveApi(page, admin ? routes() : memberRoutes());
        await page.goto("/my-code");
        await expect(page.getByRole("button", { name: "Account menu" })).toBeVisible();

        const row = await page.evaluate(() => {
          const el = document.querySelector("header[data-app-header] > div") as HTMLElement;
          const boxes = [...el.children]
            .filter((k) => getComputedStyle(k).position !== "fixed")
            .map((k) => k.getBoundingClientRect())
            .filter((box) => box.width > 0);
          return {
            height: Math.round(el.getBoundingClientRect().height),
            lowestTop: Math.round(Math.max(...boxes.map((b) => b.top))),
            highestBottom: Math.round(Math.min(...boxes.map((b) => b.bottom))),
          };
        });
        expect(row.lowestTop, "the top bar wrapped").toBeLessThan(row.highestBottom);
        expect(row.height, `the top bar is ${row.height} px tall`).toBeLessThanOrEqual(60);
      });
    }
  }
});

/**
 * B13 — a toast on a phone sits just ABOVE the bottom tab bar (it reads
 * `--app-bottom-bar-height`), clear of the page's own heading and status line.
 */
test.describe("B13 — where a toast lands", () => {
  for (const rootPx of [16, 32]) {
    test(`sits above the tab bar at a ${rootPx} px root font`, async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 568 });
      // R19 X19-3 — a REAL toast. Settings now says "Settings saved." in its own save bar (a status
      // region, not a toast), and `getByRole("status")` matched that bar, so this measured the bar.
      // The minutes chip's money toast is raised by a wallet frame the test pushes.
      await page.addInitScript(() => {
        class FakeSource extends EventTarget {
          readyState = 1; onopen: ((e: Event) => void) | null = null; onmessage: ((e: MessageEvent) => void) | null = null; onerror: ((e: Event) => void) | null = null;
          constructor() {
            super();
            (window as unknown as { __streams: FakeSource[] }).__streams.push(this);
            setTimeout(() => this.onopen?.(new Event("open")), 0);
          }
          close() { this.readyState = 2; }
          push(frame: unknown) { this.dispatchEvent(new MessageEvent("balance", { data: JSON.stringify(frame) })); }
        }
        (window as unknown as { __streams: FakeSource[] }).__streams = [];
        (window as unknown as { EventSource: unknown }).EventSource = FakeSource;
      });
      await signIn(page);
      await serveApi(page, [{ method: "POST", path: "/api/v1/wallet/stream-ticket", body: { ticket: "t", expires_in_seconds: 60 } }, ...routes()]);
      await page.goto("/admin/settings");
      await expect(page.getByRole("button", { name: "Account menu" })).toBeVisible();
      if (rootPx > 16) await page.addStyleTag({ content: `html { font-size: ${rootPx}px; }` });
      await page.waitForFunction(() => (window as unknown as { __streams: unknown[] }).__streams.length > 0);
      const push = (frame: unknown) => page.evaluate((f) => {
        const open = (window as unknown as { __streams: { push: (x: unknown) => void; readyState: number }[] }).__streams.filter((x) => x.readyState === 1);
        open[open.length - 1].push(f);
      }, frame);
      await push({ balance_minutes: 0 });
      await push({ balance_minutes: 5, delta_minutes: 5, reason: "admin_adjustment" });
      const toast = page.locator("[data-toast]").filter({ hasText: "5 minutes" });
      await expect(toast).toBeVisible();
      // Measured once it has ARRIVED: it animates in from 12 px below its resting place.
      await expect(toast).toHaveCSS("opacity", "1");

      const geo = await chromeGeometry(page);
      const box = (await toast.boundingBox())!;
      const headingBottom = await page.locator("#main-content h1").evaluate((h) => h.getBoundingClientRect().bottom);
      // Anchored 12 px above the bar — which is what reading `--app-bottom-bar-height` buys; a
      // toast anchored to the viewport's edge would sit ON the bar, the only way between pages.
      expect(Math.abs(geo.barTop - 12 - (box.y + box.height)), "the toast is not riding the tab bar").toBeLessThanOrEqual(2);
      expect(box.y, "the toast covers the page's own heading").toBeGreaterThan(headingBottom);
      expect(box.y).toBeGreaterThanOrEqual(geo.headerBottom);
    });
  }
});

/**
 * C14 — reviewer C counted seventy-six tab stops from the top of the document to the first door
 * setting. The skip link lands on the page's heading — past the top bar AND the admin console's
 * rail — and the settings sections' own headers take it from there. (R13 replaced the jump nav
 * with an accordion: the door section's header button is what is reached, and Enter opens it.)
 */
test("reaches the door settings within twelve tab stops of the skip link", async ({ page }) => {
  await openAdmin(page, "/admin/settings");
  // Wait for the thing being counted TO EXIST: the sections render only once settings load.
  await expect(page.getByRole("button", { name: "Door gates" })).toBeVisible();

  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content h1")).toBeFocused();

  let stops = 0;
  for (; stops < 12; stops += 1) {
    await page.keyboard.press("Tab");
    // The header button's text carries its live summary too, so it is matched by what names it.
    const labelledBy = await page.evaluate(() => document.activeElement?.getAttribute("aria-labelledby") ?? "");
    if (labelledBy === "settings-doors-title") break;
  }
  console.log(`[C14] door settings reached in ${stops + 1} tab stops from the skip link`);
  expect(stops).toBeLessThan(12);

  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Door gates" })).toHaveAttribute("aria-expanded", "true");
});

/**
 * The account menu (R16 retired the gear; D7 made dark mode live). Driven with the keyboard
 * because that is the contract that matters, and the theme is read back from the painted page —
 * the canvas colour — not from a class, because a class that emits no CSS is the failure the
 * token layer was rebuilt to prevent.
 */
test.describe("the account menu", () => {
  test("switches the whole app to dark, keeps it across a reload, and back", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await openMember(page);
    const canvas = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(await canvas()).toBe("rgb(248, 250, 252)"); // bg.app light #F8FAFC

    const trigger = page.getByRole("button", { name: "Account menu" });
    await trigger.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("menuitemradio", { name: "Dark" }).click();
    await expect(page.locator("html")).toHaveClass(/\bdark\b/);
    await expect.poll(canvas).toBe("rgb(10, 18, 32)"); // bg.app dark #0A1220
    // The menu stays open so a member can compare before choosing.
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toBeHidden();
    await expect(trigger).toBeFocused();

    // theme-boot.js applies the stored choice before the first paint of the next load.
    await page.reload();
    await expect(page.locator("html")).toHaveClass(/\bdark\b/);
    expect(await canvas()).toBe("rgb(10, 18, 32)");

    await trigger.click();
    await page.getByRole("menuitemradio", { name: "System" }).click();
    await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
  });

  test("signs out to the sign-in screen", async ({ page }) => {
    await openMember(page);
    await serveApi(page, [...memberRoutes(), { method: "POST", path: "/api/v1/auth/logout", body: {} }]);
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login$/);
    expect(await page.evaluate(() => localStorage.getItem("crusaders.mainframe.token"))).toBeNull();
  });
});

/**
 * V5-3 / V4-11 (review round 5) — the top bar from `md` at 200 % text. At 768 the crest stood
 * alone on a row (right-aligned), the tab icons were squeezed to slivers, the Admin count spilled
 * out of its circle and the credits chip covered the bell's count; at 1024–1280 the crest was
 * alone on the first of THREE rows. Large text now decides by the bar's own width in rem: where
 * crest, tabs and actions do not fit one row, the tabs are the bottom tab bar (as on a phone).
 */
test.describe("V5-3 — the top bar at 200 % text from md", () => {
  const withCounts = () => routes([
    { path: "/api/v1/admin/members", body: [{ id: "m1", full_name: "Pending Person", email: "p@x.review.test", status: "PendingApproval" }] },
    { path: "/api/v1/me/notifications/unread-count", body: { unread_count: 3 } },
  ]);

  async function header(page: Page) {
    return page.evaluate(() => {
      const row = document.querySelector<HTMLElement>("header[data-app-header] > div")!;
      const crest = document.querySelector<HTMLElement>("[data-crest-link]")!.getBoundingClientRect();
      const others = [...row.children]
        .filter((k) => !k.contains(document.querySelector("[data-crest-link]")) && getComputedStyle(k).position !== "fixed")
        .map((k) => k.getBoundingClientRect())
        .filter((b) => b.width > 0);
      const icons = [...document.querySelectorAll<SVGElement>("nav[data-primary-nav] a svg")].map((s) => s.getBoundingClientRect().width);
      const spilled = [...document.querySelectorAll<HTMLElement>("[data-attention-badge], [data-unread-badge]")]
        .filter((b) => b.scrollWidth > b.clientWidth + 1 || b.scrollHeight > b.clientHeight + 1).length;
      const badge = document.querySelector<HTMLElement>("[data-unread-badge]");
      let onTop: string | null = null;
      if (badge) {
        const b = badge.getBoundingClientRect();
        const hit = document.elementFromPoint(b.right - 3, b.top + b.height / 2);
        onTop = hit && (hit === badge || badge.contains(hit)) ? "badge" : (hit?.closest("[data-minutes-chip]") ? "chip" : hit?.tagName ?? null);
      }
      return {
        crestShares: others.some((b) => b.top < crest.bottom && b.bottom > crest.top),
        rows: new Set([...row.children].filter((k) => getComputedStyle(k).position !== "fixed").map((k) => Math.round(k.getBoundingClientRect().top))).size,
        smallestIcon: Math.min(...icons),
        spilled,
        onTop,
        docScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
  }

  for (const size of [{ width: 768, height: 1024 }, { width: 1024, height: 768 }, { width: 1280, height: 800 }, { width: 1920, height: 1080 }]) {
    test(`never leaves the crest alone, nor squeezes an icon or a count, at ${size.width} px`, async ({ page }) => {
      await page.setViewportSize(size);
      await signIn(page);
      await serveApi(page, withCounts());
      await page.goto("/admin/settings");
      await expect(page.getByRole("button", { name: "Account menu" })).toBeVisible();
      await expect(page.locator("[data-unread-badge]")).toBeVisible();
      await page.addStyleTag({ content: "html { font-size: 32px !important; }" });
      await page.waitForTimeout(200);

      const h = await header(page);
      expect(h.crestShares, "the crest is alone on its row").toBe(true);
      expect(h.smallestIcon, "a tab's icon was squeezed").toBeGreaterThanOrEqual(16);
      expect(h.spilled, "a count spilled out of its circle").toBe(0);
      expect(h.onTop, "the minutes chip covers the bell's count").toBe("badge");
      expect(h.docScroll).toBeLessThanOrEqual(1);
    });
  }

  /** V5-4 — at 320 px and 200 % text the bar is one row: the balance moves into the account menu. */
  test("is one row on a 320 px phone at 200 % text, with the balance one tap away in the menu", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await openMember(page);
    await page.addStyleTag({ content: "html { font-size: 32px !important; }" });
    await page.waitForTimeout(200);

    const height = await page.evaluate(() => document.querySelector<HTMLElement>("header[data-app-header]")!.getBoundingClientRect().height);
    expect(height, `the top bar is ${height}px tall`).toBeLessThanOrEqual(64);

    await page.getByRole("button", { name: "Account menu" }).click();
    const wallet = page.getByRole("menuitem", { name: /Wallet.*(8 h 20 min|8 hours 20 minutes)/ });
    await expect(wallet).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Sign out" })).toBeVisible();
  });
});

/**
 * P5-3 (review round 5) — first session, no worker yet: a tap on a page whose code has not arrived
 * left the old page standing with nothing to say the tap had landed (0.5 s on slow 4G, up to 1.8 s
 * on Fast 3G). The router moves in a transition, so Wallet stays drawn until Bookings' code is
 * here; the cue under the top bar (and `<main aria-busy>`) is what answers the tap at once.
 */
test("P5-3 — a tap on a page whose code has not arrived is answered at once", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  // Bookings' code is held until the test lets it through — the prefetch's ask included.
  await page.route(/\/src\/pages\/Schedule\.tsx/, async (route) => { await held; await route.continue(); });
  await openMember(page, "/wallet");
  await expect(page.locator("#main-content h1")).toBeVisible();

  await mainNav(page).getByRole("link", { name: "Bookings" }).click();
  await expect(page.locator("[data-route-pending]")).toBeVisible({ timeout: 300 });
  await expect(page.locator("#main-content")).toHaveAttribute("aria-busy", "true");

  release();
  await expect(page).toHaveURL(/\/bookings$/);
  await expect(page.locator("[data-route-pending]")).toHaveCount(0);
  await expect(page.locator("#main-content")).not.toHaveAttribute("aria-busy", "true");
});
