import { expect, test } from "./fixtures";

/**
 * `SegmentedTabs`, measured in an engine that has a layout.
 *
 * <p>
 * Everything here is invisible to the unit runner. jsdom reports every `offsetWidth`,
 * `offsetLeft` and `getBoundingClientRect()` as 0, so the thumb's geometry, the 44 px floor at
 * a 32 px root font size and the flip to a vertical tablist are all assertions no vitest test
 * can make. This repo has been bitten twice by a length guessed rather than measured —
 * `top-[100px]` for the toast strip and `5rem` for the heading offset, both correct at a 16 px
 * root and wrong at 32 — so the rule is that a number is measured in a browser.
 * </p>
 *
 * <p>
 * The page is `/dev/primitives`, which exists only under `npm run dev` (the server this suite
 * starts) and is folded out of the production build. The first real consumer of the control is
 * `/my-code`, which belongs to another lane; a primitive whose geometry nothing measures until
 * then is a primitive that is wrong on the phone nobody tested.
 * </p>
 */

const TABS = "/dev/primitives";

/** The club's text at twice the size, which is what a 32 px root font means in practice. */
async function enlargeRootFont(page: import("@playwright/test").Page) {
  await page.addStyleTag({ content: "html { font-size: 32px; }" });
}

test.describe("the capsule", () => {
  test("puts the thumb exactly over the selected segment, at both widths", async ({ page }) => {
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 568 });
      await page.goto(TABS);

      const group = page.getByTestId("tabs-two");
      const thumb = group.locator("[data-segmented-thumb]");
      const booking = group.getByRole("tab", { name: "Booking code" });
      const member = group.getByRole("tab", { name: "Member code" });

      await expect(thumb).toHaveCount(1);

      const over = async (tab: typeof booking) => {
        const t = (await thumb.boundingBox())!;
        const b = (await tab.boundingBox())!;
        // Within a pixel. A fraction-based thumb (`translateX(50%)`) would land here for one
        // of the two segments and be out by the difference in label width for the other —
        // "Booking code" and "Member code" are not the same width, and they are further apart
        // the larger the text gets.
        expect(Math.abs(t.x - b.x), `thumb x at ${width}px`).toBeLessThanOrEqual(1);
        expect(Math.abs(t.width - b.width), `thumb width at ${width}px`).toBeLessThanOrEqual(1);
      };

      await over(booking);
      await member.click();
      await expect(member).toHaveAttribute("aria-selected", "true");
      // The thumb transitions over `--fb-enter` (220 ms); wait for it to land rather than
      // racing it, which is the flake this assertion would otherwise be.
      await page.waitForTimeout(400);
      await over(member);
    }
  });

  test("every segment is a 44 px target at 320 px, and still is at a 32 px root font", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto(TABS);

    for (const enlarge of [false, true]) {
      if (enlarge) await enlargeRootFont(page);
      const tabs = page.getByTestId("tabs-two").getByRole("tab");
      for (const tab of await tabs.all()) {
        const box = (await tab.boundingBox())!;
        // B12's rule: a touch target is a fingertip, so the floor is in PIXELS and does not
        // double with the text. `min-h-11` would be 88 px here, which is the defect that rule
        // exists to stop.
        expect(box.height, `height, enlarged=${enlarge}`).toBeGreaterThanOrEqual(44);
        expect(box.width, `width, enlarged=${enlarge}`).toBeGreaterThanOrEqual(44);
      }
    }
  });

  test("never pushes the page sideways, at 320 px or at a 32 px root", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto(TABS);
    for (const enlarge of [false, true]) {
      if (enlarge) await enlargeRootFont(page);
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      expect(overflow.scrollWidth, `enlarged=${enlarge}`).toBeLessThanOrEqual(overflow.innerWidth);
    }
  });

  test("stacks, and becomes a vertical tablist, when the labels stop fitting", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto(TABS);

    const group = page.getByTestId("tabs-long");
    // Three long labels at 320 px already do not fit side by side.
    await expect(group.getByRole("tablist")).toHaveAttribute("aria-orientation", "vertical");

    const boxes = await Promise.all((await group.getByRole("tab").all()).map((t) => t.boundingBox()));
    // Stacked means one per row: every segment shares an x and differs in y.
    expect(new Set(boxes.map((b) => Math.round(b!.x))).size).toBe(1);
    expect(new Set(boxes.map((b) => Math.round(b!.y))).size).toBe(boxes.length);
  });

  test("stays horizontal at a width where two short labels do fit", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto(TABS);
    // Both halves of the conditional: a control that always stacked would pass the test above.
    await expect(page.getByTestId("tabs-two").getByRole("tablist"))
      .toHaveAttribute("aria-orientation", "horizontal");
  });
});

