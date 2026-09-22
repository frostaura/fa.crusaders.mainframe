import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { Modal, MODAL_KEPT_OPEN } from "./Modal";

/**
 * D3-B05 / D4 §2.3 — the dialog that claimed `aria-modal` and managed no focus.
 *
 * <p>
 * Every test here was red before the rewrite. They are written from the measurements on the
 * live booking dialog rather than from the component: focus stayed on the cell behind, three
 * Tabs walked out into "Skip to main content", six Shift+Tabs reached a grid cell behind the
 * scrim, and Escape handed focus to a DIFFERENT court's cell — which on a grid of
 * near-identical buttons is how a wrong booking gets made.
 * </p>
 */

/** A page with an opener, a dialog, and something outside it to escape to. */
function Harness({ withField = false, initialFocus }: { withField?: boolean; initialFocus?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Book Court 4 at 23:15</button>
      <button>Book Court 1 at 23:15</button>
      <a href="#main-content">Skip to main content</a>
      {open && (
        <Modal
          title="Confirm booking"
          onClose={() => setOpen(false)}
          initialFocus={initialFocus ? () => document.getElementById("reason") : undefined}
        >
          <button>Keep looking</button>
          {withField && <input id="reason" aria-label="Reason" />}
          <button>Book for R50.00</button>
        </Modal>
      )}
    </>
  );
}

/**
 * Open it the way a browser does: focus, then click.
 *
 * <p>
 * jsdom's `click` does NOT move focus, and a real one does. Without the `focus()` the opener
 * is `document.body` at the moment the dialog captures it, and the restore test passes or
 * fails on a difference between the runner and a browser rather than on the component —
 * which is the shape of green test that let this defect ship in the first place.
 * </p>
 */
const open = () => act(() => {
  const opener = screen.getByRole("button", { name: "Book Court 4 at 23:15" });
  opener.focus();
  fireEvent.click(opener);
});

describe("focus goes into the dialog", () => {
  it("lands on the first focusable thing inside it, not on the cell behind", () => {
    render(<Harness />);
    open();
    // Measured before: `{ tag: "BUTTON", label: "Book Court 4 at 23:15…", inDialog: false }`.
    expect(screen.getByRole("button", { name: "Keep looking" })).toHaveFocus();
  });

  it("takes the call site's target where the first focusable is the wrong one", () => {
    render(<Harness withField initialFocus />);
    open();
    expect(screen.getByLabelText("Reason")).toHaveFocus();
  });

  it("falls back to the panel rather than to <body> when there is nothing focusable", () => {
    render(
      <Modal title="Temporary password generated" onClose={() => {}}>
        <p>Read this and write it down.</p>
      </Modal>,
    );
    expect(document.activeElement).toBe(screen.getByRole("dialog").querySelector("[tabindex='-1']"));
  });
});

describe("Tab does not walk out of it", () => {
  it("wraps from the last control back to the first", () => {
    render(<Harness />);
    open();
    const first = screen.getByRole("button", { name: "Keep looking" });
    const last = screen.getByRole("button", { name: "Book for R50.00" });

    act(() => { last.focus(); });
    // Measured before: the third Tab reached "Skip to main content" — outside the dialog the
    // `aria-modal` says the person is confined to.
    fireEvent.keyDown(document, { key: "Tab" });
    expect(first).toHaveFocus();
  });

  it("wraps backwards from the first control to the last", () => {
    render(<Harness />);
    open();
    const first = screen.getByRole("button", { name: "Keep looking" });
    const last = screen.getByRole("button", { name: "Book for R50.00" });

    act(() => { first.focus(); });
    // Measured before: six Shift+Tabs reached an "Available" grid cell behind the scrim.
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
  });

  it("pulls focus back in when something outside has taken it", () => {
    render(<Harness />);
    open();
    const outside = screen.getByRole("link", { name: "Skip to main content" });
    act(() => { outside.focus(); });
    fireEvent.keyDown(document, { key: "Tab" });
    expect(screen.getByRole("button", { name: "Keep looking" })).toHaveFocus();
  });

  it("leaves every key that is not Tab alone", () => {
    render(<Harness />);
    open();
    const last = screen.getByRole("button", { name: "Book for R50.00" });
    act(() => { last.focus(); });
    fireEvent.keyDown(document, { key: "ArrowDown" });
    // A trap that swallowed arrow keys would break every tablist, menu and select inside a
    // dialog, which is most of what `AdminMembers` puts in one.
    expect(last).toHaveFocus();
  });
});

