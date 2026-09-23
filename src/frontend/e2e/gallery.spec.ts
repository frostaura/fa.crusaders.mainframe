import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { SESSION_ANON, serveApi, test, expect } from "./fixtures";

/**
 * The design-system gallery (`/dev/primitives`), audited by axe in a real engine.
 *
 * <p>
 * <b>Why here and not in vitest.</b> Contrast, target size and forced colours are properties of
 * PAINTED pixels; jsdom paints nothing. Every section is run through axe with the WCAG 2.0 / 2.1 /
 * 2.2 A and AA rule sets, once with the page in light and once in dark — the static specimens
 * render in a light AND a dark panel either way, and the page theme decides everything that
 * portals (dialogs, sheets, popovers, menus, the select list, toasts). Then each overlay is opened
 * and audited in both themes, and a forced-colours pass checks that every control still draws an
 * edge once the mode throws the author's fills away.
 * </p>
 *
 * <p>
 * The page reads nothing from the API. The shell around it may ask who is signed in, so the
 * strict fixture answers that and nothing else.
 * </p>
 */

const SECTIONS = [
  "foundations", "icons", "watermark", "buttons", "fields", "datetime", "overlays",
  "feedback", "data", "grid", "shell", "passcard", "legacy",
] as const;

const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function openGallery(page: Page, section: string, theme: Theme) {
  await serveApi(page, [
    { path: "/api/v1/whoami", body: SESSION_ANON },
    { path: "/api/v1/session", body: SESSION_ANON },
  ]);
  await page.goto(`/dev/primitives?section=${section}&theme=${theme}`);
  await expect(page.locator(`[data-gallery-section="${section}"]`)).toBeVisible();
  await expect(page.locator("html")).toHaveClass(theme === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b)/);
  await page.evaluate(() => document.fonts.ready);
}

type AxeResults = Awaited<ReturnType<AxeBuilder["analyze"]>>;

/** One line per failing node — the rule, the element, and axe's own summary of why. */
function describeViolations(results: AxeResults): string {
  return results.violations
    .map((v) => [
      `${v.id} (${v.impact}): ${v.help}`,
      ...v.nodes.map((n) => `    ${n.target.join(" ")} — ${(n.failureSummary ?? "").replace(/\s+/g, " ")}`),
    ].join("\n"))
    .join("\n");
}

/**
 * A viewport tall enough that every specimen is on screen. The app scrolls its `<main>`, and axe
 * marks text below that scroller's fold "partially obscured" and skips its contrast check — at the
 * default height that was dozens of unmeasured nodes a section.
 */
async function tallViewport(page: Page) {
  const { width } = page.viewportSize()!;
  await page.setViewportSize({ width, height: 9000 });
}

async function audit(page: Page, selector: string) {
  const results = await new AxeBuilder({ page }).withTags(TAGS).include(selector).analyze();
  expect(results.violations, describeViolations(results)).toEqual([]);
}

test.describe("every gallery section passes axe", () => {
  // Animations would let axe sample a colour mid-fade; reduced motion lands every element at rest.
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
  });

  for (const theme of THEMES) {
    for (const section of SECTIONS) {
      test(`${section}, page ${theme}`, async ({ page }) => {
        await tallViewport(page);
        await openGallery(page, section, theme);
        await audit(page, "[data-gallery]");
      });
    }
  }
});

type Overlay = {
  name: string;
  section: string;
  open: (page: Page) => Promise<void>;
  /** What axe audits once it is open. */
  target: string;
};

const clickButton = (name: string | RegExp) => async (page: Page) => {
  await page.getByRole("button", { name }).first().click();
};

const OVERLAYS: Overlay[] = [
  { name: "dialog", section: "overlays", open: clickButton("Open dialog"), target: "[role=dialog]" },
  { name: "bottom sheet", section: "overlays", open: clickButton("Open bottom sheet"), target: "[role=dialog]" },
  { name: "side sheet", section: "overlays", open: clickButton("Open side sheet"), target: "[role=dialog]" },
  { name: "popover", section: "overlays", open: clickButton("Open popover"), target: "[data-slot=popover-content]" },
  { name: "info popover", section: "overlays", open: clickButton("More about Late-cancellation window"), target: "[data-slot=popover-content]" },
  { name: "dropdown menu", section: "overlays", open: clickButton("Member actions"), target: "[role=menu]" },
  {
    name: "tooltip",
    section: "overlays",
    // Keyboard focus, as a keyboard user arrives. Centred FIRST: Radix closes a tooltip when its
    // trigger's scroller scrolls, and focusing a trigger at the viewport's edge nudges `<main>` —
    // traced on the phone project: open, a scroll event on #main-content, closed, inside 20ms.
    open: async (page) => {
      await page.getByRole("button", { name: "Grid settings" }).evaluate((el) => el.scrollIntoView({ block: "center" }));
      await page.getByRole("button", { name: "Open popover" }).focus();
      await page.keyboard.press("Tab");
      await expect(page.getByRole("button", { name: "Grid settings" })).toBeFocused();
    },
    target: "[data-slot=tooltip-content]",
  },
  {
    name: "select list",
    section: "fields",
    open: async (page) => { await page.getByRole("combobox", { name: "Group" }).first().click(); },
    target: "[role=listbox]",
  },
  {
    name: "member combobox",
    section: "fields",
    open: async (page) => { await page.getByRole("combobox", { name: /Book for/ }).first().click(); },
    target: "[data-slot=popover-content], [role=dialog]",
  },
  { name: "date picker", section: "datetime", open: clickButton(/^Jump to a date/), target: "[data-slot=popover-content], [role=dialog]" },
  { name: "action bar", section: "shell", open: clickButton("Show the action bar"), target: "[data-action-bar]" },
  { name: "toast", section: "feedback", open: clickButton("Toast: success"), target: "[data-toast-viewport]" },
];

