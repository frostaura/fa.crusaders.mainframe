import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { focusFragmentTarget, focusHeading, routePageName, routeTitle } from "../lib/routeAnnouncer";
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

  useEffect(() => {
    const name = routePageName(location.pathname);
    document.title = routeTitle(location.pathname);

    // R3-26 — arriving somewhere is an occasion to be told what is standing there.
    //
    // `lib/announce` remembers what has already been said so that a banner behind a 15-second
    // poll says it once rather than twelve times. That memory has to end at the page boundary,
    // or a screen-reader user who navigates away and back is told nothing about the screen
    // they are now on. Cleared on every route change, including the first paint's hash case.
    resetStandingAnnouncements();

    // A first paint is a real page load: the browser has already announced the document and
    // put focus at the top of it, and moving focus there again is a second announcement of
    // something that just happened. A HASH on a first paint is different — a pasted or
    // emailed deep link has a target, and landing at the top of the page is the D9 failure.
    const initial = location.key === firstKey.current;
    if (initial && !location.hash) return;

    if (!initial) setAnnouncement(name);
    return takeFocus(location.hash);
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
 * the failure it is meant to fix. It gives up after a second rather than polling for ever.
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
function takeFocus(hash: string): () => void {
  let attempts = 0;
  let timer: number | undefined;

  const attempt = () => {
    attempts += 1;
    const landed = isTyping(document.activeElement)
      ? false
      : (hash ? focusFragmentTarget(hash) : focusPageHeading());
    if (landed) return;
    if (attempts < 10) timer = window.setTimeout(attempt, 100);
  };

  attempt();
  return () => { if (timer !== undefined) window.clearTimeout(timer); };
}

/** The page's own `<h1>`, if it has rendered one yet. No scroll: the page is already at its top. */
function focusPageHeading(): boolean {
  const heading = document.querySelector<HTMLElement>("#main-content h1");
  if (!heading) return false;
  focusHeading(heading, false);
  return true;
}

/** Whether focus is somewhere a person could be part-way through a sentence. */
function isTyping(active: Element | null): boolean {
  if (!active || !(active instanceof HTMLElement)) return false;
  if (active.isContentEditable) return true;
  const tag = active.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}
