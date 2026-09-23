import { useCallback, useSyncExternalStore } from "react";

/**
 * Whether a CSS media query matches, kept live as the viewport changes.
 *
 * <p>
 * Built on `useSyncExternalStore` so a resize (or a rotated phone) re-renders exactly the
 * components that asked, with no effect-then-setState flash. <b>SSR-safe and API-safe:</b> with no
 * `window`, or an engine without `matchMedia`, it answers `false` — every caller here treats
 * `false` as "the small screen", which is the mobile-first default the product is designed from.
 * </p>
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    const list = mediaList(query);
    if (!list) return () => undefined;
    // `addEventListener` on a MediaQueryList is Safari 14+; the deprecated `addListener` is the
    // only thing older WebKit offers. Both are checked so neither engine throws.
    if (typeof list.addEventListener === "function") {
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    }
    list.addListener?.(onChange);
    return () => list.removeListener?.(onChange);
  }, [query]);
  const snapshot = useCallback(() => mediaList(query)?.matches ?? false, [query]);
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}

/** The `sm` breakpoint (Tailwind's default, 640px) — where sheets become popovers and dialogs centre. */
export const SM_UP = "(min-width: 640px)";

/** `true` at the `sm` breakpoint and above: pointer-and-popover territory rather than thumb-and-sheet. */
export function useIsSmUp(): boolean {
  return useMediaQuery(SM_UP);
}

function mediaList(query: string): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return window.matchMedia(query);
}

function serverSnapshot(): boolean {
  return false;
}
