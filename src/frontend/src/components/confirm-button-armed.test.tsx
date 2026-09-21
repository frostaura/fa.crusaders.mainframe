import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { ConfirmButton } from "./ConfirmButton";

/**
 * The armed state of `ConfirmButton`, rebuilt in round 2.
 *
 * <p>
 * <b>What changed, and why this file is nearly all new.</b> Round 1 made the armed control
 * carry its own consequence as its LABEL, grow to fit it, and disarm itself after eight
 * seconds. Round 2's reviewers drove that on real screens and it failed in three directions
 * at once: at 320×568 the Cancel was clipped by 19 px and at a 32 px root font size the
 * control was 1 232 px tall with its Cancel 1 061 px below the fold; a 45-word consequence
 * takes about thirteen seconds to hear and the window was 8.07 s with no countdown; and
 * every disarm — Escape, Cancel, a blur — was announced as nothing at all, so a listener
 * could not tell a loaded control from a resting one.
 * </p>
 *
 * <p>
 * The shape that replaces it: the consequence is a paragraph of page text ABOVE two
 * side-by-side buttons, the destructive confirm and a Cancel, both at 44 px and both on
 * screen together; no clock; Escape, Cancel, a blur out of the group and a route change all
 * disarm; and one polite region says the consequence on arm, "Cancelled — nothing was
 * changed." on every disarm, and the result on completion.
 * </p>
 *
 * <p>
 * <b>What jsdom can and cannot hold.</b> It has no layout, so every pixel claim above is
 * re-measured in a real browser by `e2e/confirm-armed.spec.ts`, which arms a real control on
 * three real pages at 320×568, 820×1180 and 320 px with a 32 px root font and asserts that
 * both buttons are inside the viewport and that no ancestor clips the consequence.
 * </p>
 */

/** The armed consequence on the real fleet control — long enough to wrap at any width. */
const FLEET_CONFIRM = "Shut all 3 doors? Every door that can reach the club's server opens for nobody"
  + " from this click. Any door that has lost the network keeps admitting booked members from the list"
  + " it last downloaded for up to six hours. No booking and no no-show penalty changes.";

/** The one polite region the control owns. */
const liveRegion = () => document.querySelector("[aria-live='polite']")!;

/** Arm a control the way a person does: focus it, then press it. */
function armByPressing(button: HTMLElement) {
  act(() => {
    button.focus();
    fireEvent.click(button);
  });
}

