import { useLayoutEffect, useState } from "react";

/**
 * Below this many root ems of window height a sheet drops what it duplicates (R10 L10-6): at
 * 320×640 with 200 % text that is 20rem, and the accept sheet's three stacked actions took ~45 %
 * of it, leaving ~95px of body. 390×844 at 200 % (26rem) and 100 % text anywhere stay above it.
 */
export const SHORT_SHEET_REM = 24;

function rootFontPx(): number {
  const size = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(size) && size > 0 ? size : 16;
}

/**
 * True while the window is shorter than {@link SHORT_SHEET_REM} root ems — a HEIGHT measured in
 * the text's own unit, which no media query can do (a media query's `rem` ignores the page's
 * font size). Re-measured on resize and when the text size changes (a 1rem probe resizes with it).
 */
export function useShortSheet(): boolean {
  const [short, setShort] = useState(false);
  useLayoutEffect(() => {
    const measure = () => setShort(window.innerHeight < SHORT_SHEET_REM * rootFontPx());
    measure();
    const probe = document.createElement("div");
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;width:1rem;height:0;top:0;left:0";
    document.body.appendChild(probe);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(probe);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      probe.remove();
      window.removeEventListener("resize", measure);
    };
  }, []);
  return short;
}
