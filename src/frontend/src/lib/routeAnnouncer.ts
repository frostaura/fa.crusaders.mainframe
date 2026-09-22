/**
 * What each route is called, and therefore what the browser tab says. (C6)
 *
 * <p>
 * <b>The finding.</b> This is a single-page app, so nothing in it ever set
 * <code>document.title</code>: reviewer C measured "Crusaders Mainframe" on every one of
 * seven screens. A tab title is not decoration — it is the first thing a screen reader
 * announces on a page change, it is what a tab strip with nine tabs open is navigated by,
 * and it is what a bookmark and a browser-history entry are named after. One string for
 * the whole product means all nine tabs read the same, every bookmark reads the same, and
 * a screen-reader user tabbing back to the window is told nothing about where they are.
 * </p>
 *
 * <p>
 * <b>Why a table rather than a `title` prop on each page.</b> A prop is a thing a new page
 * can forget, silently, and the failure is invisible to whoever wrote it — their tab says
 * the old title and they read it as the browser being slow. The table is enumerable, so
 * <code>route-titles.test.ts</code> reads every <code>path=</code> out of `App.tsx` and
 * fails when one of them has no name here. A route cannot be added without being named.
 * </p>
 */

/** The product, as the tab suffix. Not the club: a tenant's own name is not in the bundle. */
export const APP_NAME = "Crusaders Mainframe";

/**
 * Every route in `App.tsx`, in the order it is matched.
 *
 * <p>
 * Order matters exactly where it matters in the router: <code>/admin/doors/log</code> is
 * declared before <code>/admin/doors/:id</code> or the club log is named "Door" — the same
 * ordering trap the route table itself carries a comment about.
 * </p>
 *
 * <p>
 * A <code>:param</code> segment matches any one non-empty segment, which is all this needs:
 * the names here are per-ROUTE, not per-record. A door's own name belongs on its page's
 * <code>&lt;h1&gt;</code>, where it is read from data this module does not have.
 * </p>
 */
const ROUTE_PAGE_NAMES: ReadonlyArray<readonly [string, string]> = [
  ["/", "Home"],
  ["/login", "Sign in"],
  ["/register", "Join the club"],
  ["/verify-email/:token", "Confirm your email"],
  ["/forgot-password", "Forgotten password"],
  ["/reset-password/:token", "Choose a new password"],
  ["/welcome/:token", "Welcome"],
  ["/wallet", "Wallet"],
  ["/wallet/topup", "Top up"],
  ["/wallet/topup/:topupId", "Top-up status"],
  ["/schedule", "Bookings"],
  ["/profile", "Profile"],
  ["/change-password", "Change password"],
  ["/my-code", "My code"],
  ["/court-code", "My code"],
  // item 16 — the always-reachable guide.
  ["/how-it-works", "How it works"],
  ["/reports", "Reports"],
  ["/admin/members", "Members"],
  ["/admin/webhooks", "Webhooks"],
  ["/admin/biometric", "Members"],
  /**
   * The old admin paths. Still named, because they are still ROUTES — permanent redirects
   * rather than deletions (D3 §3.1), and the title is set before the redirect resolves: a
   * redirect renders for a tick, and the suite reads every `path=` in the router without
   * caring what it renders.
   */
  ["/admin/devices", "Devices"],
  ["/admin/doors", "Doors"],
  ["/admin/doors/log", "Door log"],
  ["/admin/doors/:id", "Door"],
  ["/admin/doors/:id/card", "Door card"],
  // Monitoring (D3 §3.1). The section index is the control board, so it is named for what an
  // admin opens it to look at rather than for the section.
  ["/admin/monitoring", "Control board"],
  ["/admin/monitoring/doors", "Doors"],
  ["/admin/monitoring/doors/log", "Door log"],
  ["/admin/monitoring/doors/:id", "Door"],
  ["/admin/monitoring/doors/:id/card", "Door card"],
  ["/admin/monitoring/devices", "Boards"],
  ["/admin/monitoring/faults", "Faults"],
  ["/admin/monitoring/night", "A person's night"],
  ["/admin/monitoring/changes", "Change record"],
  ["/admin/settings", "Admin settings"],
  ["/admin/ledger", "Transactions"],
  // eco / items 14, 3 and 19. Named for what an admin came to look at, never for the
  // mechanism — these strings are a browser tab, a bookmark, a history entry and the first
  // thing a screen reader says on arrival, and this audience does not read "recurrence".
  ["/admin/schedules", "Repeating bookings"],
  ["/admin/schedules/:id", "Repeating booking"],
  ["/admin/groups", "Member groups"],
  /**
   * Development only — the route is registered behind `import.meta.env.DEV` and is not in the
   * production bundle. It is named here because the suite guard reconciles this table against
   * every `path=` in `App.tsx`, and a route with no name fails it.
   */
  ["/dev/primitives", "Primitives"],
];

