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
        // By ROLE in the pair, not by position. C-H1 moved the way out to the front — focus
        // lands on it and Tab must reach the other option — so an index here would have
        // silently swapped what every assertion below is about.
        const confirm = wrapper.locator('> button[data-confirm="go"]');
        const cancel = wrapper.locator('> button[data-confirm="stop"]');
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
        const boxes: Record<string, { x: number; y: number; width: number; height: number }> = {};
        for (const [name, button] of [["confirm", confirm], ["cancel", cancel]] as const) {
          const box = (await button.boundingBox())!;
          boxes[name] = box;
          expect(box.height, `confirm ${i}'s ${name} is ${box.height} px tall`).toBeGreaterThanOrEqual(44);
          // And nothing spills sideways off a 320 px phone.
          expect(box.x + box.width, `confirm ${i}'s ${name} runs past the right edge`)
            .toBeLessThanOrEqual(size.width + 1);

          /**
           * Nor out of the BOX it was given. (B5)
           *
           * <p>
           * Found by mutation. A `minmax(6rem, 1fr)` column floor without the `min(…, 100%)`
           * guard is 192 px at a 32 px root, the Courts row hands this control 140 px, and a
           * `minmax` minimum is a hard minimum — so the button rendered 52 px wider than its
           * own wrapper, out over the card. The viewport check above cannot see it: 192 px
           * inside a 320 px phone is comfortably on screen, it is simply in the wrong place.
           * </p>
           */
          const overflow = await button.evaluate((node) =>
            Math.round(node.getBoundingClientRect().width - node.parentElement!.getBoundingClientRect().width));
          expect(overflow, `confirm ${i}'s ${name} is ${overflow} px wider than the box holding it`)
            .toBeLessThanOrEqual(1);
        }

        /**
         * SIDE BY SIDE, wherever side by side fits — the other half of the B5 ruling.
         *
         * <p>
         * Found by mutation: replacing the armed grid with a plain `block`, which stacks the
         * pair everywhere, left every assertion above green. Both buttons were still on screen,
         * still 44 px, still inside the phone — and the ruling says "two side-by-side buttons,
         * both visible together", because one above the other puts the Cancel twice as far from
         * the top of the block, which is the geometry the finding was raised on.
         * </p>
         *
         * <p>
         * <b>The bound is the CONTAINER's width, not the viewport's.</b> A first draft asserted
         * side-by-side at 820×1180 and found a real counter-example: "Deactivate" lives in the
         * Courts row's last grid column, which is an `auto` track about 135 px wide however wide
         * the window is. `auto-fit, minmax(96px, 1fr)` is deliberate — two columns whenever
         * 96 px each will fit, one when they will not, because two columns of four letters a
         * line is worse than stacking. So the contract to hold is that promise, measured against
         * the width the control was actually given.
         * </p>
         */
        /**
         * NO BUTTON BREAKS A WORD THAT WOULD HAVE FITTED. (B5 / C2)
         *
         * <p>
         * Found by looking, in the look pass, at `/admin/devices` at 320 px with a 32 px root
         * font: the pair went side by side in about 192 px of room and rendered "Dele / te"
         * beside "Cance / l" — two words that had all the room they needed, broken because the
         * grid's column floor was written in pixels and did not move with the text.
         * </p>
         *
         * <p>
         * <b>Not "never breaks".</b> `break-words` is on the control deliberately: a word wider
         * than any box it can be given must break the WORD rather than the layout, or it renders
         * out over the card, which is worse. The Courts row genuinely hands this control 140 px
         * at a 32 px root, and "Deactivate" does not fit in 140 px at 28 px text however the
         * grid is written. So the rule is the one that separates the two cases — a break is a
         * defect exactly when the word would have fitted.
         * </p>
         *
         * <p>
         * Measured against the button's own computed font on a canvas, so it asks the question
         * of the label the call site actually passed rather than of a list kept here.
         * </p>
         */
        for (const [name, button] of [["confirm", confirm], ["cancel", cancel]] as const) {
          const broke = await button.evaluate((node) => {
            const element = node as HTMLElement;
            const text = element.innerText.trim();
            const words = text.split(/\s+/).filter(Boolean);
            const target = [...node.childNodes].find((n) => n.nodeType === Node.TEXT_NODE) ?? node.firstChild;
            if (!target || words.length === 0) return null;
            const range = document.createRange();
            range.selectNodeContents(target);
            const lines = range.getClientRects().length;
            if (lines <= words.length) return null;

            const style = getComputedStyle(element);
            const room = element.getBoundingClientRect().width
              - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight)
              - Number.parseFloat(style.borderLeftWidth) - Number.parseFloat(style.borderRightWidth);
            const pen = document.createElement("canvas").getContext("2d")!;
            pen.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
            const widest = Math.max(...words.map((word) => pen.measureText(word).width));
            // A break is only honest if the widest word could not have fitted anyway.
            return widest <= room
              ? { text, words: words.length, lines, room: Math.round(room), widest: Math.round(widest) }
              : null;
          });
          expect(
            broke,
            `confirm ${i}'s ${name} breaks a word that had room for it: ${JSON.stringify(broke)}`,
          ).toBeNull();
        }

        const room = (await wrapper.boundingBox())!.width;
        // The floor is `6rem`, so what "enough room for both" means moves with the text size —
        // see the note on ARMED_GRID_CLASS for why this one is in rem where the chrome is not.
        const floor = await page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).fontSize) * 6);
        const fits = room >= floor * 2 + 8;
        if (fits) {
          expect(
            Math.abs(boxes.confirm.y - boxes.cancel.y),
            `confirm ${i} ("${idle}") stacks its buttons in ${Math.round(room)} px of room, which is enough for both`,
          ).toBeLessThanOrEqual(1);
          // C-H1: the way out is the LEFT of the two, because focus lands on it and Tab
          // moves right. It used to be on the right, so the natural Tab left the pair.
          expect(
            boxes.confirm.x,
            `confirm ${i} ("${idle}") does not put the confirm beside the way out`,
          ).toBeGreaterThan(boxes.cancel.x);
        } else {
          // Stacked is the right answer here, and both are still on screen and still 44 px —
          // which the assertions above have already established.
          expect(
            boxes.confirm.y,
            `confirm ${i} ("${idle}") has only ${Math.round(room)} px of room, so the pair must stack`,
          ).toBeGreaterThan(boxes.cancel.y);
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
 * The control's PADDING does not scale with the root font size. (B5 / B12)
 *
 * <p>
 * `CONTROL_CLASS` writes its padding as `px-[12px] py-[8px]` rather than `px-3 py-2`, and the
 * component says why: at a 32 px root `px-3` is 24 px a side, which is 48 px of padding inside
 * a 128 px column and left 80 px for a word needing 95. The text is meant to scale; the frame
 * around it is not.
 * </p>
 *
 * <p>
 * <b>Found by mutation, and it is a call site that breaks it.</b> Putting `className="px-4"`
 * back on the Courts row's "Deactivate" — which is what was there — restores 32 px of padding a
 * side at a 32 px root, 64 px inside a 140 px control, and no assertion anywhere noticed:
 * tailwind-merge rightly lets a caller's `px-4` beat the component's `px-[12px]`, so the rule
 * has to be enforced on the rendered result rather than on the class string. The word does not
 * fit either way at that size, so even the word-break check reads it as an honest break.
 * </p>
 *
 * <p>
 * <b>`/admin/settings` only, and the reason is a live one rather than an oversight.</b> Six
 * other call sites still hand this control padding in `rem` — `AdminDevices` (`h-8 px-3`,
 * twice), `AdminMembers` and `AdminWebhooks` (`h-11 px-4`), `Profile` (`h-9 px-3 text-xs`) and
 * `DeviceApiKeyPanel` (`h-9 px-3`) — and every one of them would fail this test today. None is
 * producing a broken word yet, because the containers they sit in are wide enough to absorb the
 * doubling; all six are the same latent defect the Courts row had. They are other lanes' files,
 * so this walks the one page whose call sites are in scope, and the finisher's report carries
 * the list. Widen the page list here the moment those `px-*` overrides go — or strip padding
 * centrally in `withoutFixedHeight`, the way a fixed height is already refused, and delete this
 * paragraph.
 * </p>
 */
test("keeps the frame round its words in pixels, whatever the root font size", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await open(page, "/admin/settings", 0);
  await expect(page.getByLabel(/Unlock time/)).toBeVisible();

  const padding = async () => {
    const wrappers = page.locator(CONFIRMS);
    const out: { label: string; x: number; y: number }[] = [];
    for (let i = 0; i < await wrappers.count(); i += 1) {
      const wrapper = wrappers.nth(i);
      await wrapper.locator("> button").first().evaluate((n: HTMLElement) => n.click());
      await expect(wrapper.locator("> button")).toHaveCount(2);
      out.push(...await wrapper.locator("> button").evaluateAll((nodes) => nodes.map((node) => {
        const style = getComputedStyle(node);
        return {
          label: (node as HTMLElement).innerText.trim().slice(0, 20),
          x: Number.parseFloat(style.paddingLeft),
          y: Number.parseFloat(style.paddingTop),
        };
      })));
      await wrapper.locator('> button[data-confirm="stop"]').evaluate((n: HTMLElement) => n.click());
    }
    return out;
  };

  const small = await padding();
  expect(small.length, "no armed confirm was measured").toBeGreaterThan(0);
  await page.addStyleTag({ content: "html { font-size: 32px !important; }" });
  const large = await padding();

  expect(large).toHaveLength(small.length);
  for (const [i, row] of large.entries()) {
    expect(row.x, `"${row.label}" has ${row.x} px of side padding at a 32 px root, ${small[i].x} px at 16 px`)
      .toBe(small[i].x);
    expect(row.y, `"${row.label}" has ${row.y} px of top padding at a 32 px root, ${small[i].y} px at 16 px`)
      .toBe(small[i].y);
  }
});

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
  const confirm = wrapper.locator('> button[data-confirm="go"]');
  const cancel = wrapper.locator('> button[data-confirm="stop"]');
  await expect(wrapper.locator("> p")).toBeInViewport();
  await expect(confirm, "the confirm scrolled out of view when it armed").toBeInViewport();
  await expect(cancel, "the Cancel is below the fold — C7 exactly").toBeInViewport();

  const after = await page.evaluate(() => document.querySelector("main")!.scrollTop);
  expect(after, "nothing scrolled, so the block cannot have been brought anywhere")
    .toBeGreaterThan(before);

  /**
   * And again with focus NOWHERE NEAR the control, which is the case only the explicit
   * `scrollIntoView` covers.
   *
   * <p>
   * Found by mutation: deleting that call left the assertions above green, because a press
   * that lands on the trigger also focuses it, so `armedFromTrigger` is true, so focus moves
   * to the Cancel — and moving focus scrolls the focused element into view all by itself. The
   * explicit call is what happens when focus is somewhere else entirely and the control is
   * therefore forbidden from taking it: `node.click()` dispatches the activation without
   * focusing, which is exactly that shape.
   * </p>
   */
  await cancel.click();
  await expect(wrapper.locator("> button")).toHaveCount(1);
  await page.getByRole("link", { name: "Skip to main content" }).focus();
  await trigger.evaluate((node) => node.scrollIntoView({ block: "end" }));
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await trigger.evaluate((node: HTMLElement) => node.click());

  await expect(wrapper.locator("> button")).toHaveCount(2);
  // `ratio: 0.99` — a bare `toBeInViewport()` passes on a single visible pixel, and a Cancel
  // whose top row of pixels is on screen is exactly the defect C7 describes. That looseness is
  // what let the mutant survive the first draft of this case.
  await expect(
    wrapper.locator("> button").last(),
    "armed without focus, nothing brought the block back into view",
  ).toBeInViewport({ ratio: 0.99 });
  await expect(wrapper.locator("> p")).toBeInViewport({ ratio: 0.99 });

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
 * C-H1 (HIGH) — the natural Tab out of the armed pair went out of the PAIR.
 *
 * <p>
 * Reviewer C armed a per-door shut from the keyboard, pressed Tab once, and landed on "Delete
 * this door" with the confirm silently cancelled behind them. Focus goes to the safe button
 * when a control arms; that button was the LAST thing in the group, so the obvious key left
 * the group, the blur disarmed it without a word, and the next control on the page was the
 * most destructive one there. The confirm sat behind the cancel, reachable only by Shift+Tab.
 * </p>
 *
 * <p>
 * jsdom implements no Tab at all, so this is the only place the actual keypress can be held:
 * a real browser, a real focus order, a real focusout.
 * </p>
 */
