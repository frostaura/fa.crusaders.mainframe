import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import {
  APP_NAME, entityPageName, focusFragmentTarget, focusHeading, isEntityRoute, isPlaceholderHeading, routePageName, routeTitle,
} from "../lib/routeAnnouncer";
import { resetStandingAnnouncements } from "../lib/announce";

/**
 * What happens when this app changes page. (C6, and the shell half of C15 / D9)
 *
 * <p>
 * <b>Nothing did.</b> Reviewer C measured a navigation on seven routes: the document title
 * stayed "Crusaders Mainframe", focus went to <code>&lt;body&gt;</code>, and nothing was
 * announced. To a screen-reader user a single-page app that does that has not navigated at
 * all — the reader is still where it was, reading nothing, on a document whose content has
 * silently been replaced underneath it. The three things a real page load does for free are
 * the three things this component does by hand.
 * </p>
 *
 * <p>
 * <b>Why it lives above the router's `Routes` rather than in `Layout`.</b> `Layout` returns
 * early on two branches — the signed-out public landing and the auth-flow screens — and
 * those are routes too. A member who follows a password-reset link is on a route; so is
 * everybody who has not signed in yet.
 * </p>
 */
export function RouteAnnouncer() {
  const location = useLocation();
  const [announcement, setAnnouncement] = useState("");
  /**
   * <b>The first ROUTE, not a "have I run yet" flag — and the difference is StrictMode.</b>
   *
   * <p>
   * This was <code>useRef(true)</code> cleared inside the effect, which is the same bug
   * `ConfirmButton`'s <code>mounted</code> ref carries a paragraph about. React's development
   * double-invoke runs mount → cleanup → mount, so the flag was already false on the second
   * run and the announcer treated a cold page load as a navigation: it announced the page and
   * yanked focus to the <code>&lt;h1&gt;</code> before anybody had pressed anything. jsdom
   * misses it because the unit tests render without StrictMode; `e2e/app-chrome.spec.ts`
   * found it by pressing Tab and landing past the skip link.
   * </p>
   *
   * <p>
   * A location KEY is idempotent under a double-invoke: comparing against the key this
   * component first rendered with gives the same answer however many times the effect runs.
   * </p>
   */
  const firstKey = useRef(location.key);
  /**
   * What counts as HAVING NAVIGATED — and the query string does not.
   *
   * <p>
   * <b>The finding.</b> This effect ran on `location.search`, so every filter change on the
   * door log was treated as a navigation: the page name was announced again — "Door log",
   * over whatever the person was reading — and focus was pulled to the `&lt;h1&gt;`. An admin
   * narrowing a filter three times heard the page name three times and had the keyboard taken
   * off the control they were using, three times. The log's own `role="status"` already
   * carries the result count, which is the thing that actually changed.
   * </p>
   *
   * <p>
   * A HASH change is still a navigation for focus purposes and not for announcement purposes:
   * a fragment names a place on the page the person asked to be taken to (D9), and the heading
   * it lands on announces itself.
   * </p>
   */
  const lastPathname = useRef(location.pathname);
  const lastHash = useRef(location.hash);

  useEffect(() => {
    // Always, even on a query-string change: the title is derived from the path, so this is a
    // no-op there, and a route that arrives by any means has its name in the tab.
    const name = routePageName(location.pathname);
    document.title = routeTitle(location.pathname);

    const initial = location.key === firstKey.current;
    const pathChanged = location.pathname !== lastPathname.current;
    const hashChanged = location.hash !== lastHash.current;
    lastPathname.current = location.pathname;
    lastHash.current = location.hash;

    // A filter, a date field or a search box writing to the query string. Silent here.
    if (!initial && !pathChanged && !hashChanged) return;

    // R3-26 — arriving somewhere is an occasion to be told what is standing there.
    //
    // `lib/announce` remembers what has already been said so that a banner behind a 15-second
    // poll says it once rather than twelve times. That memory has to end at the PAGE boundary,
    // or a screen-reader user who navigates away and back is told nothing about the screen
    // they are now on — and it must NOT end at a filter change, or narrowing a door log
    // re-speaks every standing advisory on it.
    if (pathChanged || initial) resetStandingAnnouncements();

    // A first paint is a real page load: the browser has already announced the document and
    // put focus at the top of it, and moving focus there again is a second announcement of
    // something that just happened. A HASH on a first paint is different — a pasted or
    // emailed deep link has a target, and landing at the top of the page is the D9 failure.
    if (initial && !location.hash) return;

    // The NAME, only where the name has changed. A fragment jump inside one page would
    // otherwise announce the page the person is already on.
    if (pathChanged) setAnnouncement(name);
    return takeFocus(location.hash, nameTheRecord(location.pathname, pathChanged ? setAnnouncement : null));
  }, [location.pathname, location.search, location.hash, location.key]);

  /**
   * One polite region, outside every page, so a route announcement cannot be deleted by the
   * page it is about.
   *
   * <p>
   * <b>`aria-live` WITHOUT `role="status"`,</b> for the reason `ConfirmButton` documents at
   * length: the role is the same live region plus a LANDMARK, and this one is mounted on
   * every route in the product. Adding it put a second status landmark on every screen that
   * already has one — and the suite said so immediately, with four pages' `getByRole("status")`
   * suddenly matching two nodes. A route announcement is not a page's status; it is the
   * navigation talking.
   * </p>
   */
  return (
    <div aria-live="polite" aria-atomic="true" className="sr-only" data-testid="route-announcer">
      {announcement}
    </div>
  );
}