/** What the catch-all route renders, so it is what an unmatched path is called. */
export const NOT_FOUND_PAGE_NAME = "Page not found";

/** One pattern against one path — `:param` matches any single non-empty segment. */
function matches(pattern: string, pathname: string): boolean {
  const wanted = segmentsOf(pattern);
  const given = segmentsOf(pathname);
  if (wanted.length !== given.length) return false;
  return wanted.every((segment, i) => (segment.startsWith(":") ? given[i].length > 0 : segment === given[i]));
}

function segmentsOf(path: string): string[] {
  return path.split("/").filter((segment) => segment !== "");
}

/**
 * What this path's page is called, or {@link NOT_FOUND_PAGE_NAME}.
 *
 * <p>
 * The longest matching pattern wins rather than the first, so the order of the table above is
 * documentation rather than load-bearing: <code>/admin/doors/log</code> beats
 * <code>/admin/doors/:id</code> because it is more specific, which is the rule the router
 * itself applies and the one a reader would expect.
 * </p>
 */
export function routePageName(pathname: string): string {
  const literalSegments = (pattern: string) =>
    segmentsOf(pattern).filter((segment) => !segment.startsWith(":")).length;
  const found = ROUTE_PAGE_NAMES
    .filter(([pattern]) => matches(pattern, pathname))
    .sort((a, b) => literalSegments(b[0]) - literalSegments(a[0]))[0];
  return found ? found[1] : NOT_FOUND_PAGE_NAME;
}

/** The whole tab title: the page, then the product. */
export function routeTitle(pathname: string): string {
  return `${routePageName(pathname)} — ${APP_NAME}`;
}

/** Every pattern the table names, for the test that reconciles it against `App.tsx`. */
export function knownRoutePatterns(): string[] {
  return ROUTE_PAGE_NAMES.map(([pattern]) => pattern);
}

/**
 * Put focus on the heading a fragment names, clear of the sticky header. (C15 / D9 / C14)
 *
 * <p>
 * Two callers, one behaviour: the router, when a route arrives carrying a hash, and the
 * settings page's own "Jump to section" nav. Reviewer C found the first one scrolling without
 * moving focus — so a screen reader carried on reading wherever it was, and the jump had done
 * nothing for the person it was for — and reviewer D measured the second half, a heading that
 * landed at y = −29 and y = −335 underneath the header that had just scrolled over it.
 * </p>
 *
 * <p>
 * Returns whether it found anything, so a caller can retry while a page is still fetching.
 * </p>
 */
export function focusFragmentTarget(hash: string): boolean {
  const heading = headingFor(hash);
  if (!heading) return false;
  focusHeading(heading, true);
  return true;
}

/** The heading a fragment names: the target itself if it is one, else the first inside it. */
export function headingFor(hash: string): HTMLElement | null {
  const id = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!id) return null;
  const target = document.getElementById(id);
  if (!target) return null;
  if (HEADING_TAGS.has(target.tagName)) return target;
  return target.querySelector<HTMLElement>("h1, h2, h3, h4, h5, h6") ?? target;
}

const HEADING_TAGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);

/**
 * Focus a thing that was never meant to be focusable, without lighting it up for a mouse.
 *
 * <p>
 * <code>tabindex="-1"</code> makes it programmatically focusable and keeps it out of the tab
 * order. <code>data-route-heading</code> is what `index.css` keys the rest on: no outline on a
 * plain <code>:focus</code> — which is what a mouse user's click would otherwise produce, a
 * ring flashing on a heading nobody asked about — and the product's own ring on
 * <code>:focus-visible</code>, which is what a keyboard user gets. The same attribute carries
 * the <code>scroll-margin-top</code> that keeps the heading out from under the sticky header.
 * </p>
 */
export function focusHeading(target: HTMLElement, scroll: boolean): void {
  target.setAttribute("tabindex", "-1");
  target.setAttribute("data-route-heading", "");
  if (scroll) target.scrollIntoView?.({ block: "start" });
  target.focus({ preventScroll: true });
}
