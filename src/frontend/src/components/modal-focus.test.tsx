import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { CLOSE_LABEL, Modal, MODAL_KEPT_OPEN } from "./Modal";
import { ToastProvider, useToast } from "./Toast";

/*
 * Modal now renders through `ui/dialog` (Radix). Three consequences for the harness, none for
 * the promises being tested:
 *  - Radix marks everything outside an open modal `aria-hidden`, so elements behind the dialog
 *    are looked up BEFORE it opens (or with `hidden: true`) — a role query cannot see them after.
 *  - The dialog is the PANEL now; the scrim is a sibling (`data-slot="dialog-overlay"`), and
 *    Radix dismisses on the click that follows an outside pointer-down, so a scrim click is the
 *    full pointer/mouse sequence after one zero-delay tick (see `clickScrim`).
 *  - Every dialog carries the close × (last in the DOM, named CLOSE_LABEL), so it is the last
 *    focusable.
 */

/** Radix registers its outside-pointer listener on a zero-delay timer after mount. */
async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

function scrim(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-slot="dialog-overlay"]');
  if (!el) throw new Error("no scrim rendered");
  return el;
}

/** A mouse click on the scrim (or anything else outside), as a browser sends it. */
async function clickScrim(el: HTMLElement = scrim()) {
  await settle();
  act(() => {
    fireEvent.pointerDown(el, { button: 0, pointerType: "mouse" });
    fireEvent.mouseDown(el, { button: 0 });
    fireEvent.pointerUp(el, { button: 0, pointerType: "mouse" });
    fireEvent.mouseUp(el, { button: 0 });
    fireEvent.click(el, { button: 0 });
  });
}

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
          <button>Book for 50.00 cr</button>
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

  it("lands inside the dialog, never on <body>, when it has no control of its own", () => {
    render(
      <Modal title="Temporary password generated" onClose={() => {}}>
        <p>Read this and write it down.</p>
      </Modal>,
    );
    // The panel used to be the floor under the trap. Every dialog now carries the close ×, so
    // there is always a real control to land on — and it is inside the dialog.
    expect(screen.getByRole("button", { name: CLOSE_LABEL })).toHaveFocus();
    expect(screen.getByRole("dialog")).toContainElement(document.activeElement as HTMLElement);
  });

  it("always carries a 44px close button, which closes it", () => {
    const onClose = vi.fn();
    render(<Modal title="Confirm booking" onClose={onClose}><button>Cancel</button></Modal>);
    const close = screen.getByRole("button", { name: CLOSE_LABEL });
    expect(close.className).toContain("size-touch");
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalled();
  });

  it("names its close × apart from a footer button that already says Close", () => {
    render(<Modal title="Credit adjusted" onClose={() => {}}><button>Close</button></Modal>);
    expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: CLOSE_LABEL })).toBeInTheDocument();
  });

  it("is named by an h2 title, and declares itself modal", () => {
    render(<Modal title="Confirm booking" onClose={() => {}}><p>Body</p></Modal>);
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("dialog", { name: "Confirm booking" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Confirm booking" })).toBeInTheDocument();
  });
});