/**
 * Put focus where the new page begins, once the page has rendered something to put it on.
 *
 * <p>
 * <b>The retry is not defensive padding.</b> Every screen in this product fetches before it
 * renders its heading, so at the moment the route changes there is frequently no
 * <code>&lt;h1&gt;</code> in the document at all — a one-shot query would land on
 * <code>&lt;body&gt;</code> on precisely the screens that take longest to arrive, which is
 * the failure it is meant to fix. It gives up after five seconds rather than polling for ever.
 * </p>
 *
 * <p>
 * <b>What it will not do.</b> It never takes focus off something a person is typing into.
 * A route change can come from a search box or a date field writing to the query string, and
 * a heading that grabs focus mid-sentence is a worse bug than the one being fixed.
 * </p>
 *
 * <p>
 * <b>C-M6 — but "not now" is not "never", and that is what put the browser's Back button on
 * `&lt;body&gt;`.</b> Reviewer C filtered the door log — which is done in a `&lt;select&gt;`,
 * so focus was inside a control this guard protects — and then pressed Back. The guard fired,
 * the attempt returned, and because it returned without scheduling another one it gave up for
 * good. React then re-rendered the filter row underneath the departing page, the focused
 * `&lt;select&gt;` was replaced by a new node, and focus fell to the body with nothing left
 * that was ever going to put it anywhere. Retrying means the protection lasts exactly as long
 * as the person is still in the control: still typing a second later, and this stops trying;
 * gone from the document, and the heading gets it.
 * </p>
 */
function takeFocus(hash: string, onHeading: (heading: HTMLElement) => void): () => void {
  let attempts = 0;
  const timer: { id?: number } = {};

  const attempt = () => {
    attempts += 1;
    if (!inUse(document.activeElement)) {
      if (hash && focusFragmentTarget(hash)) return;
      const heading = hash ? null : focusPageHeading();
      if (heading) {
        onHeading(heading);
        watchHeading(heading, onHeading, timer);
        return;
      }
    }
    // F4.6 — five seconds, not one: a lazy route's chunk and its first read routinely take longer
    // than a second on a phone, and giving up left focus wherever the old page dropped it.
    if (attempts < 50) timer.id = window.setTimeout(attempt, 100);
  };

  attempt();
  return () => { if (timer.id !== undefined) window.clearTimeout(timer.id); };
}

