import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConfirmButton } from "./ConfirmButton";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";

/**
 * A confirm that settles inside a dialog hands focus back to its own trigger, not to the dialog.
 *
 * <p>
 * R10 X10-2's root, measured on the desk's Sell sheet: when the armed pair unmounts while it holds
 * focus, Radix's FocusScope moves focus to the dialog CONTENT element before ConfirmButton's
 * restore effect runs. That effect only restored from `<body>`, so a keyboard user was left on
 * `[role=dialog]` — announced as the whole sheet, with Tab starting over from its top. FB10 fixed
 * the Sell sheet in its own files; this is the general rule for every ConfirmButton in a dialog
 * whose step survives the press.
 * </p>
 */
/**
 * jsdom flushes React's effects inside `act` before Radix's MutationObserver can park focus on the
 * content element, so the parking a real browser does (X10-2's evidence) is modelled where the
 * restore effect reads it: once the armed confirm has gone and focus has fallen to `<body>`,
 * `document.activeElement` answers the dialog container, as FocusScope makes it in Chromium.
 */
function parkFallenFocusOnDialog(go: HTMLElement) {
  const real = Object.getOwnPropertyDescriptor(Document.prototype, "activeElement")!.get!;
  vi.spyOn(document, "activeElement", "get").mockImplementation(function (this: Document) {
    const active = real.call(this) as Element | null;
    if ((active === null || active === document.body) && !go.isConnected) {
      return document.querySelector("[role=dialog]");
    }
    return active;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ConfirmButton inside a dialog", () => {
  it("returns focus to its trigger after the action settles, not to the dialog container", async () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Sell a package</DialogTitle>
          <DialogDescription>Body</DialogDescription>
          <ConfirmButton idleLabel="Sell 1 hour" confirmLabel="Sell 1 hour to Sam?" onConfirm={async () => {}} />
        </DialogContent>
      </Dialog>,
    );

    const trigger = screen.getByRole("button", { name: "Sell 1 hour" });
    act(() => {
      trigger.focus();
      fireEvent.click(trigger);
    });
    const go = document.querySelector<HTMLButtonElement>("[data-confirm='go']")!;
    parkFallenFocusOnDialog(go);
    await act(async () => {
      go.focus();
      fireEvent.click(go, { detail: 1 });
    });

    await waitFor(() => expect(document.querySelector("[data-confirm='go']")).toBeNull());
    await waitFor(() => {
      const active = document.activeElement;
      expect(active?.getAttribute("role"), "focus was left on the dialog container").not.toBe("dialog");
      expect(active).toBe(screen.getByRole("button", { name: "Sell 1 hour" }));
    });
  });
});
