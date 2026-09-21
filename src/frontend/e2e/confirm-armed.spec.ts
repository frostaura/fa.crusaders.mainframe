import { type Locator, type Page } from "@playwright/test";
import { SESSION_ADMIN, serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { BUTTON_VARIANT_CLASS } from "../src/components/Button";

/**
 * B5 / C2 / C3 / C7 — the armed confirm, measured rather than looked at.
 *
 * <p>
 * Every number in this finding is a pixel, and every one of them was measured on a real
 * page: at 320×568 the Cancel was clipped by 19 px; at a 32 px root font size the armed
 * control was 1 232 px tall with its Cancel 1 061 px below the fold, inside an eight-second
 * window; at 1440×900 the armed block scrolled out of view entirely. jsdom can hold the DOM
 * shape and none of that, so this is where the shape is held to the geometry.
 * </p>
 *
 * <p>
 * <b>Found by shape, not by wording.</b> Every `ConfirmButton` is a wrapper holding its
 * control and the polite live region that replaced `aria-pressed`, so the selector below is
 * every two-step confirm on the page and nothing else — a control that arrives on one of
 * these screens next month is measured without anybody remembering to add it.
 * </p>
 */

const CONFIRMS = 'div:has(> span[aria-live="polite"])';

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

const COURT = { id: "aaaaaaaa-0000-0000-0000-000000000001", name: "Court 1", slice_price_credits: 8, is_active: true };

/** A court box the way /admin/devices serves one: the shape `admin-devices.spec.ts` uses. */
const BOX = {
  id: "11111111-1111-1111-1111-111111111111",
  device_code: "box-a1b2c3",
  name: "Cupboard box",
  kind: "CourtBox",
  hardware: "Esp8266",
  court_numbers: [1],
  gate_key: null,
  mac_address: "5ccf7f1a2b3c",
  enabled: true,
  last_seen_at: new Date().toISOString(),
  last_ip_address: "192.168.68.151",
  running_version: "2.0.0",
  mega_version: "1.4.0",
  created_at: new Date().toISOString(),
  auto_registered: false,
  button_map: null,
  effective_heartbeat_seconds: 60,
};

function base(extra: ApiRoute[] = []): ApiRoute[] {
  return [
    { path: "/api/v1/whoami", body: SESSION_ADMIN },
    { path: "/api/v1/me/profile", body: { full_name: "Crusaders Admin", email: "admin@sample.local", photo_url: null, membership_number: "ADMIN-0001", member_class: "Regular" } },
    { path: "/api/v1/admin/settings/", body: SETTINGS },
    { path: "/api/v1/admin/courts/", body: [COURT, { id: "22222222-2222-2222-2222-222222222221", court_number: 1, name: "Show court", court_type: "Squash", slice_price_credits: 8, is_active: true }] },
    { path: "/api/v1/admin/members", body: [] },
    { path: "/api/v1/admin/doors", body: { doors: [], shut_together: [], shut_individually: [], timezone: "Africa/Johannesburg" } },
    // Longest prefix wins in the fixture, so the api-key route is not swallowed by the list.
    { path: "/api/v1/admin/devices/api-key", body: { api_key: "cmk_9F2Kq7Xd4bTn6Ls0", regenerated_at: "2026-09-01T08:30:00Z" } },
    { path: "/api/v1/admin/devices/", body: [BOX] },
    ...extra,
  ];
}

/** The two admin screens outside the doors surface that carry a destructive confirm. */
const PAGES = [
  { label: "admin settings", path: "/admin/settings", ready: /Unlock time/ },
  { label: "admin devices", path: "/admin/devices", ready: /Cupboard box/ },
];

const SIZES = [
  { label: "320×568", width: 320, height: 568, rootPx: 0 },
  { label: "820×1180", width: 820, height: 1180, rootPx: 0 },
  { label: "320 at a 32 px root", width: 320, height: 568, rootPx: 32 },
];

async function open(page: Page, path: string, rootPx: number) {
  await signIn(page);
  await serveApi(page, base());
  await page.goto(path);
  if (rootPx > 0) await page.addStyleTag({ content: `html { font-size: ${rootPx}px; }` });
}

/**
 * Whether anything between this element and the document clips it.
 *
 * <p>
 * The R1 defect was `overflow-hidden` ON the control. The one this replaces it with would be
 * an ANCESTOR clipping the paragraph — a card with a fixed height, a row with
 * `overflow-hidden` for a rounded corner — and that is invisible from the element's own
 * classes, which is why it is walked rather than asserted about.
 * </p>
 */
async function clippedByAnAncestor(target: Locator): Promise<string | null> {
  return target.evaluate((node) => {
    const box = node.getBoundingClientRect();
    for (let at = node.parentElement; at && at !== document.body; at = at.parentElement) {
      const overflow = `${getComputedStyle(at).overflowX} ${getComputedStyle(at).overflowY}`;
      if (!/hidden|clip/.test(overflow)) continue;
      const bound = at.getBoundingClientRect();
      // A 1 px allowance for sub-pixel rounding of a fractional line height, nothing more.
      if (box.bottom > bound.bottom + 1 || box.top < bound.top - 1 || box.right > bound.right + 1) {
        return `${at.tagName}.${at.className} (${overflow}) cuts it`;
      }
    }
    return null;
  });
}

for (const size of SIZES) {
  for (const target of PAGES) {
    test(`an armed confirm on ${target.label} is whole and reachable at ${size.label}`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      await open(page, target.path, size.rootPx);
      await expect(page.getByText(target.ready).first()).toBeVisible();

      const wrappers = page.locator(CONFIRMS);
      const count = await wrappers.count();
      expect(count, `${target.label} renders no two-step confirm at all`).toBeGreaterThan(0);

      for (let i = 0; i < count; i += 1) {
        const wrapper = wrappers.nth(i);
        const trigger = wrapper.locator("> button").first();
        const idle = (await trigger.innerText()).trim();

        await trigger.click();

        // Two buttons, side by side, and the consequence above them as page text.
        await expect(wrapper.locator("> button")).toHaveCount(2);
        const confirm = wrapper.locator("> button").nth(0);
        const cancel = wrapper.locator("> button").nth(1);
        const consequence = wrapper.locator("> p");
        await expect(consequence).toBeVisible();

        // <b>Both visible together</b> — the whole of B5. At 320×568 the Cancel was clipped
        // by 19 px and at a 32 px root it was 1 061 px below the fold.
        await expect(confirm, `${target.label} ${size.label}: confirm ${i} ("${idle}") is off screen`).toBeInViewport();
        await expect(cancel, `${target.label} ${size.label}: cancel ${i} ("${idle}") is off screen`).toBeInViewport();

        const measured = await consequence.evaluate((el) => ({
          fontSize: Number.parseFloat(getComputedStyle(el).fontSize),
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          text: (el as HTMLElement).innerText.trim(),
        }));
        expect(measured.text.length, `confirm ${i} ("${idle}") shows no consequence`).toBeGreaterThan(10);
        expect(measured.fontSize, `confirm ${i} ("${idle}") is smaller than 14 px`).toBeGreaterThanOrEqual(14);
        expect(
          measured.scrollHeight,
          `confirm ${i} ("${idle}") clips its own words: ${measured.scrollHeight} > ${measured.clientHeight}`,
        ).toBeLessThanOrEqual(measured.clientHeight + 1);
        expect(await clippedByAnAncestor(consequence), `confirm ${i} ("${idle}")`).toBeNull();

        // 44 px on both, and the way out is not the harder one to hit.
        for (const [name, button] of [["confirm", confirm], ["cancel", cancel]] as const) {
          const box = (await button.boundingBox())!;
          expect(box.height, `confirm ${i}'s ${name} is ${box.height} px tall`).toBeGreaterThanOrEqual(44);
          // And nothing spills sideways off a 320 px phone.
          expect(box.x + box.width, `confirm ${i}'s ${name} runs past the right edge`)
            .toBeLessThanOrEqual(size.width + 1);
        }

        // C3 — focus is on the SAFE one, so a second Enter cannot do the thing.
        await expect(cancel).toBeFocused();

        await cancel.click();
        await expect(wrapper.locator("> button")).toHaveCount(1);
      }
    });
  }
}

