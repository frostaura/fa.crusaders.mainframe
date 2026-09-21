import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ConfirmButton } from "./ConfirmButton";

/**
 * The armed state of `ConfirmButton`, which five blind reviewers driving the real product
 * found to be the least honest thing on the doors screens.
 *
 * <p>
 * <b>Why a second file rather than more cases in `components.test.tsx`.</b> That file is
 * one `it` per primitive — does the modal close on Escape, does the table say something
 * when it is empty. The armed state is a small state machine with six exits (a second
 * tap, Escape, a click outside, a blur, a timeout, a Cancel control) and an announcement
 * contract on top of it, and every one of the findings below was invisible to a suite
 * that only ever checked "two presses".
 * </p>
 *
 * <p>
 * <b>What jsdom can and cannot hold here.</b> It has no layout, so the clipping finding
 * (B7/C6 — armed confirm measured `clientHeight 44, scrollHeight 96–106` on a 360 px
 * phone, two lines cut mid-sentence) is held here as the three DOM properties the pixels
 * depend on: the control does not clip its overflow, the label that is showing is in
 * normal flow so it contributes height, and a caller's fixed height cannot survive to
 * pin it. The pixels themselves are re-measured in a real browser by
 * `e2e/admin-doors.spec.ts`, which arms every destructive doors control at 360 px and at
 * 768 px and asserts `scrollHeight <= clientHeight + 1`.
 * </p>
 */

/** The armed consequence on the real fleet control — long enough to wrap at any width. */
const FLEET_CONFIRM = "Shut all 3 doors? Every door that can reach the club's server opens for nobody"
  + " from this click. Any door that has lost the network keeps admitting booked members from the list"
  + " it last downloaded for up to six hours. No booking and no no-show penalty changes.";

