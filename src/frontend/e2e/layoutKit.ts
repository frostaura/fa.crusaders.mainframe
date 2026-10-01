import type { Page } from "@playwright/test";

/**
 * Shared measuring for the R4 form-factor specs (SPEC 2/3): the five widths every layout is held
 * at, 200 % text, and the questions a layout test asks of a real engine — does anything scroll
 * sideways, does any TEXT paint off screen (element rects cannot see text overflow; gotchas-frontend-layout),
 * how much of the available width the content uses, and where two boxes sit relative to each other.
 */
export const WIDTHS = [390, 768, 1024, 1280, 1920] as const;
export type Width = (typeof WIDTHS)[number];

export const HEIGHT: Record<Width, number> = { 390: 844, 768: 1024, 1024: 768, 1280: 800, 1920: 1080 };

const BIG = "html { font-size: 32px; }";

/** 200 % text is a 32px root after navigation (gotchas-frontend-layout). */
export async function bigText(page: Page) {
  await page.addStyleTag({ content: BIG });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
}

/** How far anything scrolls sideways — the document and `<main>`, the shell's scroller. */
export async function sideways(page: Page): Promise<number> {
  return page.evaluate(() => {
    const els = [document.scrollingElement, ...document.querySelectorAll("main")].filter(Boolean) as Element[];
    return Math.max(...els.map((el) => el.scrollWidth - el.clientWidth));
  });
}

/** Text nodes under `selector` that paint outside the viewport (Range rects, skipping horizontal scrollers). */
export async function textOffScreen(page: Page, selector = "#main-content"): Promise<string[]> {
  return page.evaluate((sel) => {
    const out: string[] = [];
    const root = document.querySelector(sel);
    if (!root) return ["<missing>"];
    const scrollsX = (el: Element | null): boolean => {
      for (let at = el; at && at !== root; at = at.parentElement) {
        const o = getComputedStyle(at).overflowX;
        if (o === "auto" || o === "scroll" || o === "hidden") return true;
      }
      return false;
    };
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim() || scrollsX(node.parentElement)) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        if (rect.width > 0 && (rect.right > window.innerWidth + 1 || rect.left < -1)) out.push(node.textContent.trim().slice(0, 40));
      }
    }
    return out;
  }, selector);
}

export type Box = { x: number; y: number; width: number; height: number; right: number; bottom: number; display: string };

/** The rect of the first match (null if absent or `display: none`). */
export async function box(page: Page, selector: string): Promise<Box | null> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const display = getComputedStyle(el).display;
    if (display === "none") return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom, display };
  }, selector);
}

/**
 * Width used: the horizontal span of the page's painted content (every visible element's union
 * under `#main-content`, excluding full-bleed backgrounds) ÷ the width available to it (main's
 * client width, less the admin rail when there is one). SPEC 1's measure.
 */
export async function widthUsed(page: Page): Promise<number> {
  return page.evaluate(() => {
    const main = document.querySelector("#main-content") as HTMLElement;
    const shell = main.querySelector("[data-page-shell]") ?? main;
    let left = Infinity;
    let right = -Infinity;
    for (const el of shell.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.position === "fixed") continue;
      // A leaf-ish box with paint: text, a control, a bordered or filled card.
      const paints = el.children.length === 0 || cs.borderTopWidth !== "0px" || cs.backgroundColor !== "rgba(0, 0, 0, 0)";
      if (!paints) continue;
      left = Math.min(left, r.left);
      right = Math.max(right, r.right);
    }
    const rail = document.querySelector("[data-admin-rail]");
    const railWidth = rail && getComputedStyle(rail).display !== "none" ? rail.getBoundingClientRect().width : 0;
    const available = main.clientWidth - railWidth;
    return right > left ? (right - left) / available : 0;
  });
}

/** Wait for webfonts so a layout test measures the face the product ships. */
export async function fontsReady(page: Page) {
  await page.evaluate(() => document.fonts.ready.then(() => null));
}