/**
 * C7 — the armed block brings itself to where it can be read.
 *
 * <p>
 * Reviewer C armed a destructive confirm at 1440×900 and the block it grew scrolled out of
 * view, leaving the Cancel below the fold: the trigger was the last thing on screen, arming it
 * put a paragraph and two buttons where one button had been, and nothing moved the page. That
 * is the same failure as the 320 px clipping and it needs a different fix, because the control
 * is not too big for the viewport — it is simply no longer in it.
 * </p>
 *
 * <p>
 * <b>The trigger is put at the bottom edge on purpose.</b> Arming a control in the middle of a
 * tall page cannot reproduce this; the finding only exists where the growth has nowhere to go.
 * `block: "nearest"` is also what must NOT fire when the block is already comfortably on
 * screen, so the second half of this test pins that the page does not jump for a control that
 * needed nothing — a confirm that scrolls the page under somebody's cursor every time is the
 * cure being worse than C7.
 * </p>
 */
test("brings the armed block into view when the trigger was at the bottom edge", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, "/admin/devices", 0);
  await expect(page.getByText("Cupboard box").first()).toBeVisible();

  const wrapper = page.locator(CONFIRMS).last();
  const trigger = wrapper.locator("> button").first();

  // Put the trigger's bottom on the viewport's bottom edge, so the block it grows has to
  // push past it. `scrollIntoView({block: "end"})` inside the scrolling <main>, not a
  // mouse wheel: the amount is exact and the same on every run.
  await trigger.evaluate((node) => node.scrollIntoView({ block: "end" }));
  await expect(trigger).toBeInViewport();

  const before = await page.evaluate(() => document.querySelector("main")!.scrollTop);
  await trigger.click();

  await expect(wrapper.locator("> button")).toHaveCount(2);
  const confirm = wrapper.locator("> button").nth(0);
  const cancel = wrapper.locator("> button").nth(1);
  await expect(wrapper.locator("> p")).toBeInViewport();
  await expect(confirm, "the confirm scrolled out of view when it armed").toBeInViewport();
  await expect(cancel, "the Cancel is below the fold — C7 exactly").toBeInViewport();

  const after = await page.evaluate(() => document.querySelector("main")!.scrollTop);
  expect(after, "nothing scrolled, so the block cannot have been brought anywhere")
    .toBeGreaterThan(before);

  // And the other half: a control with room around it must not move the page at all.
  // `block: "center"` leaves 400-odd pixels below the trigger at this viewport, which is far
  // more than the paragraph and the button row need — so a scroll here would be `nearest`
  // behaving like `center`, and a confirm that jumps the page under somebody's cursor every
  // time it arms is the cure being worse than C7.
  await cancel.click();
  await expect(wrapper.locator("> button")).toHaveCount(1);
  await trigger.evaluate((node) => node.scrollIntoView({ block: "center" }));
  const settled = await page.evaluate(() => document.querySelector("main")!.scrollTop);
  await trigger.click();
  await expect(wrapper.locator("> button")).toHaveCount(2);
  expect(
    await page.evaluate(() => document.querySelector("main")!.scrollTop),
    "arming a control that was already on screen jumped the page",
  ).toBe(settled);
});

