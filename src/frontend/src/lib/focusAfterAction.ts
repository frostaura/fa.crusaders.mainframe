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

  /** Try again later, while the schedule has a step left. One caller per outcome, below. */
  const again = () => {
    if (attempts < BACKOFF_MS.length) window.setTimeout(attempt, BACKOFF_MS[attempts]);
  };

  const attempt = () => {
    // THE SAME GUARD AS THE ONE ON THE WAY IN, AND IT BELONGS AT BOTH ENDS.
    //
    // `focusAfterAction` refuses to start without a document, which was right and was not
    // enough: what it schedules is a backoff chain of up to six timers, and nothing can
    // cancel them. The document can therefore go away BETWEEN the schedule and the attempt,
    // and the check that ran on the way in has long since passed.
    //
    // Found on CI, not here. Under vitest the jsdom environment is torn down at the end of a
    // file while a chain is still in flight; the timer then fires in bare Node and dies on
    // `document.activeElement` with "document is not defined". It is an UNHANDLED error, so
    // it fails the run while every one of the 2755 tests reports passing — and it is a race,
    // so it surfaced on the Linux runner and never once here.
    //
    // The same shape is a real, if small, misbehaviour in the product: the chain outlives the
    // page that started it, so focus can be taken on a screen the member has already left.
    // Bailing when the document is gone is the floor. Making the chain cancellable so a
    // caller can stop it on unmount is the proper cure, and it changes a signature every call
    // site uses, so it is recorded rather than smuggled in beside a CI fix.
    if (typeof document === "undefined") return;
    if (run !== currentRun) return;
    attempts += 1;

    // Somebody has it, on purpose. Leave it alone — including the control's own restored
    // trigger, which is the ordinary case when the acting control survives its own action,
    // and a page that moved focus to its own receipt before this even ran.
    //
    /**
     * <b>Held is a reason to wait, not a reason to stop.</b>
     *
     * <p>
     * This used to `return` outright, which quietly made the whole backoff dead code for the
     * case it was written for. `ConfirmButton` restores focus to its own trigger the instant
     * the action settles; the page then re-reads itself, and it is the payload arriving a few
     * hundred milliseconds later that unmounts the trigger and renders its successor. So at
     * the first look focus is legitimately held — by a control that is about to cease to
     * exist — and standing down there meant every call site whose successor arrives with a
     * later payload landed on `&lt;body&gt;` exactly as it had before `focusAfter` existed.
     * `DoorShutControl` carried a hand-rolled effect for precisely this, which is the
     * evidence that the shared helper was not covering it.
     * </p>
     *
     * <p>
     * Nothing about the rule it enforces changes: it still only ever fills a vacuum, and it
     * still gives up after the documented six steps, so a screen where focus never goes
     * adrift does not leave a loop waiting to pounce on whatever the admin does next. What
     * changes is that "is there a vacuum" is a question it re-asks, rather than one it
     * answers once at the only instant it is guaranteed to be wrong.
     * </p>
     */
    if (!adrift(document.activeElement)) { again(); return; }

    const target = find();
    if (target && target.isConnected) {
      if (target.tabIndex < 0 && !target.hasAttribute("tabindex")) {
        focusHeading(target, false);
      } else {
        target.focus({ preventScroll: true });
      }
      return;
    }
    again();
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
