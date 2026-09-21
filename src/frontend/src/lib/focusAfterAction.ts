import { focusHeading } from "./routeAnnouncer";

/**
 * Where the keyboard goes after something has actually happened. (R3-10 / C-C2, C-M5, C-M6)
 *
 * <p>
 * <b>The finding.</b> Reviewer C confirmed a shut and a reopen from the keyboard and measured
 * where focus landed afterwards: <code>&lt;body&gt;</code>. Escape out of the member's
 * full-screen code did the same, and so did the browser's Back button. Focus on the body is
 * not a neutral resting place — the next Tab starts again at the top of the document, several
 * tab stops and a whole header away from the thing the person just did, and a screen reader is
 * left reading nothing while the page underneath it has changed.
 * </p>
 *
 * <p>
 * <b>Why a module and not a `useEffect`.</b> The control that did the thing is usually the
 * thing that disappears: a "Shut this door" button is replaced by a "Reopen this door" button,
 * a dialog closes, a page re-renders from a new payload. An effect inside the unmounted
 * component never runs, so the focus move has to outlive it. A module-level timer does.
 * </p>
 *
 * <p>
 * <b>What it will not do.</b> It only ever fills a VACUUM. If anything at all still holds
 * focus — the control's own restored trigger, a receipt heading the page moved to itself, a
 * field the person tabbed to while the request was in flight — it does nothing and says
 * nothing. "Focus is on the body, or on a node that has been removed from the document" is
 * the whole of its trigger condition, and that condition is precisely the defect.
 * </p>
 */

/**
 * How long to keep looking for a target that a re-render has not produced yet.
 *
 * <p>
 * Backing off rather than polling a fixed interval, for two reasons. The common case is the
 * very first attempt — React has re-rendered by the next task — and the uncommon one is a
 * control that only appears after the page has re-read the door from the server, which is
 * hundreds of milliseconds away. A fixed 80 ms poll spends thirteen wakeups covering the same
 * second, and every one of them runs inside whatever the page is doing; the unit suite
 * measured it, at about 3 s added to one settings file.
 * </p>
 */
const BACKOFF_MS = [0, 32, 64, 128, 256, 512];

/**
 * The latest run wins, and every earlier one stands down.
 *
 * <p>
 * The search outlives the component that started it, which is the point of it — and that means
 * a search for a target that never arrives is still looking a second later, when the person may
 * have done something else entirely. Two confirms in a row, or a confirm followed by a
 * navigation, would otherwise have two loops competing for the keyboard and the loser landing
 * last. Found in the unit suite, where a stray loop from one test focused the next test's
 * heading — which is the same defect with a faster clock.
 * </p>
 */
let currentRun = 0;

/** Whether focus is nowhere in particular: the body, nothing, or a node that has been removed. */
function adrift(active: Element | null): boolean {
  if (active === null) return true;
  if (active === document.body) return true;
  return !active.isConnected;
}

/**
 * Put focus on what the caller named, once it exists.
 *
 * <p>
 * `find` is called on every attempt rather than once, because the element the caller wants is
 * usually rendered by the very update that removed the control: "the Reopen button", "the
 * status heading", "the row that replaced this one". A one-shot query would miss it and land
 * on the body — which is the defect.
 * </p>
 *
 * <p>
 * A heading — anything that is not naturally focusable — is given `tabindex="-1"` and the
 * route-heading treatment, so it takes focus without joining the tab order and without a ring
 * flashing on it for a mouse user. That is the same helper the router uses on a route change,
 * deliberately: there is one way to focus a heading in this product.
 * </p>
 */
export function focusAfterAction(find: () => HTMLElement | null | undefined): void {
  if (typeof document === "undefined") return;
  const run = ++currentRun;
  let attempts = 0;

  const attempt = () => {
    if (run !== currentRun) return;
    attempts += 1;
    // Somebody has it, on purpose. Leave it alone — including the control's own restored
    // trigger, which is the ordinary case when the acting control survives its own action,
    // and a page that moved focus to its own receipt before this even ran.
    if (!adrift(document.activeElement)) return;

    const target = find();
    if (target && target.isConnected) {
      if (target.tabIndex < 0 && !target.hasAttribute("tabindex")) {
        focusHeading(target, false);
      } else {
        target.focus({ preventScroll: true });
      }
      return;
    }
    if (attempts < BACKOFF_MS.length) window.setTimeout(attempt, BACKOFF_MS[attempts]);
  };

  // Never synchronously: React has not re-rendered yet, so at this instant the target does not
  // exist and the control that is about to be replaced still holds focus. Both facts flip in
  // the same tick.
  window.setTimeout(attempt, BACKOFF_MS[0]);
}

/**
 * The floor under every confirmed action: the page's own heading.
 *
 * <p>
 * Not a good landing place — the caller's own control or status line is far better, and
 * {@link focusAfterAction} exists so a caller can name one. It is what stops the answer being
 * <code>&lt;body&gt;</code> for a call site that has not said yet, which is every call site the
 * day this lands.
 * </p>
 */
export function pageHeading(): HTMLElement | null {
  return document.querySelector<HTMLElement>("#main-content h1");
}