test.describe("every overlay passes axe once open", () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
  });

  for (const theme of THEMES) {
    for (const overlay of OVERLAYS) {
      test(`${overlay.name}, page ${theme}`, async ({ page }) => {
        await openGallery(page, overlay.section, theme);
        await overlay.open(page);
        await expect(page.locator(overlay.target).first()).toBeVisible();
        await audit(page, overlay.target);
      });
    }
  }
});

/** Every control in the gallery that should draw its own edge. Links draw an underline instead. */
const CONTROLS = [
  "button", "input:not([type=hidden])", "textarea", "select",
  "[role=checkbox]", "[role=switch]", "[role=radio]", "[role=combobox]", "[role=tab]",
].map((s) => `[data-gallery] ${s}`).join(", ");

type Edge = { name: string; width: number; style: string; colour: string; visible: boolean };

async function edgesOf(page: Page): Promise<Edge[]> {
  return page.locator(CONTROLS).evaluateAll((els) => els.map((el) => {
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    const name = el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 40) ?? el.tagName;
    return {
      name: `${el.tagName.toLowerCase()} "${name}"`,
      width: parseFloat(style.borderTopWidth),
      style: style.borderTopStyle,
      colour: style.borderTopColor,
      visible: box.width > 0 && box.height > 0,
    };
  }));
}

test.describe("forced colours", () => {
  const CONTROL_SECTIONS = ["watermark", "buttons", "fields", "datetime", "overlays", "feedback", "data", "grid", "shell", "legacy"];

  for (const section of CONTROL_SECTIONS) {
    test(`every control in ${section} keeps a visible edge`, async ({ page }) => {
      await page.emulateMedia({ forcedColors: "active" });
      await openGallery(page, section, "light");
      const edges = (await edgesOf(page)).filter((e) => e.visible);
      expect(edges.length, "the section has controls to check").toBeGreaterThan(0);
      const bare = edges.filter((e) => !(e.width > 0 && e.style !== "none" && e.colour !== "rgba(0, 0, 0, 0)"));
      expect(bare.map((e) => `${e.name}: ${e.width}px ${e.style} ${e.colour}`)).toEqual([]);
    });
  }

  test("hides the watermark, and keeps the QR panel white", async ({ page }) => {
    await page.emulateMedia({ forcedColors: "active" });
    await openGallery(page, "watermark", "dark");
    const glyphs = page.locator("[data-gallery] .wm-glyph");
    expect(await glyphs.count()).toBeGreaterThan(0);
    const shown = await glyphs.evaluateAll((els) => els.filter((el) => getComputedStyle(el).display !== "none").length);
    expect(shown).toBe(0);

    await page.goto("/dev/primitives?section=passcard&theme=dark");
    const panels = page.locator("[data-gallery] [data-qr-panel]");
    await expect(panels.first()).toBeVisible();
    const fills = await panels.evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor));
    expect(new Set(fills)).toEqual(new Set(["rgb(255, 255, 255)"]));
  });
});

test.describe("the watermark phases", () => {
  test("hover and press are brighter than rest, and selected, busy and disabled show no glyph", async ({ page }) => {
    await openGallery(page, "watermark", "light");
    const panel = page.locator('[data-theme-panel="light"]');
    const opacityOf = async (selector: string) =>
      panel.locator(`${selector} .wm-glyph`).evaluateAll((els) => els.map((el) => Number(getComputedStyle(el).opacity)));
    const rest = await opacityOf('[data-watermark="cell"]:not([data-demo-state]):not([aria-busy]):not([disabled]):not([data-state])');
    const hover = await opacityOf('[data-watermark="cell"][data-demo-state="hover"]');
    const press = await opacityOf('[data-watermark="cell"][data-demo-state="press"]');
    expect(rest[0]).toBeGreaterThan(0);
    expect(hover[0]).toBeGreaterThan(rest[0]);
    expect(press[0]).toBeGreaterThan(hover[0]);
    const hidden = await panel.locator('[data-watermark][data-state="on"] .wm-glyph, [data-watermark][aria-busy="true"] .wm-glyph, [data-watermark]:disabled .wm-glyph')
      .evaluateAll((els) => els.map((el) => getComputedStyle(el).display));
    expect(hidden.length).toBeGreaterThan(0);
    expect(new Set(hidden)).toEqual(new Set(["none"]));
  });
});

test.describe("the page", () => {
  test("never scrolls sideways at 320px, whichever section is open", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    for (const section of SECTIONS) {
      await openGallery(page, section, "light");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, section).toBeLessThanOrEqual(0);
    }
  });

  test("the theme switch repaints portaled overlays", async ({ page }) => {
    await openGallery(page, "overlays", "light");
    await page.getByRole("radio", { name: "Dark" }).click();
    await expect(page).toHaveURL(/theme=dark/);
    await expect(page.locator("html")).toHaveClass(/\bdark\b/);
    await page.getByRole("button", { name: "Open dialog" }).click();
    const surface = await page.locator("[role=dialog]").evaluate((el) => getComputedStyle(el).backgroundColor);
    // bg.raised, dark: #1A2740.
    expect(surface).toBe("rgb(26, 39, 64)");
  });
});