test("Tab from the armed way out reaches the confirm instead of leaving the control", async ({ page }) => {
  await open(page, "/admin/devices", 0);
  await expect(page.getByText("Cupboard box").first()).toBeVisible();

  const wrapper = page.locator(CONFIRMS).first();
  const confirm = wrapper.locator('> button[data-confirm="go"]');
  const cancel = wrapper.locator('> button[data-confirm="stop"]');
  const live = wrapper.locator('> span[aria-live="polite"]');

  // Armed from the keyboard, which is the only way the finding reproduces: focus has to be on
  // the trigger for the control to hand it to the safe button.
  await wrapper.locator("> button").first().focus();
  await page.keyboard.press("Enter");
  await expect(wrapper.locator("> button")).toHaveCount(2);
  await expect(cancel).toBeFocused();

  await page.keyboard.press("Tab");

  // Still armed, still saying what it was about to do, and the keyboard is on the other option
  // rather than on whatever came next in the document.
  await expect(confirm, "Tab left the armed pair instead of reaching the confirm").toBeFocused();
  await expect(wrapper.locator("> button")).toHaveCount(2);
  await expect(live).not.toHaveText("Cancelled — nothing was changed.");

  // And back the way it came, which is the other half of a two-control group.
  await page.keyboard.press("Shift+Tab");
  await expect(cancel).toBeFocused();
  await expect(wrapper.locator("> button")).toHaveCount(2);
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

  /**
   * B5 — and the two of them are not the SAME bounded box.
   *
   * <p>
   * Everything that tells the pair apart ordinarily is colour: the confirm is filled amber,
   * the way out is a white outline. Forced colours throws both away, and the rule above then
   * gives each the same 1 px `ButtonText` edge — so reviewer B's screenshot shows two
   * identical boxes side by side, one of which shuts a door, distinguishable only by reading
   * the words on them. That is exactly the case a non-colour distinction is required for.
   * </p>
   *
   * <p>
   * Measured as computed style in the emulated mode, and measured in the ORDINARY mode too:
   * the point is that the difference appears where the colour disappears, and a test that only
   * looked at forced colours could not tell a deliberate distinction from a leftover.
   * </p>
   */
  test("tells the destructive half from the safe half without using colour", async ({ page }) => {
    await open(page, "/admin/devices", 0);
    await expect(page.getByText("Cupboard box").first()).toBeVisible();

    const wrapper = page.locator(CONFIRMS).first();
    await wrapper.locator("> button").first().click();
    await expect(wrapper.locator("> button")).toHaveCount(2);

    const edges = () => wrapper.locator("> button").evaluateAll((nodes) => nodes.map((n) => {
      const style = getComputedStyle(n);
      return {
        role: (n as HTMLElement).dataset.confirm,
        width: Number.parseFloat(style.borderTopWidth),
        style: style.borderTopStyle,
      };
    }));

    await page.emulateMedia({ forcedColors: "active" });
    const forced = await edges();
    const go = forced.find((e) => e.role === "go")!;
    const stop = forced.find((e) => e.role === "stop")!;
    expect(go, "the armed pair has no destructive half").toBeTruthy();
    expect(stop, "the armed pair has no way out").toBeTruthy();
    expect(
      `${go.width}${go.style}` !== `${stop.width}${stop.style}`,
      `under forced colours both buttons are ${go.width}px ${go.style} — identical`,
    ).toBe(true);
    console.log(`[B5] forced colours: go ${go.width}px ${go.style} · stop ${stop.width}px ${stop.style}`);
  });
});