describe("focus comes back to whoever opened it", () => {
  it("restores the opener on Escape, not a near neighbour", () => {
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Book Court 4 at 23:15" });
    open();
    act(() => { fireEvent.keyDown(document, { key: "Escape" }); });
    // Measured before: focus landed on "Book Court 1 at 23:15" — a different court.
    expect(opener).toHaveFocus();
  });

  it("does not take focus from a page that moved it somewhere deliberate", () => {
    render(<Harness />);
    open();
    const elsewhere = screen.getByRole("button", { name: "Book Court 1 at 23:15" });
    act(() => {
      elsewhere.focus();
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(elsewhere).toHaveFocus();
  });
});

describe("an overlay click never discards what somebody typed", () => {
  const overlay = () => screen.getByRole("dialog");

  it("still closes a dialog nobody has touched", () => {
    const onClose = vi.fn();
    render(<Modal title="Confirm booking" onClose={onClose}><button>Keep looking</button></Modal>);
    fireEvent.click(overlay());
    expect(onClose).toHaveBeenCalled();
  });

  it("refuses once there is a typed reason in it", () => {
    const onClose = vi.fn();
    render(
      <Modal title="Reject this application" onClose={onClose}>
        <input aria-label="Reason" />
      </Modal>,
    );
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Not a member yet" } });
    fireEvent.click(overlay());
    // D3-B05: this used to close and take the reason with it, silently.
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Reason")).toHaveValue("Not a member yet");
  });

  it("counts a picked option as something typed", () => {
    const onClose = vi.fn();
    render(
      <Modal title="Adjust the wallet" onClose={onClose}>
        <select aria-label="Reason">
          <option value="">Choose…</option>
          <option value="goodwill">Goodwill</option>
        </select>
      </Modal>,
    );
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "goodwill" } });
    fireEvent.click(overlay());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("says so out loud, and says it again on a second mis-tap", () => {
    render(<Modal title="Reject" onClose={() => {}}><input aria-label="Reason" /></Modal>);
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "x" } });

    const region = screen.getByRole("dialog").querySelector("[aria-live]")!;
    expect(region.textContent).toBe("");
    fireEvent.click(screen.getByRole("dialog"));
    expect(region.textContent).toBe(MODAL_KEPT_OPEN);
  });

  it("still lets Escape close it, because Escape is not a mis-tap", () => {
    const onClose = vi.fn();
    render(<Modal title="Reject" onClose={onClose}><input aria-label="Reason" /></Modal>);
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "x" } });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("leaves a click inside the panel alone", () => {
    const onClose = vi.fn();
    render(<Modal title="Confirm" onClose={onClose}><button>Keep looking</button></Modal>);
    fireEvent.click(screen.getByRole("button", { name: "Keep looking" }));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("what was already true stays true", () => {
  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(<Modal onClose={onClose} title="Connect"><p>Body</p></Modal>);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("restores page scrolling when it goes away", () => {
    const { unmount } = render(<Modal onClose={() => {}} title="Connect"><p>Body</p></Modal>);
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).not.toBe("hidden");
  });

  it("carries a describedby when the call site names one, and none when it does not", () => {
    const { unmount } = render(<Modal onClose={() => {}} title="Connect"><p id="why">Body</p></Modal>);
    // Measured on the live dialog as `ariaDescribedby: null`; optional rather than invented,
    // because a describedby pointing at nothing is worse than none.
    expect(screen.getByRole("dialog")).not.toHaveAttribute("aria-describedby");
    unmount();
    render(<Modal onClose={() => {}} title="Connect" describedById="why"><p id="why">Body</p></Modal>);
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-describedby", "why");
  });
});
