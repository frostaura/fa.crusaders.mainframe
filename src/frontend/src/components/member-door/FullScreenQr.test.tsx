import { StrictMode, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BrowserRouter, Link, Route, Routes, useLocation } from "react-router-dom";
import { FullScreenQr } from "./FullScreenQr";

/**
 * The full-screen code, and the gesture a member at a door actually makes.
 *
 * <p>
 * <b>Why this file uses `BrowserRouter` when every other test in this tree uses
 * `MemoryRouter`.</b> The whole of what is under test is a real `window.history` entry
 * and a real `popstate`, and `MemoryRouter` has neither: it keeps its own in-memory stack
 * and never touches the browser's. A test of this behaviour under `MemoryRouter` would
 * pass against an implementation that does nothing at all, which is the outcome the
 * reviewer's finding already had.
 * </p>
 *
 * <p>
 * The finding: back is the close gesture on a phone, and pressing it left the page
 * entirely — a member holding a code up at a door landed on the schedule. The previous
 * implementation declined a history entry deliberately, on the grounds that a synthetic
 * one has to fight the router's stack. It does; these tests are what makes that fight
 * observable rather than a reason not to try.
 * </p>
 */
describe("FullScreenQr", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    // Every test here pushes real entries. Left behind, they make the next file's first
    // `history.back()` navigate somewhere nobody chose.
    window.history.replaceState(null, "", "/");
  });

  /** D12's dead-end sentence, with the club's number in it as a pressable link. */
  const DEAD_SENTENCE = {
    text: "This code has run out and can't be renewed without signal. Phone the club on ",
    link: { href: "tel:0215550134", text: "021 555 0134" },
    tail: ".",
  };

  /** The overlay, opened and closed by a control, inside a real router. */
  function Host(props: { dead?: boolean; renewing?: boolean; onTryAgain?: () => void }) {
    const [open, setOpen] = useState(false);
    const location = useLocation();
    return (
      <div>
        <p data-testid="where">{location.pathname}</p>
        <button type="button" onClick={() => setOpen(true)}>Show your code full screen</button>
        <Link to="/schedule">Go to the schedule</Link>
        {open && (
          <FullScreenQr
            code="7K3M9XQ2RD5A"
            secondsLeft={props.dead ? 0 : 612}
            dead={props.dead ?? false}
            renewing={props.renewing ?? false}
            deadSentence={DEAD_SENTENCE}
            onTryAgain={props.onTryAgain ?? (() => {})}
            onClose={() => setOpen(false)}
          >
            <svg role="img" aria-label="QR code 7K3M9XQ2RD5A" />
          </FullScreenQr>
        )}
      </div>
    );
  }

  function renderHost(props: { dead?: boolean; renewing?: boolean; onTryAgain?: () => void } = {}) {
    window.history.replaceState(null, "", "/my-code");
    return render(
      <BrowserRouter>
        <Routes>
          <Route path="/my-code" element={<Host {...props} />} />
          <Route path="/schedule" element={<p>the schedule</p>} />
        </Routes>
      </BrowserRouter>,
    );
  }

  const open = () => fireEvent.click(screen.getByRole("button", { name: "Show your code full screen" }));

  /** The gesture itself, through the browser's own history rather than a simulated one. */
  it("closes on the hardware back button instead of leaving the page", async () => {
    renderHost();
    open();
    await screen.findByRole("dialog", { name: /full screen/i });
    // One entry, at the same url, carrying our marker. `history.length` is deliberately
    // NOT what is asserted: jsdom cannot truncate backwards, so a previous test's
    // `back()` leaves the stack mid-way and the next `pushState` drops the forward
    // entries — the length then moves by zero, one or minus one depending on what ran
    // before, which is a test that fails for reasons that have nothing to do with this
    // component. The marker is the thing the cleanup guard actually reads.
    expect((window.history.state as { fullScreenQr?: number }).fullScreenQr).toEqual(expect.any(Number));
    expect(window.location.pathname).toBe("/my-code");

    await act(async () => {
      window.history.back();
      await new Promise((r) => setTimeout(r, 0));
    });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Still on the page. The router is not confused, and nothing navigated.
    expect(screen.getByTestId("where")).toHaveTextContent("/my-code");
    expect(screen.queryByText("the schedule")).toBeNull();
  });

  /**
   * The other half, and the one that makes the entry safe: closing by TAP has to unwind
   * the entry, or every open leaves a dead step in the member's history and back stops
   * working for the rest of the session.
   */
  it("unwinds its own entry when the code is closed by tapping Done", async () => {
    renderHost();
    open();
    await screen.findByRole("dialog", { name: /full screen/i });
    expect((window.history.state as { fullScreenQr?: number }).fullScreenQr).toEqual(expect.any(Number));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
      await new Promise((r) => setTimeout(r, 0));
    });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => {
      expect((window.history.state as { fullScreenQr?: number } | null)?.fullScreenQr).toBeUndefined();
    });
    expect(screen.getByTestId("where")).toHaveTextContent("/my-code");
  });

  /**
   * The failure mode the previous implementation was right to be afraid of: our entry is
   * buried under a real navigation, and unwinding it on unmount would steal a step of
   * somebody else's history — sending a member backwards from a page they had just chosen.
   */
  it("steals no history step when the member navigated away with it open", async () => {
    renderHost();
    open();
    await screen.findByRole("dialog", { name: /full screen/i });

    await act(async () => {
      fireEvent.click(screen.getByRole("link", { name: "Go to the schedule" }));
      await new Promise((r) => setTimeout(r, 0));
    });

    // The router navigated, the overlay unmounted with it, and nothing went backwards.
    expect(await screen.findByText("the schedule")).toBeInTheDocument();
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(window.location.pathname).toBe("/schedule");
  });

  /** Escape and a tap outside still close it, and neither is changed by the entry. */
  it("still closes on Escape", async () => {
    renderHost();
    open();
    await screen.findByRole("dialog", { name: /full screen/i });

    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  // --- D10: it has to actually fill the screen ------------------------------------------

  /**
   * <b>Three separate things were wrong with one `min(92vw, 92vh)`.</b> In landscape it is
   * a square as tall as the viewport with a code line and a button still to place under
   * it, so a `justify-center` column overflowed at BOTH ends: the symbol's top quiet zone
   * went off the top of the glass and "Done" — a 44px control — went off the bottom as a
   * 22px sliver. jsdom computes no layout, so the Playwright check is what proves the
   * geometry; what this holds is the contract that produces it.
   */
  it("bounds the symbol on both axes and reserves the rest of the column", () => {
    renderHost();
    open();
    const dialog = screen.getByRole("dialog", { name: /full screen/i });
    const square = dialog.querySelector("svg")!.parentElement!;

    expect(square.className).toContain("w-[min(100vw-1rem,100vh-6.5rem)]");
    expect(square.className).toContain("h-[min(100vw-1rem,100vh-6.5rem)]");
    expect(square.className).not.toContain("92vh");
  });

  /**
   * The app header is a sticky `z-30` in its own right and was showing through the top
   * edge of this overlay in landscape. Every non-white pixel here is light the scanner
   * does not get.
   */
  it("sits above the app header and puts no scrim over the white", () => {
    renderHost();
    open();
    const dialog = screen.getByRole("dialog", { name: /full screen/i });

    expect(dialog.className).toContain("z-[60]");
    expect(dialog.className).toContain("bg-white");
    expect(dialog.className).not.toMatch(/bg-black|\/\d\d\b|opacity-/);
  });

  it("keeps Done at a size a cold thumb can find", () => {
    renderHost();
    open();
    expect(screen.getByRole("button", { name: "Done" }).className).toContain("min-h-11");
  });

  /** Twelve tracked monospace characters are wider than a phone once the root font is up. */
  it("lets the fallback code wrap rather than run off the glass", () => {
    renderHost();
    open();
    const code = screen.getByText("7K3M9XQ2RD5A");
    expect(code.className).toContain("break-all");
    expect(code.className).toContain("max-w-full");
  });

  /**
   * One entry per opening, however many times React runs the effect.
   *
   * <p>
   * <b>This is the bug a browser found in two seconds and jsdom could not see.</b> React
   * mounts, unmounts and remounts every effect once in development, and a push per
   * invocation left two entries behind one overlay: the member closed the code, pressed
   * back expecting to leave the page, and stayed on it. The e2e caught it; nothing here
   * did, because `render` does not double-invoke. `StrictMode` is what makes the same
   * defect visible at this layer, which is where it is cheap to keep visible.
   * </p>
   */
  it("pushes one entry per opening even when React runs the effect twice", async () => {
    const pushes: unknown[] = [];
    const real = window.history.pushState.bind(window.history);
    vi.spyOn(window.history, "pushState").mockImplementation((state, title, url) => {
      if ((state as { fullScreenQr?: number } | null)?.fullScreenQr !== undefined) pushes.push(state);
      real(state, title, url);
    });

    window.history.replaceState(null, "", "/my-code");
    render(
      <StrictMode>
        <BrowserRouter>
          <Routes>
            <Route path="/my-code" element={<Host />} />
            <Route path="/schedule" element={<p>the schedule</p>} />
          </Routes>
        </BrowserRouter>
      </StrictMode>,
    );
    open();
    await screen.findByRole("dialog", { name: /full screen/i });

    expect(pushes).toHaveLength(1);
  });

  /**
   * A browser that refuses `pushState` — a sandboxed frame, a `file:` url — gets the
   * overlay without the gesture, and must not get a stolen history step with it.
   *
   * <p>
   * Without the guard, `dismiss` calls `history.back()` off an entry that was never
   * pushed: the member taps Done on their code and the app navigates to wherever they
   * came from. This is the one state where the guard is the only thing standing between
   * the two.
   * </p>
   */
  it("closes without going back when the entry could not be pushed at all", async () => {
    vi.spyOn(window.history, "pushState").mockImplementation(() => {
      throw new Error("pushState refused");
    });
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});

    renderHost();
    open();
    await screen.findByRole("dialog", { name: /full screen/i });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
      await new Promise((r) => setTimeout(r, 0));
    });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(back).not.toHaveBeenCalled();
  });
});