/**
 * C3, from the listening side: a disarm used to empty the live region, and an emptied live
 * region announces nothing. A screen-reader user could not tell a loaded control from a
 * resting one, and pressing Enter again to find out is precisely what must not be a way of
 * finding out.
 */
test("says out loud what it is about to do, and that it did not do it", async ({ page }) => {
  await open(page, "/admin/settings", 0);
  await expect(page.getByLabel(/Unlock time/)).toBeVisible();

  const wrapper = page.locator(CONFIRMS).first();
  const live = wrapper.locator('> span[aria-live="polite"]');
  await expect(live).toHaveText("");

  await wrapper.locator("> button").first().click();
  expect((await live.innerText()).trim().length).toBeGreaterThan(0);

  await page.keyboard.press("Escape");
  await expect(live).toHaveText("Cancelled — nothing was changed.");
  await expect(wrapper.locator("> button")).toHaveCount(1);
});

/**
 * C8 — forced colours, where a control's boundary is the only thing left of it.
 *
 * <p>
 * Windows High Contrast throws away every author background and substitutes the user's pair,
 * so a filled button whose only edge is its fill loses the fill, keeps the text, and is left
 * indistinguishable from a paragraph. Reviewer C found exactly that on the destructive
 * confirms: a control that shuts a door, rendered as body text. Measured as a COMPUTED
 * border in the emulated mode, because the class list cannot say what the mode did to it.
 * </p>
 */
