import { currentClubShortName } from "./clubIdentity";

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

/**
 * The name the STATIC shell is built with — `index.html`'s title and meta and the PWA manifest,
 * which are served before any script runs and so cannot ask which club an address serves. It is
 * the first club's, and `seo-posture.test` holds the two files to it. **The running app never uses
 * it:** the tab suffix, the crest, the sign-in band and the pass carry the tenant's own name
 * (`lib/clubIdentity`, go-live FM-8). Serving the static shell per host is the infra lane's.
 */
export const APP_NAME = "Crusaders Squash";

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
  // R15 — the member's three destinations, in the order the tab bar shows them.
  ["/my-code", "My Code"],
  ["/bookings", "Bookings"],
  // P11 — players and splits. Named per route: the court and the time are on the page's <h1>.
  ["/bookings/invites", "Invites"],
  ["/bookings/:bookingId", "Booking"],
  ["/j/:token", "Invite"],
  ["/invites/:participantId", "Invite"],
  ["/inbox", "Notifications"],
  ["/wallet", "Wallet"],
  ["/wallet/buy", "Buy minutes"],
  ["/wallet/buy/:purchaseId", "Buying minutes"],
  ["/wallet/activity", "Wallet activity"],
  ["/profile", "Profile"],
  // P12 — the member's own match history.
  ["/profile/results", "My results"],
  ["/change-password", "Change password"],
  // item 16 — the always-reachable guide.
  ["/how-it-works", "How it works"],
  // P8 — the member welcome wizard.
  ["/get-started", "Get started"],
  // R16 — the Admin tab and everything under it. The index is the Overview ("Needs attention").
  ["/admin", "Overview"],
  ["/admin/members", "Members"],
  // P5 — one member's page. Named per route, not per person: the name is on the page's <h1>.
  ["/admin/members/:userId", "Member"],
  ["/admin/members/:userId/wallet", "Member wallet & ledger"],
  ["/admin/members/:userId/bookings", "Member bookings"],
  ["/admin/members/:userId/doors", "Member door history"],
  ["/admin/members/:userId/night", "Member's night"],
  ["/admin/members/:userId/access", "Member sign-in & biometrics"],
  ["/admin/groups", "Groups"],
  ["/admin/packages", "Packages"],
  // P12 — disputed results and removing a wrong one.
  ["/admin/results", "Match results"],
  ["/admin/transactions", "Transactions"],
  // BM-11 — the bookings the club has to decide on.
  ["/admin/bookings", "Bookings"],
  ["/admin/reports", "Reports"],
  // Monitoring (R17: courts, hardware and control). The section index is the control board, so
  // it is named for what an admin opens it to look at rather than for the section.
  ["/admin/monitoring", "Control board"],
  ["/admin/monitoring/doors", "Doors"],
  ["/admin/monitoring/doors/log", "Door log"],
  ["/admin/monitoring/doors/:id", "Door"],
  ["/admin/monitoring/doors/:id/card", "Door card"],
  ["/admin/monitoring/devices", "Boards"],
  ["/admin/monitoring/faults", "Faults"],
  // R17: a picker now — it asks who, then opens that member's Night tab.
  ["/admin/monitoring/night", "A person's night"],
  ["/admin/monitoring/changes", "Change record"],
  // Named for what an admin came to look at, never for the mechanism — this audience does not
  // read "recurrence".
  ["/admin/schedules", "Repeating bookings"],
  ["/admin/schedules/:id", "Repeating booking"],
  ["/admin/courts", "Courts"],
  ["/admin/settings", "Settings"],
  ["/admin/webhooks", "Webhooks"],
  /**
   * The old paths. Still named, because they are still ROUTES — permanent redirects rather than
   * deletions — and the title is set before the redirect resolves: a redirect renders for a
   * tick, and the reconciliation reads every `path=` in the router without caring what it
   * renders. Each is named for where it now leads.
   */
  ["/schedule", "Bookings"],
  ["/wallet/topup", "Buy minutes"],
  ["/wallet/topup/:topupId", "Buying minutes"],
  ["/schedule/:bookingId", "Booking"],
  ["/booking/:bookingId", "Booking"],
  ["/invites", "Invites"],
  ["/court-code", "My Code"],
  ["/reports", "Reports"],
  ["/admin/ledger", "Transactions"],
  ["/admin/biometric", "Members"],
  ["/admin/devices", "Boards"],
  ["/admin/doors", "Doors"],
  ["/admin/doors/log", "Door log"],
  ["/admin/doors/:id", "Door"],
  ["/admin/doors/:id/card", "Door card"],
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
  const found = bestMatch(pathname);
  return found ? found[1] : NOT_FOUND_PAGE_NAME;
}