describe("Tab does not walk out of it", () => {
  it("wraps from the last control back to the first", () => {
    render(<Harness />);
    open();
    const first = screen.getByRole("button", { name: "Keep looking" });
    // The close × is last in the DOM, so it is the last stop before the wrap.
    const last = screen.getByRole("button", { name: CLOSE_LABEL });

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
    const last = screen.getByRole("button", { name: CLOSE_LABEL });

    act(() => { first.focus(); });
    // Measured before: six Shift+Tabs reached an "Available" grid cell behind the scrim.
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
  });

  it("pulls focus back in when something outside has taken it", () => {
    render(<Harness />);
    const outside = screen.getByRole("link", { name: "Skip to main content" });
    open();
    act(() => { outside.focus(); });
    fireEvent.keyDown(document, { key: "Tab" });
    expect(screen.getByRole("button", { name: "Keep looking" })).toHaveFocus();
  });

  it("leaves every key that is not Tab alone", () => {
    render(<Harness />);
    open();
    const last = screen.getByRole("button", { name: "Book for 50.00 cr" });
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

  /**
   * The page's choice wins. While the dialog is open its trap holds focus, so the deliberate move
   * happens once it has closed — a receipt heading, the row that replaced the one just edited —
   * and nothing a tick later (Radix's deferred focus handling runs on a zero-delay timer) may
   * snatch it back.
   */
  it("does not take focus from a page that moved it somewhere deliberate", async () => {
    render(<Harness />);
    const elsewhere = screen.getByRole("button", { name: "Book Court 1 at 23:15" });
    open();
    act(() => { fireEvent.keyDown(document, { key: "Escape" }); });
    act(() => { elsewhere.focus(); });
    await settle();
    expect(elsewhere).toHaveFocus();
  });
});

describe("an overlay click never discards what somebody typed", () => {
  it("still closes a dialog nobody has touched", async () => {
    const onClose = vi.fn();
    render(<Modal title="Confirm booking" onClose={onClose}><button>Keep looking</button></Modal>);
    await clickScrim();
    expect(onClose).toHaveBeenCalled();
  });

  it("refuses once there is a typed reason in it", async () => {
    const onClose = vi.fn();
    render(
      <Modal title="Reject this application" onClose={onClose}>
        <input aria-label="Reason" />
      </Modal>,
    );
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Not a member yet" } });
    await clickScrim();
    // D3-B05: this used to close and take the reason with it, silently.
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Reason")).toHaveValue("Not a member yet");
  });

  it("counts a picked option as something typed", async () => {
    const onClose = vi.fn();
    render(
      <Modal title="Adjust credit" onClose={onClose}>
        <select aria-label="Reason">
          <option value="">Choose…</option>
          <option value="goodwill">Goodwill</option>
        </select>
      </Modal>,
    );
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "goodwill" } });
    await clickScrim();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("says so out loud, and says it again on a second mis-tap", async () => {
    render(<Modal title="Reject" onClose={() => {}}><input aria-label="Reason" /></Modal>);
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "x" } });

    const region = screen.getByRole("dialog").querySelector("[aria-live]")!;
    expect(region.textContent).toBe("");
    await clickScrim();
    expect(region.textContent).toBe(MODAL_KEPT_OPEN);
    // Re-keyed on every refusal: a live region whose text does not change says nothing twice.
    const first = region.firstElementChild;
    await clickScrim();
    expect(region.textContent).toBe(MODAL_KEPT_OPEN);
    expect(region.firstElementChild).not.toBe(first);
  });

  it("still lets Escape close it, because Escape is not a mis-tap", () => {
    const onClose = vi.fn();
    render(<Modal title="Reject" onClose={onClose}><input aria-label="Reason" /></Modal>);
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "x" } });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("stays open when a toast raised over it is tapped away", async () => {
    const onClose = vi.fn();
    function Page() {
      const toast = useToast();
      return (
        <Modal title="Confirm booking" onClose={onClose}>
          <button onClick={() => toast.push({ text: "Court 1 is no longer free." })}>Book</button>
        </Modal>
      );
    }
    render(<ToastProvider><Page /></ToastProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Book" }));
    await clickScrim(screen.getByRole("status", { hidden: true }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("leaves a click inside the panel alone", () => {
    const onClose = vi.fn();
    render(<Modal title="Confirm" onClose={onClose}><button>Keep looking</button></Modal>);
    fireEvent.click(screen.getByRole("button", { name: "Keep looking" }));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("under StrictMode's mount → cleanup → mount", () => {
  /*
   * Two real defects in this product only StrictMode could show (memory/gotchas-frontend.md).
   * Here the risk is the restore cleanup running on the simulated unmount and dragging focus
   * back out to the opener while the dialog is still open.
   */
  it("still lands inside, traps, and restores the opener on close", async () => {
    render(<Harness />, { reactStrictMode: true });
    const opener = screen.getByRole("button", { name: "Book Court 4 at 23:15" });
    open();
    await settle();
    expect(screen.getByRole("button", { name: "Keep looking" })).toHaveFocus();
    act(() => { fireEvent.keyDown(document, { key: "Escape" }); });
    expect(opener).toHaveFocus();
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
