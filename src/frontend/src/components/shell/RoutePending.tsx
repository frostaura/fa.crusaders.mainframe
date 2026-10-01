import { useEffect, useLayoutEffect } from "react";
import { useLocation } from "react-router-dom";
import { clearNavigationPending, markNavigationPending, useNavigationPending } from "@/routeChunks";

/** A plain left click on a same-origin link to another page: what the router will navigate. */
function followedPath(event: MouseEvent): string | null {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const target = event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (!(target instanceof HTMLAnchorElement) || target.hasAttribute("download")) return null;
  if (target.target && target.target !== "_self") return null;
  const url = new URL(target.href, window.location.href);
  if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return null;
  return url.pathname;
}

/**
 * Watches for followed links (capture phase, so before the router's own handler) and clears the
 * cue once the shell's location has moved. Draws the cue: a thin bar along the foot of the top bar,
 * decoration only — `<main aria-busy>` is what assistive technology is told.
 */
export function RoutePendingBar() {
  const pending = useNavigationPending();
  const { pathname } = useLocation();

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const path = followedPath(event);
      if (path === null || !markNavigationPending(path)) return;
      // The router pushes the URL at once and renders in a transition, so a followed link has
      // moved `location` by the next task. One that did not navigate (a handler that kept the
      // click for itself) must not leave the cue up.
      window.setTimeout(() => { if (window.location.pathname !== path) clearNavigationPending(); }, 0);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  // Layout, not passive: the page that just committed must not paint once more under a busy bar.
  useLayoutEffect(() => { clearNavigationPending(); }, [pathname]);

  if (!pending) return null;
  return (
    <div
      aria-hidden="true"
      data-route-pending=""
      className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 animate-pulse bg-accent-strong motion-reduce:animate-none"
    />
  );
}