/**
 * F4.6 — the heading focus landed on can be REPLACED a moment later, and focus goes with it.
 *
 * <p>
 * A page that says "Member" while it reads and then renders the member's own header swaps its
 * `<h1>` for a new node; the old one leaves the document with focus on it, and focus falls to
 * `<body>` — measured on the member page. For five seconds after landing, a heading that has
 * gone is followed to its replacement: focus moves to it when focus fell to the body (never off
 * anything else the person has moved to since), and the page is named again from it.
 * </p>
 */
function watchHeading(landed: HTMLElement, onHeading: (heading: HTMLElement) => void, timer: { id?: number }) {
  let checks = 0;
  let text = landed.textContent ?? "";
  const check = () => {
    checks += 1;
    // F4-10 — the SAME node can change its words: the booking page's header says "Booking" while
    // it reads and then "Court 1 · Thu 1 Oct, 10:15" in place, so no replacement ever happened and
    // the page stayed named "Booking". A changed text is the record arriving; name it from it.
    const now = landed.textContent ?? "";
    if (landed.isConnected && now !== text) {
      text = now;
      onHeading(landed);
    }
    if (!landed.isConnected) {
      const next = document.querySelector<HTMLElement>("#main-content h1");
      if (next) {
        const active = document.activeElement;
        if (!active || active === document.body) focusHeading(next, false);
        onHeading(next);
        watchHeading(next, onHeading, timer);
        return;
      }
    }
    if (checks < 50) timer.id = window.setTimeout(check, 100);
  };
  timer.id = window.setTimeout(check, 100);
}

/**
 * F4.6 — on a page about one record, the tab and the announcement name the record from its
 * `<h1>` ("Thandi Probe — Member"), not only the kind of page ("Member"). A heading that is still
 * the page's loading placeholder names nothing; `announce` is null when only the hash moved.
 */
function nameTheRecord(pathname: string, announce: ((text: string) => void) | null) {
  return (heading: HTMLElement) => {
    if (!isEntityRoute(pathname)) return;
    const text = heading.textContent ?? "";
    if (isPlaceholderHeading(text, pathname)) return;
    const name = entityPageName(text, pathname);
    document.title = `${name} — ${APP_NAME}`;
    announce?.(name);
  };
}

/** The page's own `<h1>`, if it has rendered one yet. No scroll: the page is already at its top. */
function focusPageHeading(): HTMLElement | null {
  const heading = document.querySelector<HTMLElement>("#main-content h1");
  if (!heading) return null;
  focusHeading(heading, false);
  return heading;
}

/**
 * Whether focus is somewhere a person is part-way through something.
 *
 * <p>
 * <b>Typing was only half of it, and the other half destroys work rather than interrupting
 * it.</b> A two-step confirm disarms when focus leaves the group — that is what makes Escape,
 * a click elsewhere and a Tab away all mean "no" without needing a clock. So a retry that
 * pulls focus to the heading while a confirm is ARMED does not merely interrupt: it silently
 * cancels the thing the admin had just decided to do, and the only trace is a polite
 * "Cancelled — nothing was changed." that arrives while they are looking at the button.
 * </p>
 *
 * <p>
 * It is reachable in the product rather than only under test, and it took the Monitoring move
 * to expose it. The old admin paths are permanent redirects now, so an admin following
 * `/admin/doors` out of an outage email lands, is redirected, and the redirect is a second
 * pathname change whose focus attempt retries for a further second — straight over the fleet
 * control they have already armed. Measured on the doors overview: armed, then disarmed
 * 40 ms later by `handleBlur`, with `relatedTarget` the page's own `<h1>`.
 * </p>
 *
 * <p>
 * `[data-confirm]` is `ConfirmButton`'s own armed marking, so this asks the control whether
 * it is armed rather than keeping a second register of which controls are two-step. An idle
 * confirm carries no such attribute and is not protected — there is nothing to lose.
 * </p>
 */
function inUse(active: Element | null): boolean {
  if (!active || !(active instanceof HTMLElement)) return false;
  if (active.isContentEditable) return true;
  const tag = active.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return active.closest("[data-confirm]") !== null;
}