function bestMatch(pathname: string): readonly [string, string] | undefined {
  const literalSegments = (pattern: string) =>
    segmentsOf(pattern).filter((segment) => !segment.startsWith(":")).length;
  return ROUTE_PAGE_NAMES
    .filter(([pattern]) => matches(pattern, pathname))
    .sort((a, b) => literalSegments(b[0]) - literalSegments(a[0]))[0];
}

/** The whole tab title: the page, then the club members know (FM-8) — the page alone while it is unknown. */
export function routeTitle(pathname: string, club: string | null = currentClubShortName()): string {
  return withClub(routePageName(pathname), club);
}

/** "Bookings — Harbour Racquets", or "Bookings" when no club name is known. */
export function withClub(page: string, club: string | null = currentClubShortName()): string {
  return club ? `${page} — ${club}` : page;
}

/**
 * F4.6 — a route that shows ONE record (`/admin/members/:userId`, `/bookings/:bookingId`): its
 * table name ("Member") says what kind of page it is and not whose, so the tab and the
 * announcement take the record's name from the page's own `<h1>` once it has rendered.
 */
export function isEntityRoute(pathname: string): boolean {
  return bestMatch(pathname)?.[0].includes("/:") ?? false;
}

/**
 * Whether a heading is still the page's loading placeholder rather than the record's name — the
 * member page says "Member" while it reads, which is the start of its own table name.
 */
export function isPlaceholderHeading(text: string, pathname: string): boolean {
  const trimmed = text.trim().toLowerCase();
  return trimmed === "" || routePageName(pathname).toLowerCase().startsWith(trimmed);
}

/** "Thandi Probe — Member wallet & ledger" — the record first, then what the page is. */
export function entityPageName(heading: string, pathname: string): string {
  return `${heading.trim()} — ${routePageName(pathname)}`;
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
  const control = headerControlOf(heading);
  if (control) {
    // Scrolled by the HEADING, which carries the scroll margin that clears the sticky header.
    heading.setAttribute("data-route-heading", "");
    heading.scrollIntoView?.({ block: "start" });
    control.focus({ preventScroll: true });
    return true;
  }
  focusHeading(heading, true);
  return true;
}

/**
 * The control a heading IS, when it is one: an accordion or disclosure header is an `<h2>` whose
 * content is a single button (the WAI-ARIA accordion pattern — the Settings sections, R13).
 *
 * <p>
 * Focus goes to that button, not to the heading around it. A heading made focusable here would be
 * a second, inert tab stop wrapped round the real one: Enter on it does nothing, and it raced the
 * page's own "open this section and focus its header" — whichever ran last won, and the loser was
 * the keyboard user, left on a heading that could not open the section they were sent to.
 * </p>
 */
function headerControlOf(heading: HTMLElement): HTMLElement | null {
  const controls = heading.querySelectorAll<HTMLElement>("button, a[href]");
  return controls.length === 1 ? controls[0] : null;
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

/**
 * F4-6 — a page reloaded by the member's own Retry (a boundary's "Retry" / "Reload the page", or
 * signal coming back) is a navigation they asked for, not a cold open. A plain first paint stays
 * silent and leaves focus where the browser puts it; after a Retry that left the member on
 * `<body>` with nothing said, on a page that had just replaced an error screen they were reading.
 * The boundary marks the path before it reloads; the announcer, finding the mark for the path it
 * opens on, names the page and moves focus to its heading, then clears it.
 */
const RETRY_LANDING_KEY = "crusaders.mainframe.retry-landing";
const RETRY_LANDING_TTL_MS = 60_000;

export function markRetryLanding(pathname: string): void {
  try { window.sessionStorage.setItem(RETRY_LANDING_KEY, JSON.stringify({ pathname, at: Date.now() })); } catch { /* nothing to carry */ }
}

/** Whether this first paint is the landing of a Retry for this path. Does not consume the mark. */
export function isRetryLanding(pathname: string): boolean {
  try {
    const mark = JSON.parse(window.sessionStorage.getItem(RETRY_LANDING_KEY) ?? "null") as { pathname?: string; at?: number } | null;
    return !!mark && mark.pathname === pathname && typeof mark.at === "number" && Date.now() - mark.at < RETRY_LANDING_TTL_MS;
  } catch { return false; }
}

export function clearRetryLanding(): void {
  try { window.sessionStorage.removeItem(RETRY_LANDING_KEY); } catch { /* nothing to clear */ }
}

/** A boundary's Retry: reload, marked so the page that opens is announced and focused (F4-6). */
export function retryByReload(reload: () => void = () => window.location.reload()): void {
  markRetryLanding(window.location.pathname);
  reload();
}
