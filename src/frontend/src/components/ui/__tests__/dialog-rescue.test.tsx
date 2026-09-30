import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../dialog";

/**
 * The focus rescue a closed dialog queues (`rescueFromBody`) must not outlive what it rescues.
 *
 * <p>
 * CI run 36669954126 (Frontend 3/3) failed with an uncaught "ReferenceError: document is not
 * defined" at dialog.tsx: the rescue's timer, queued by a dialog closed in AdminMembers.test.tsx,
 * fired after the test environment had been torn down. In a browser the same leak is a stray focus
 * move after something else already placed focus. The timer is now tracked: a newer dialog opening
 * cancels it, and it never touches a `document` that is gone.
 * </p>
 */

function Probe({ open, label = "A" }: { open: boolean; label?: string }) {
  return (
    <main id="main-content" tabIndex={-1}>
      <Dialog open={open}>
        <DialogContent>
          <DialogTitle>Dialog {label}</DialogTitle>
          <DialogDescription>Body</DialogDescription>
          <input aria-label={`Field ${label}`} />
        </DialogContent>
      </Dialog>
    </main>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the close-focus rescue", () => {
  it("never throws when its dialog is closed and unmounted and the document goes away before it runs", () => {
    vi.useFakeTimers();
    const view = render(<Probe open />);
    view.rerender(<Probe open={false} />); // closes: Radix hands focus back, nothing to return to → rescue queued
    view.unmount();
    // Radix hands focus back from its own zero-delay timer; that is what queues the rescue.
    act(() => { vi.advanceTimersByTime(0); });
    vi.stubGlobal("document", undefined);

    expect(() => vi.runOnlyPendingTimers()).not.toThrow();
  });
});