test.describe("under forced colours", () => {
  /**
   * `page.emulateMedia`, not `test.use({ forcedColors })`.
   *
   * The declarative form is silently a no-op against the browser this suite launches —
   * probed directly: `matchMedia("(forced-colors: active)").matches` came back FALSE, so
   * every assertion below would have been measuring the ordinary mode and passing for the
   * wrong reason. The runtime call sets it for real, which the same probe confirmed.
   */
  test("every button and every banner still has a visible boundary", async ({ page }) => {
    await page.emulateMedia({ forcedColors: "active" });
    await open(page, "/admin/settings", 0);
    await expect(page.getByLabel(/Unlock time/)).toBeVisible();

    // Put the page into its blocked state so the warning banner is on screen too.
    await page.getByLabel(/Unlock time/).fill("400");
    await expect(page.getByText(/setting needs fixing before this can be saved/)).toBeVisible();

    const offenders = await page.evaluate(() => {
      const bad: string[] = [];
      const check = (el: Element, what: string) => {
        // Anything the size of a clipped `sr-only` region is not something a person can see
        // a boundary on, and asserting about it would be the test passing for no reason.
        const box = el.getBoundingClientRect();
        if (box.width * box.height < 200) return;
        const style = getComputedStyle(el);
        const width = Number.parseFloat(style.borderTopWidth);
        if (!(width > 0) || style.borderTopStyle === "none") {
          bad.push(`${what} <${el.tagName.toLowerCase()} class="${el.className}">`
            + ` "${(el as HTMLElement).innerText.slice(0, 40)}" has no border`);
        }
      };
      for (const el of document.querySelectorAll("button")) {
        if ((el as HTMLElement).offsetParent === null) continue;
        check(el, "button");
      }
      for (const el of document.querySelectorAll('[role="alert"], [role="status"], [data-banner]')) {
        if ((el as HTMLElement).offsetParent === null) continue;
        check(el, "banner");
      }
      return bad;
    });

    expect(offenders).toEqual([]);
  });

  /**
   * EVERY variant, and the thing that is actually at risk.
   *
   * <p>
   * The test above measures what `/admin/settings` happens to render, which is `default`,
   * `outline` and `ghost` — so `primary` and `danger` were asserted about by nobody, and a
   * variant is exactly the kind of thing that gets added without a screen to put it on. The
   * class strings come from the component's own table rather than being copied here, so a sixth
   * variant is measured the day it is added rather than the day somebody remembers.
   * </p>
   *
   * <p>
   * <b>And it measures both modes, because "has a border under forced colours" is not the
   * property.</b> Proved by mutation, not by reading: stripping `border border-transparent`
   * back off the `ghost` variant — the exact defect reviewer C reported — left a first draft of
   * this test GREEN. The boundary does not come from the variant at all, it comes from the
   * `button` rule in the `forced-colors` block in `index.css`, so every variant passes that
   * assertion whatever it declares, including one that declares nothing.
   * </p>
   *
   * <p>
   * What the transparent border on each variant buys is that <b>nothing moves</b> when the mode
   * fires: the 1 px edge is already in the box model, so the system colour lands on a box that
   * is already the right size. A variant without one grows by 2 px in each direction the moment
   * a user turns high contrast on — a whole layout reflowing under somebody who changed a
   * display setting. That is the property, it is a difference between two measurements, and it
   * is what the mutant is killed by.
   * </p>
   */
  test("gives every Button variant a boundary, and moves nothing to get it", async ({ page }) => {
    await open(page, "/admin/settings", 0);
    await expect(page.getByLabel(/Unlock time/)).toBeVisible();

    const variants = Object.entries(BUTTON_VARIANT_CLASS);
    expect(variants.length, "the variant table is empty — nothing was measured").toBeGreaterThan(0);

    // One button per variant, in a real page so the real stylesheet applies, left in place
    // across the mode change so the two measurements are of the same nodes.
    await page.evaluate((entries) => {
      const host = document.createElement("div");
      host.id = "c8-probe";
      document.body.append(host);
      for (const [variant, classes] of entries) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.variant = variant;
        // The same base classes `Button` puts on every one of them, then the variant's own.
        button.className = `inline-flex items-center justify-center gap-2 h-11 px-5 rounded-lg text-sm font-medium ${classes}`;
        button.textContent = variant;
        host.append(button);
      }
    }, variants);

    const measure = () => page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("#c8-probe button")].map((button) => {
        const style = getComputedStyle(button);
        const box = button.getBoundingClientRect();
        return {
          variant: button.dataset.variant!,
          border: Number.parseFloat(style.borderTopWidth),
          borderStyle: style.borderTopStyle,
          width: Math.round(box.width),
          height: Math.round(box.height),
        };
      }));

    const ordinary = await measure();
    await page.emulateMedia({ forcedColors: "active" });
    const forced = await measure();
    await page.evaluate(() => document.getElementById("c8-probe")?.remove());

    expect(forced).toHaveLength(variants.length);
    for (const [i, row] of forced.entries()) {
      const before = ordinary[i];
      expect(row.border, `the ${row.variant} variant has no border under forced colours`).toBeGreaterThan(0);
      expect(row.borderStyle, `the ${row.variant} variant's border is not drawn`).not.toBe("none");
      // The mutation-proved half: the variant must already carry the edge it is about to be
      // given a colour for.
      expect(before.border, `the ${row.variant} variant declares no border of its own, so forced colours will reflow it`)
        .toBeGreaterThan(0);
      expect(row.width, `the ${row.variant} variant changes width when forced colours fires`).toBe(before.width);
      expect(row.height, `the ${row.variant} variant changes height when forced colours fires`).toBe(before.height);
    }
    // eslint-disable-next-line no-console -- the measurement IS the point of this test
    console.log(`[C8] ${forced.map((r) => `${r.variant} ${r.border}px ${r.width}×${r.height}`).join(" · ")}`);
  });

  /** And the armed pair specifically, which is the control the finding was raised on. */
  test("an armed confirm keeps both of its buttons bounded", async ({ page }) => {
    await page.emulateMedia({ forcedColors: "active" });
    await open(page, "/admin/devices", 0);
    await expect(page.getByText("Cupboard box").first()).toBeVisible();

    const wrapper = page.locator(CONFIRMS).first();
    await wrapper.locator("> button").first().click();
    await expect(wrapper.locator("> button")).toHaveCount(2);

    const widths = await wrapper.locator("> button").evaluateAll(
      (nodes) => nodes.map((n) => Number.parseFloat(getComputedStyle(n).borderTopWidth)),
    );
    expect(widths).toHaveLength(2);
    for (const width of widths) expect(width).toBeGreaterThan(0);
  });
});