describe("ConfirmButton — the armed state", () => {
  /**
   * B6 (HIGH). The armed control set `aria-pressed=true`, so VoiceOver said "pressed" on a
   * control that had done nothing yet: the word a screen-reader user hears for "done" was
   * being used for "about to". A toggle it is not — the second press is a different action,
   * not the off half of the first.
   *
   * <p>
   * What replaces it has to be an announcement rather than a state, because the consequence
   * is the point: a polite live region that receives the confirm sentence when the control
   * arms and is emptied when it disarms.
   * </p>
   */
  it("announces the armed prompt in a polite live region and claims no pressed state", () => {
    render(
      <ConfirmButton
        idleLabel="Shut all doors"
        confirmLabel={FLEET_CONFIRM}
        ariaLabel="Shut every door the club has open — 3 of 3"
        onConfirm={() => {}}
      />,
    );

    const button = screen.getByRole("button", { name: /Shut all doors/ });
    const live = document.querySelector("[aria-live='polite']")!;
    expect(live).toBeTruthy();
    expect(live.textContent).toBe("");

    fireEvent.click(button);
    // Not "pressed". Not "not pressed" either — the attribute must be gone, because
    // aria-pressed=false on a control that is not a toggle is its own lie.
    expect(button).not.toHaveAttribute("aria-pressed");
    expect(live.textContent).toContain("Shut all 3 doors?");
    expect(live.textContent).toContain("up to six hours");

    fireEvent.keyDown(document, { key: "Escape" });
    // Emptied, not left holding a consequence for a control that is back at rest.
    expect(live.textContent).toBe("");
  });

  /**
   * B16 (MED) — WCAG 2.5.3 label in name. `ariaLabel` REPLACED the visible text, so a
   * control reading "Shut all doors" had the accessible name "Shut every door the club has
   * open — 3 of 3": speech control ("click Shut all doors") misses it, and a screen-reader
   * user reading the screen and hearing the control cannot tell they are the same thing.
   *
   * <p>
   * The contract is now a composition rather than a replacement — the visible idle label,
   * verbatim, then the context the call site adds — and it holds in the armed state too,
   * which is where the old name was least recoverable.
   * </p>
   */
  it("keeps the visible idle label verbatim at the front of the accessible name", () => {
    render(
      <ConfirmButton
        idleLabel="Shut all doors"
        confirmLabel={FLEET_CONFIRM}
        ariaLabel="Shut every door the club has open — 3 of 3"
        onConfirm={() => {}}
      />,
    );

    const idle = screen.getByRole("button", { name: "Shut all doors — Shut every door the club has open — 3 of 3" });
    expect(idle.getAttribute("aria-label")!.startsWith("Shut all doors")).toBe(true);

    fireEvent.click(idle);
    const armed = screen.getByRole("button", { name: /tap again to confirm/ });
    expect(armed.getAttribute("aria-label")!.startsWith("Shut all doors")).toBe(true);
    expect(armed).toHaveAttribute(
      "aria-label",
      "Shut all doors — Shut every door the club has open — 3 of 3 — tap again to confirm",
    );
  });

  /**
   * The other branch of the same rule. `idleLabel="Delete"` with `ariaLabel="Delete Front
   * door"` is ALREADY a name that opens with the words on the control, and composing it
   * would give "Delete — Delete Front door" — a stutter that buys no reachability at all.
   * The rule is `startsWith`, so this case composes to nothing and the guarantee still holds.
   */
  it("does not stutter when the context already opens with the visible label", () => {
    render(
      <ConfirmButton
        idleLabel="Delete"
        confirmLabel="Delete? The door re-registers on its next heartbeat with no name."
        ariaLabel="Delete Front door"
        onConfirm={() => {}}
      />,
    );

    const idle = screen.getByRole("button", { name: "Delete Front door" });
    expect(idle.getAttribute("aria-label")!.startsWith("Delete")).toBe(true);

    fireEvent.click(idle);
    const armed = screen.getByRole("button", { name: "Delete Front door — tap again to confirm" });
    expect(armed.getAttribute("aria-label")!.startsWith("Delete")).toBe(true);
  });

  /** A call site with nothing to add is still named by what it says, in both states. */
  it("is named by its own visible text when the call site adds no context", () => {
    render(<ConfirmButton idleLabel="Revoke" confirmLabel="Really revoke?" onConfirm={() => {}} />);

    const button = screen.getByRole("button", { name: "Revoke" });
    expect(button).not.toHaveAttribute("aria-label");
    fireEvent.click(button);
    expect(screen.getByRole("button", { name: "Really revoke?" })).toBeInTheDocument();
  });

  /**
   * B7 / C6 (HIGH / HIGH). Measured on a 360 px phone: the armed fleet control reported
   * `clientHeight 44, scrollHeight 106` — four lines of consequence rendered into a box
   * built for one, cut mid-sentence top and bottom, with the words that name what the
   * click does among the ones not on screen.
   *
   * <p>
   * Three causes, all here: the button carried `overflow-hidden`; all three label states
   * were stacked `absolute inset-0` so only an invisible width sentinel contributed
   * height; and every doors call site passed a fixed `h-11`. jsdom cannot measure any of
   * that, so what it holds is the three properties the measurement depends on.
   * </p>
   */
  it("cannot clip its armed consequence, whatever the call site asks for", () => {
    render(
      <ConfirmButton
        idleLabel="Shut this door"
        confirmLabel={FLEET_CONFIRM}
        onConfirm={() => {}}
        className="h-11 w-full"
      />,
    );

    const button = screen.getByRole("button", { name: "Shut this door" });
    // (a) Nothing clips. A control whose consequence is longer than its box must spill
    // visibly — and then grow — rather than swallow the half that matters.
    expect(button.className).not.toContain("overflow-hidden");
    // (b) The caller's FIXED height does not survive. `min-h-11` after `h-11` is not
    // enough: `h-11` is a height, not a floor, and tailwind-merge keeps both.
    expect(button.className).not.toMatch(/(^|\s)h-11(\s|$)/);
    expect(button.className).toContain("min-h-11");
    // The rest of the caller's classes are untouched.
    expect(button.className).toContain("w-full");
    // (c) 12 px on a consequence four lines long. The base is 14 px.
    expect(button.className).toContain("text-sm");
    expect(button.className).not.toMatch(/(^|\s)text-xs(\s|$)/);
  });

  /**
   * The other half of (b): the label that is SHOWING must be in normal flow, because an
   * absolutely positioned label contributes no height and the button then sizes to
   * whatever else is in the box — which, before this, was an invisible width sentinel.
   */
  it("renders the label that is showing in normal flow, not stacked on top", () => {
    render(<ConfirmButton idleLabel="Shut this door" confirmLabel={FLEET_CONFIRM} onConfirm={() => {}} />);

    const button = screen.getByRole("button", { name: "Shut this door" });
    fireEvent.click(button);

    const showing = Array.from(button.children).find((el) => el.textContent === FLEET_CONFIRM && !el.hasAttribute("aria-hidden"));
    expect(showing, "the armed label is not a direct, non-hidden child of the control").toBeTruthy();
    expect(showing!.className).not.toContain("absolute");
    expect(showing!.className).not.toContain("inset-0");
    // The width sentinel may stay — it is what stops the control resizing as it arms — but
    // it is height-0 and clipped to itself, so it can no longer be the thing setting height.
    const sentinel = button.querySelector("span[aria-hidden].invisible")!;
    expect(sentinel.className).toContain("h-0");
  });

  /**
   * B9 / C10 (MED / MED). The armed state never expired, so a control left armed on a
   * screen in a club office stayed armed — one tap from anybody who walked past.
   *
   * <p>
   * <b>Why 8000 is not the 3000 that was removed.</b> The old 3 s default broke the booking
   * grid: a member who paused to read "Reserve for 50.00 cr?" tapped a control that had
   * already gone back to idle, so the second tap re-armed instead of confirming and a slow
   * reader could tap for ever without booking anything. That was a punishment for reading,
   * and it was invisible — nothing on screen said the window had closed. Three things are
   * different now. The booking grid no longer uses this control at all. The armed control
   * GROWS to fit its consequence at 14 px instead of clipping it, so the reading is
   * possible in the first place. And there is a visible Cancel beside it, so the way out
   * is a control rather than a guess. 8 s is long enough to read a four-line consequence
   * and short enough that an abandoned screen is not a loaded gun.
   * </p>
   */
  it("disarms itself after eight seconds with no timeout asked for", () => {
    vi.useFakeTimers();
    try {
      const onConfirm = vi.fn();
      render(<ConfirmButton idleLabel="Revoke" confirmLabel="Really revoke?" onConfirm={onConfirm} />);

      // fireEvent, not user-event: mixing user-event with fake timers deadlocks under
      // jsdom 28 + vitest 4, and the point here is the timer.
      act(() => { fireEvent.click(screen.getByRole("button", { name: "Revoke" })); });
      expect(screen.getByRole("button", { name: "Really revoke?" })).toBeInTheDocument();

      // Still armed at 7 s — the window is for reading, so it has to be long enough to read in.
      act(() => { vi.advanceTimersByTime(7_000); });
      expect(screen.getByRole("button", { name: "Really revoke?" })).toBeInTheDocument();

      act(() => { vi.advanceTimersByTime(1_500); });
      expect(screen.getByRole("button", { name: "Revoke" })).toBeInTheDocument();
      expect(onConfirm).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * B9's other half. An armed control that survives a blur is armed on a screen nobody is
   * looking at any more — and for a keyboard user, tabbing past a control they decided
   * against left it loaded behind them.
   */
  it("disarms when focus leaves it", () => {
    const onConfirm = vi.fn();
    render(<ConfirmButton idleLabel="Revoke" confirmLabel="Really revoke?" onConfirm={onConfirm} />);

    const button = screen.getByRole("button", { name: "Revoke" });
    fireEvent.click(button);
    expect(screen.getByRole("button", { name: "Really revoke?" })).toBeInTheDocument();

    // relatedTarget null: focus went somewhere else entirely, which is the case that has
    // to disarm. Focus moving INSIDE the control — onto the Cancel beside it — must not.
    fireEvent.blur(button, { relatedTarget: null });
    expect(screen.getByRole("button", { name: "Revoke" })).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  /**
   * C10 (MED). The armed control offered no way out but tapping elsewhere — a way out you
   * have to already know about, on a control whose whole armed message is "this is
   * irreversible". Escape is a keyboard's answer and a phone does not have one.
   */
  it("offers a visible Cancel that says what it cancels and does not confirm", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmButton
        idleLabel="Shut all doors"
        confirmLabel={FLEET_CONFIRM}
        ariaLabel="Shut every door the club has open — 3 of 3"
        onConfirm={onConfirm}
      />,
    );

    // Nothing to cancel before it is armed.
    expect(screen.queryByRole("button", { name: /^Cancel/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Shut all doors/ }));
    const cancel = screen.getByRole("button", { name: /^Cancel/ });
    // A real button, not a div that listens for clicks, and named for the thing it stops —
    // "Cancel" alone, heard out of context in a list of controls, names nothing.
    expect(cancel.tagName).toBe("BUTTON");
    expect(cancel).toHaveAttribute("type", "button");
    expect(cancel.getAttribute("aria-label")).toContain("Shut all doors");
    // 44 px. A get-out that is harder to hit than the destructive control beside it is not one.
    expect(cancel.className).toContain("min-h-11");

    fireEvent.click(cancel);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Shut all doors — Shut every door the club has open — 3 of 3" }))
      .toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Cancel/ })).toBeNull();
  });

  /** Focus moving from the armed control onto its own Cancel must not disarm it first. */
  it("does not disarm when focus moves onto its own Cancel", () => {
    render(
      <ConfirmButton idleLabel="Shut all doors" confirmLabel={FLEET_CONFIRM} onConfirm={() => {}} />,
    );

    const button = screen.getByRole("button", { name: "Shut all doors" });
    fireEvent.click(button);
    const cancel = screen.getByRole("button", { name: /^Cancel/ });

    // A browser focuses a button on pointerdown, so this focusout fires BEFORE the Cancel's
    // click. Disarming on it would unmount the Cancel mid-press and the click would never
    // land — a get-out control that does nothing when you press it.
    fireEvent.blur(button, { relatedTarget: cancel });
    expect(screen.getByRole("button", { name: /^Cancel/ })).toBeInTheDocument();
  });

  /**
   * B19 / A17 (MED / LOW). Two independent reviewers read the decorative `Fingerprint`
   * watermark as an artefact; on a DOOR control it is worse than decoration, because the
   * product really does have biometric identification and a fingerprint on the button that
   * shuts a door reads as a claim about how the door is opened.
   */
  it("carries no decorative watermark", () => {
    const { container } = render(
      <ConfirmButton idleLabel="Shut this door" confirmLabel={FLEET_CONFIRM} onConfirm={() => {}} />,
    );

    expect(container.querySelectorAll("svg")).toHaveLength(0);
  });

  /** Reviewer B, LOW. A spinner that keeps spinning for somebody who asked for less motion. */
  it("stands its spinner down for reduced motion", async () => {
    let release: () => void = () => {};
    const onConfirm = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const { container } = render(
      <ConfirmButton idleLabel="Revoke" confirmLabel="Really revoke?" onConfirm={onConfirm} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    fireEvent.click(screen.getByRole("button", { name: "Really revoke?" }));

    const spinner = container.querySelector("svg")!;
    expect(spinner).toBeTruthy();
    expect(spinner.getAttribute("class")).toContain("motion-reduce:animate-none");

    await act(async () => { release(); });
  });
});