describe("ConfirmButton — the armed state", () => {
  /**
   * B6 (HIGH). The armed control set `aria-pressed=true`, so VoiceOver said "pressed" on a
   * control that had done nothing yet: the word a screen-reader user hears for "done" was
   * being used for "about to". A toggle it is not — the confirm is a different button, not
   * the off half of the first.
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

    const trigger = screen.getByRole("button", { name: /Shut all doors/ });
    expect(liveRegion().textContent).toBe("");

    armByPressing(trigger);
    const confirm = screen.getByRole("button", { name: /tap again to confirm/ });
    // Not "pressed". Not "not pressed" either — the attribute must be gone, because
    // aria-pressed=false on a control that is not a toggle is its own lie.
    expect(confirm).not.toHaveAttribute("aria-pressed");
    expect(liveRegion().textContent).toContain("Shut all 3 doors?");
    expect(liveRegion().textContent).toContain("up to six hours");
  });

  /**
   * C3 (HIGH). Every disarm was SILENT — the region was emptied, and an emptied live region
   * announces nothing. A screen-reader user who pressed Escape, or tabbed away, or pressed
   * the Cancel, had no way to tell whether the control was still loaded; pressing Enter again
   * to find out is exactly the thing that must not be a way of finding out.
   */
  it("says so out loud on every way back to rest", () => {
    render(<ConfirmButton idleLabel="Revoke" confirmLabel="Really revoke?" onConfirm={() => {}} />);

    const press = () => armByPressing(screen.getByRole("button", { name: "Revoke" }));

    press();
    act(() => { fireEvent.keyDown(document, { key: "Escape" }); });
    expect(liveRegion().textContent).toBe("Cancelled — nothing was changed.");

    press();
    act(() => { fireEvent.click(screen.getByRole("button", { name: /^Cancel/ })); });
    expect(liveRegion().textContent).toBe("Cancelled — nothing was changed.");

    press();
    act(() => { fireEvent.blur(screen.getByRole("button", { name: /^Cancel/ }), { relatedTarget: document.body }); });
    expect(liveRegion().textContent).toBe("Cancelled — nothing was changed.");
  });

  /** And on the way out the other side: the caller's result, or "Done." when it names none. */
  it("announces the result of the action, or that it is done", async () => {
    const { unmount } = render(
      <ConfirmButton idleLabel="Revoke" confirmLabel="Really revoke?" onConfirm={() => "The key is revoked."} />,
    );

    armByPressing(screen.getByRole("button", { name: "Revoke" }));
    fireEvent.click(screen.getByRole("button", { name: "Revoke — Really revoke?" }));
    await waitFor(() => expect(liveRegion().textContent).toBe("The key is revoked."));
    unmount();

    render(<ConfirmButton idleLabel="Delete" confirmLabel="Really delete?" onConfirm={() => {}} />);
    armByPressing(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete — Really delete?" }));
    await waitFor(() => expect(liveRegion().textContent).toBe("Done."));
  });

  /**
   * B16 (MED) — WCAG 2.5.3 label in name. `ariaLabel` REPLACED the visible text, so a
   * control reading "Shut all doors" had the accessible name "Shut every door the club has
   * open — 3 of 3": speech control ("click Shut all doors") misses it, and a screen-reader
   * user reading the screen and hearing the control cannot tell they are the same thing.
   *
   * <p>
   * It holds on the CONFIRM button too, which is where it is least obvious: that button
   * shows the words the trigger showed — the consequence is a paragraph above it now — so
   * its name has to open with them as well.
   * </p>
   */
  it("keeps the visible idle label verbatim at the front of both buttons' names", () => {
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

    armByPressing(idle);
    const confirm = screen.getByRole("button", { name: /tap again to confirm/ });
    expect(confirm.textContent).toBe("Shut all doors");
    expect(confirm).toHaveAttribute(
      "aria-label",
      "Shut all doors — Shut every door the club has open — 3 of 3 — tap again to confirm",
    );
  });

  /**
   * The other branch of the same rule. `idleLabel="Delete"` with `ariaLabel="Delete Front
   * door"` is ALREADY a name that opens with the words on the control, and composing it
   * would give "Delete — Delete Front door" — a stutter that buys no reachability at all.
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
    armByPressing(idle);
    const confirm = screen.getByRole("button", { name: "Delete Front door — tap again to confirm" });
    expect(confirm.getAttribute("aria-label")!.startsWith("Delete")).toBe(true);
  });

  /**
   * A call site with nothing to add: the CONSEQUENCE becomes the context, so the control is
   * still distinguishable in a list of controls and label-in-name still holds — "Delete? The
   * box re-registers…" opens with the word on the button, so nothing is composed onto it.
   */
  it("uses the consequence as the name when the call site adds no context", () => {
    render(
      <ConfirmButton
        idleLabel="Delete"
        confirmLabel="Delete? The box re-registers on its next heartbeat."
        onConfirm={() => {}}
      />,
    );

    const idle = screen.getByRole("button", { name: "Delete" });
    expect(idle).not.toHaveAttribute("aria-label");

    armByPressing(idle);
    const confirm = screen.getByRole("button", { name: "Delete? The box re-registers on its next heartbeat." });
    expect(confirm.getAttribute("aria-label")!.startsWith("Delete")).toBe(true);
  });

  /**
   * B5 / C2 / C7 (HIGH). The consequence is a BLOCK, above the buttons, and it is the single
   * change the three findings come down to.
   *
   * <p>
   * As a label it had to be sized by the control: at 360 px the armed fleet confirm measured
   * `clientHeight 44, scrollHeight 106` with four lines cut mid-sentence; when the clipping
   * was fixed by letting the control grow, a 32 px root font size turned it into a 1 232 px
   * button with its Cancel 1 061 px below the fold. A paragraph has neither problem, because
   * a paragraph is not a touch target.
   * </p>
   */
  it("renders the consequence as ordinary page text above two side-by-side buttons", () => {
    render(
      <ConfirmButton
        idleLabel="Shut this door"
        confirmLabel={FLEET_CONFIRM}
        onConfirm={() => {}}
        className="h-11 w-full"
      />,
    );

    const trigger = screen.getByRole("button", { name: "Shut this door" });
    armByPressing(trigger);

    const consequence = screen.getByText(FLEET_CONFIRM);
    expect(consequence.tagName).toBe("P");
    // 14 px. It was `text-xs` — a 12 px consequence on a phone is most of why it needed four
    // lines in the first place.
    expect(consequence.className).toContain("text-sm");
    expect(consequence.className).not.toMatch(/(^|\s)text-xs(\s|$)/);
    // Nothing clips it, nothing stops it wrapping, and it is not inside either button.
    expect(consequence.className).not.toContain("overflow-hidden");
    expect(consequence.className).not.toContain("truncate");
    expect(consequence.closest("button")).toBeNull();

    // Both buttons, side by side in one row, and both at a real touch size. The caller's
    // FIXED height does not survive onto either: `min-h-11` after `h-11` is not enough,
    // because a height is not a floor and tailwind-merge rightly keeps both.
    const confirm = screen.getByRole("button", { name: /^Shut this door — Shut all 3 doors\?/ });
    const cancel = screen.getByRole("button", { name: /^Cancel/ });
    expect(confirm.parentElement).toBe(cancel.parentElement);
    for (const button of [confirm, cancel]) {
      expect(button.className).toContain("min-h-11");
      expect(button.className).not.toMatch(/(^|\s)h-11(\s|$)/);
    }
    // The rest of the caller's classes are untouched.
    expect(confirm.className).toContain("w-full");
  });

  /**
   * C3's other half. The confirm is a DISTINCT button and focus lands on the safe one, so
   * Enter or Space on the trigger can never do the thing: the trigger is not on screen any
   * more, and the key that arms it is not the key that confirms it.
   */
  it("moves focus to the Cancel when it arms, so a second Enter cannot confirm", () => {
    const onConfirm = vi.fn();
    render(<ConfirmButton idleLabel="Revoke" confirmLabel="Really revoke?" onConfirm={onConfirm} />);

    const trigger = screen.getByRole("button", { name: "Revoke" });
    armByPressing(trigger);

    const cancel = screen.getByRole("button", { name: /^Cancel/ });
    expect(cancel).toHaveFocus();
    // The trigger is gone: there is nothing left that a repeated Enter could land on except
    // the Cancel, and the Cancel cannot confirm.
    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();

    fireEvent.keyDown(cancel, { key: "Enter" });
    fireEvent.click(cancel);
    expect(onConfirm).not.toHaveBeenCalled();
    // And focus comes back to where the person was.
    expect(screen.getByRole("button", { name: "Revoke" })).toHaveFocus();
  });

  /**
   * It may move focus WITHIN itself and put back focus it is about to destroy. It may never
   * take focus from somewhere else — a pointer user reading a form with an armed control on
   * the far side of the page has their focus wherever they left it.
   */
  it("does not take focus from elsewhere on the page", () => {
    render(
      <>
        <input aria-label="Door name" />
        <ConfirmButton idleLabel="Revoke" confirmLabel="Really revoke?" onConfirm={() => {}} />
      </>,
    );

    const field = screen.getByLabelText("Door name");
    act(() => { field.focus(); });
    act(() => { fireEvent.click(screen.getByRole("button", { name: "Revoke" })); });

    expect(screen.getByRole("button", { name: /^Cancel/ })).toBeInTheDocument();
    expect(field).toHaveFocus();
  });

  /** The Cancel says what it cancels, is a real button, and is never there before arming. */
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

    expect(screen.queryByRole("button", { name: /^Cancel/ })).toBeNull();

    armByPressing(screen.getByRole("button", { name: /Shut all doors/ }));
    const cancel = screen.getByRole("button", { name: /^Cancel/ });
    // A real button, not a div that listens for clicks, and named for the thing it stops —
    // "Cancel" alone, heard out of context in a list of controls, names nothing.
    expect(cancel.tagName).toBe("BUTTON");
    expect(cancel).toHaveAttribute("type", "button");
    expect(cancel.getAttribute("aria-label")).toBe("Cancel — Shut all doors");
    // 44 px. A get-out that is harder to hit than the destructive control beside it is not one.
    expect(cancel.className).toContain("min-h-11");

    fireEvent.click(cancel);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /^Cancel/ })).toBeNull();
  });

  /** The new optional prop: a call site with a better word for leaving than "Cancel". */
  it("takes the call site's word for the way out", () => {
    render(
      <ConfirmButton
        idleLabel="Shut this door"
        confirmLabel={FLEET_CONFIRM}
        cancelLabel="Keep it open"
        onConfirm={() => {}}
      />,
    );

    armByPressing(screen.getByRole("button", { name: "Shut this door" }));
    const cancel = screen.getByRole("button", { name: "Keep it open — Shut this door" });
    expect(cancel.textContent).toBe("Keep it open");
  });

  /**
   * B9's surviving half. An armed control that outlives a blur is armed on a screen nobody
   * is looking at any more — and for a keyboard user, tabbing past a control they decided
   * against left it loaded behind them.
   */
  it("disarms when focus leaves the whole group, and not when it moves inside it", () => {
    const onConfirm = vi.fn();
    render(<ConfirmButton idleLabel="Revoke" confirmLabel="Really revoke?" onConfirm={onConfirm} />);

    armByPressing(screen.getByRole("button", { name: "Revoke" }));
    const confirm = screen.getByRole("button", { name: "Revoke — Really revoke?" });
    const cancel = screen.getByRole("button", { name: /^Cancel/ });

    // A browser focuses a button on POINTERDOWN, so this focusout fires before the Cancel's
    // own click. Disarming on it would unmount the Cancel mid-press and the click would
    // never land — a get-out control that does nothing when you press it.
    fireEvent.blur(confirm, { relatedTarget: cancel });
    expect(screen.getByRole("button", { name: /^Cancel/ })).toBeInTheDocument();

    fireEvent.blur(cancel, { relatedTarget: document.body });
    expect(screen.getByRole("button", { name: "Revoke" })).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  /**
   * B5 — and a route change, which is the disarm the timer was really standing in for.
   *
   * <p>
   * A control armed about a door on a page that has been replaced is armed about nothing,
   * and the banner store re-reads on navigation while this did not. It is read from the
   * router's own context rather than through `useLocation`, because this component is
   * rendered outside a router by half the tests that touch it and `useLocation` raises there.
   * </p>
   */
  it("disarms on a route change", async () => {
    function Elsewhere() {
      const navigate = useNavigate();
      return <button type="button" onClick={() => navigate("/schedule")}>Go to bookings</button>;
    }

    render(
      <MemoryRouter initialEntries={["/admin/doors"]}>
        <Elsewhere />
        <Routes>
          <Route
            path="*"
            element={<ConfirmButton idleLabel="Shut this door" confirmLabel={FLEET_CONFIRM} onConfirm={() => {}} />}
          />
        </Routes>
      </MemoryRouter>,
    );

    armByPressing(screen.getByRole("button", { name: "Shut this door" }));
    expect(screen.getByRole("button", { name: /^Cancel/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Go to bookings" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Cancel/ })).toBeNull());
    expect(screen.getByRole("button", { name: "Shut this door" })).toBeInTheDocument();
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

    armByPressing(screen.getByRole("button", { name: "Revoke" }));
    fireEvent.click(screen.getByRole("button", { name: "Revoke — Really revoke?" }));

    const spinner = container.querySelector("svg")!;
    expect(spinner).toBeTruthy();
    expect(spinner.getAttribute("class")).toContain("motion-reduce:animate-none");
    // And the way out stays on screen while the action is in flight, disabled rather than
    // removed: a button that unmounts under a focused finger drops focus to <body>.
    expect(screen.getByRole("button", { name: /^Cancel/ })).toBeDisabled();

    await act(async () => { release(); });
  });
});
