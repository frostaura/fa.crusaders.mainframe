import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { focusAfterAction, pageHeading } from "./focusAfterAction";

/**
 * Where the keyboard goes after something has actually happened — the helper itself.
 *
 * <p>
 * <b>Why this file exists at all.</b> `focusAfterAction` shipped in R3 with no direct test:
 * it was held only through the doors pages that call it, and those pages are slow, stubbed
 * and asynchronous, so the one behaviour that decides whether the whole mechanism works —
 * <i>when</i> it looks, not <i>where</i> — was never stated anywhere. The admin lane adopting
 * `ConfirmButton.focusAfter` at six more call sites is what made the gap expensive.
 * </p>
 *
 * <p>
 * Timers are faked throughout, because the thing under test is a backoff schedule. Real
 * timers would make every case below a sleep, and the one case that matters is measured in
 * the gap between two of the schedule's own steps.
 * </p>
 */
describe("focusAfterAction — filling a vacuum, and waiting for one", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  /** A focusable element in the document, so a test can put focus somewhere real. */
  const button = (id: string): HTMLButtonElement => {
    const el = document.createElement("button");
    el.id = id;
    el.textContent = id;
    document.body.append(el);
    return el;
  };

  it("lands on the named target when focus is already adrift", () => {
    const target = button("successor");
    focusAfterAction(() => target);

    vi.advanceTimersByTime(1);
    expect(document.activeElement).toBe(target);
  });

  it("treats the page's <main> as a vacuum: a closing dialog's rescue never beats a named target", () => {
    // ui/dialog parks focus on <main> when the opener has gone; on a slow runner that landed
    // first, read as "held", and the result card's heading never got it (ResultCard F2-12).
    const main = document.createElement("main");
    main.id = "main-content";
    main.tabIndex = -1;
    document.body.append(main);
    main.focus();
    const target = button("successor");
    focusAfterAction(() => target);

    vi.advanceTimersByTime(1);
    expect(document.activeElement).toBe(target);
  });

  it("leaves focus alone when somebody else is holding it on purpose", () => {
    const held = button("the-field-they-tabbed-to");
    const target = button("successor");
    held.focus();

    focusAfterAction(() => target);
    vi.advanceTimersByTime(2000);

    expect(document.activeElement, "it took the keyboard off somebody using it").toBe(held);
  });

  /**
   * <b>The case the whole mechanism exists for, and the one it did not cover.</b>
   *
   * <p>
   * The control that did the thing is usually the thing that disappears — and it does not
   * disappear in the tick the action settles. `ConfirmButton` restores focus to its own
   * trigger the moment the promise resolves; the page then re-reads itself, and the payload
   * that comes back a few hundred milliseconds later is what unmounts the trigger and renders
   * its successor. So at the instant this helper first looks, focus is legitimately held — by
   * a control that is about to cease to exist.
   * </p>
   *
   * <p>
   * The implementation returned outright on that first look, scheduling nothing further, so
   * the backoff it documents at six steps over about a second only ever ran when focus was
   * already on the body. Every call site whose successor arrives with a later payload — which
   * is every shut, every reopen, every take-out-of-service, every fault resolve — landed on
   * `&lt;body&gt;` exactly as it did before the prop existed. `DoorShutControl` had a
   * hand-rolled effect doing this job and it is why that effect could not simply be deleted.
   * </p>
   *
   * <p>
   * Standing down must stay a decision it re-takes on every attempt, not one it takes once:
   * "focus is held right now" and "focus will still be held in 300 ms" are different claims,
   * and only the first is observable at t=0.
   * </p>
   */
  it("keeps looking while the control that acted still holds focus, and lands when it goes", () => {
    const doomed = button("the-control-that-acted");
    const target = button("successor");
    doomed.focus();

    focusAfterAction(() => target);

    // Two of the schedule's steps pass with the old control still in the document, exactly as
    // they do while the page is re-reading itself.
    vi.advanceTimersByTime(40);
    expect(document.activeElement).toBe(doomed);

    // The payload lands and the control an admin pressed is unmounted.
    doomed.remove();
    document.body.focus();

    vi.advanceTimersByTime(1000);
    expect(document.activeElement, "focus was left on the body, which is the defect").toBe(target);
  });

  it("gives up rather than stealing focus a whole second after the fact", () => {
    const doomed = button("the-control-that-acted");
    const target = button("successor");
    doomed.focus();

    focusAfterAction(() => target);
    // Longer than the documented backoff: the search is bounded, so a page where nothing ever
    // goes adrift does not have a loop waiting to pounce on the next thing the admin does.
    vi.advanceTimersByTime(5000);
    doomed.remove();
    document.body.focus();
    vi.advanceTimersByTime(5000);

    expect(document.activeElement).toBe(document.body);
  });

  it("stands the earlier search down when a second action starts one", () => {
    const first = button("first-target");
    const second = button("second-target");

    focusAfterAction(() => first);
    focusAfterAction(() => second);
    vi.advanceTimersByTime(1000);

    expect(document.activeElement).toBe(second);
  });

  /**
   * The floor under a call site that has not named anything. A heading is not naturally
   * focusable, so it is given the route-heading treatment rather than being skipped.
   */
  it("falls back to the page heading, and makes it focusable without joining the tab order", () => {
    document.body.innerHTML = '<main id="main-content"><h1>Doors</h1></main>';
    const heading = pageHeading()!;

    focusAfterAction(pageHeading);
    vi.advanceTimersByTime(1);

    expect(document.activeElement).toBe(heading);
    expect(heading).toHaveAttribute("tabindex", "-1");
  });
});