test.describe("the keyboard", () => {
  test("arrows move focus and do not fire a request", async ({ page }) => {
    const calls: string[] = [];
    page.on("request", (r) => { if (r.url().includes("/api/")) calls.push(r.url()); });

    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto(TABS);

    const group = page.getByTestId("tabs-two");
    await group.getByRole("tab", { name: "Booking code" }).focus();
    await page.keyboard.press("ArrowRight");

    await expect(group.getByRole("tab", { name: "Member code" })).toBeFocused();
    // Still the first one, because arrows do not activate — which on `/my-code` is what stops
    // a keyboard user minting codes into a paced, rate-limited endpoint shared with login.
    await expect(group.getByRole("tab", { name: "Booking code" })).toHaveAttribute("aria-selected", "true");

    await page.keyboard.press("Enter");
    await expect(group.getByRole("tab", { name: "Member code" })).toHaveAttribute("aria-selected", "true");
    expect(calls, "no API call belongs to a tab press on this page").toEqual([]);
  });

  test("is one tab stop for the whole group", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto(TABS);
    const group = page.getByTestId("tabs-two");
    // `evaluateAll` does NOT auto-wait — it evaluates against whatever the locator resolves to
    // at that instant, which on a cold page is an empty list, and the failure reads as "the
    // control has no tab stops" rather than "React has not rendered yet". Measured: it
    // returned `[]`.
    await expect(group.getByRole("tab")).toHaveCount(2);
    const stops = await group.getByRole("tab").evaluateAll(
      (els) => els.map((el) => (el as HTMLElement).tabIndex),
    );
    expect(stops.filter((t) => t === 0)).toHaveLength(1);
  });

  test("reaches a disabled segment and hears why", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto(TABS);

    const group = page.getByTestId("tabs-disabled");
    const off = group.getByRole("tab", { name: "Booking code" });
    await expect(off).toHaveAttribute("aria-disabled", "true");
    await group.getByRole("tab", { name: "Member code" }).focus();
    await page.keyboard.press("ArrowLeft");
    // `disabled` would have taken it out of the tab order and made the reason unreachable.
    await expect(off).toBeFocused();
    await expect(off).toHaveAccessibleDescription(/no booking starting in the next 2 hours/);
  });
});

test.describe("the modes that throw the styling away", () => {
  test("under reduced motion the thumb jumps rather than easing", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto(TABS);

    const thumb = page.getByTestId("tabs-two").locator("[data-segmented-thumb]");
    /*
     * `transition-property`, not `transition-duration` — and that is a measurement, not a
     * preference.
     *
     * The first cut asserted `transition-duration: 0s` and read 0.22s. Tailwind's
     * `transition-none` sets `transition-property: none` and leaves the duration where it
     * was, so the thumb genuinely does not move and the duration genuinely still says 220ms.
     * Asserting the duration would have failed a correct implementation; asserting the
     * property is what the rule actually is.
     *
     * And it is `none`, not a shortened transition: `index.css` records the lesson that a
     * 1 ms transition made a hovered cell SNAP 1 px, which is worse than the motion it
     * replaced.
     */
    await expect(thumb).toHaveCSS("transition-property", "none");
  });

  test("under forced colours the capsule still has an edge and the tabs still have theirs", async ({ page }) => {
    await page.emulateMedia({ forcedColors: "active" });
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto(TABS);

    const group = page.getByTestId("tabs-two");
    for (const el of [group.getByRole("tablist"), ...(await group.getByRole("tab").all())]) {
      const colour = await el.evaluate((n) => getComputedStyle(n).borderTopColor);
      // The mode throws away every author fill; the transparent border is what it turns into
      // a real one. Without it the capsule is three words in a row.
      expect(colour).not.toBe("rgba(0, 0, 0, 0)");
    }
  });
});
