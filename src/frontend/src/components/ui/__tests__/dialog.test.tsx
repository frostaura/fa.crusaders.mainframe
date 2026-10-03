import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  DIALOG_KEPT_OPEN,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../dialog";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "../sheet";

const strict = { reactStrictMode: true };

type HarnessProps = {
  guardTyped?: boolean;
  focusSuspend?: boolean;
  onOpenChange?: (open: boolean) => void;
};

function Suspend({ guardTyped, focusSuspend, onOpenChange }: HarnessProps) {
  return (
    <Dialog onOpenChange={onOpenChange}>
      <DialogTrigger>Suspend Sam</DialogTrigger>
      <DialogContent
        guardTyped={guardTyped}
        initialFocus={focusSuspend ? () => document.getElementById("suspend-go") : undefined}
      >
        <DialogHeader>
          <DialogTitle>Suspend member</DialogTitle>
          <DialogDescription>Say why, so the committee can see it.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <label>
            Reason
            <input name="reason" />
          </label>
        </DialogBody>
        <DialogFooter>
          <DialogClose>Cancel</DialogClose>
          <button id="suspend-go" type="button">
            Suspend
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Radix registers its outside-pointer listener on a zero-delay timer after mount. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function open() {
  const trigger = screen.getByRole("button", { name: "Suspend Sam" });
  fireEvent.click(trigger);
  return { trigger, dialog: screen.getByRole("dialog", { name: "Suspend member" }) };
}

/**
 * A mouse click on the scrim. Radix Dialog defers an outside pointer-down to the click that
 * follows it (`deferPointerDownOutside`), so a bare pointerdown dismisses nothing.
 */
function clickScrim() {
  const scrim = overlay();
  fireEvent.pointerDown(scrim, { button: 0, pointerType: "mouse" });
  fireEvent.mouseDown(scrim, { button: 0 });
  fireEvent.pointerUp(scrim, { button: 0, pointerType: "mouse" });
  fireEvent.mouseUp(scrim, { button: 0 });
  fireEvent.click(scrim, { button: 0 });
}

function overlay(): HTMLElement {
  const scrim = document.querySelector<HTMLElement>('[data-slot="dialog-overlay"]');
  if (!scrim) throw new Error("no scrim rendered");
  return scrim;
}

describe("Dialog", () => {
  it("always renders a 44px close button named Close + the dialog's title, and it closes the dialog", async () => {
    render(<Suspend />, strict);
    const { dialog, trigger } = open();
    // F4-9 — never a bare "Close"/"Cancel" that a footer button shares.
    const close = within(dialog).getByRole("button", { name: "Close Suspend member" });
    // R6 L6-16 — at least 44px, and growing with the text.
    expect(close.className).toContain("size-[max(44px,2rem)]");
    expect(close.className).not.toMatch(/outline-none|focus-visible:ring/);
    fireEvent.click(close);
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("is named by its h2 title and described by its description", () => {
    render(<Suspend />, strict);
    const { dialog } = open();
    const title = within(dialog).getByRole("heading", { level: 2, name: "Suspend member" });
    expect(title.className).toContain("text-lg");
    expect(title.className).toContain("font-semibold");
    expect(dialog).toHaveAccessibleDescription("Say why, so the committee can see it.");
  });

  it("is a bottom sheet below sm and a centred max-w-md card above, on the modal and overlay layers", () => {
    render(<Suspend />, strict);
    const { dialog } = open();
    expect(dialog.className).toContain("z-modal");
    expect(dialog.className).toContain("bg-bg-raised");
    expect(dialog.className).toContain("shadow-lg");
    expect(dialog.className).toMatch(/(^| )bottom-0( |$)/);
    expect(dialog.className).toContain("rounded-t-2xl");
    expect(dialog.className).toContain("animate-sheet-up");
    expect(dialog.className).toContain("sm:max-w-md");
    expect(dialog.className).toContain("sm:animate-pop-in");
    expect(dialog.className).toContain("motion-reduce:animate-none");
    expect(overlay().className).toContain("z-overlay");
    expect(overlay().className).toContain("bg-overlay");
  });

  it("closes on Escape and gives focus back to the control that opened it", async () => {
    const onOpenChange = vi.fn();
    render(<Suspend onOpenChange={onOpenChange} />, strict);
    const { trigger } = open();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("takes focus inside on open and traps Tab at both edges", () => {
    render(<Suspend />, strict);
    const { dialog } = open();
    const reason = within(dialog).getByRole("textbox", { name: "Reason" });
    const close = within(dialog).getByRole("button", { name: "Close Suspend member" });
    expect(document.activeElement).toBe(reason);
    act(() => close.focus());
    fireEvent.keyDown(close, { key: "Tab" });
    expect(document.activeElement).toBe(reason);
    fireEvent.keyDown(reason, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(close);
  });

  it("honours initialFocus", () => {
    render(<Suspend focusSuspend />, strict);
    const { dialog } = open();
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Suspend" }));
  });

  it("closes on an outside click while nothing has been typed", async () => {
    render(<Suspend />, strict);
    open();
    await settle();
    clickScrim();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("stays open after typing, and says so politely — every time", async () => {
    render(<Suspend />, strict);
    const { dialog } = open();
    await settle();
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Reason" }), { target: { value: "Unpaid" } });
    clickScrim();
    const still = screen.getByRole("dialog", { name: "Suspend member" });
    const region = still.querySelector('[aria-live="polite"]');
    expect(region).toHaveTextContent(DIALOG_KEPT_OPEN);
    const first = region?.firstElementChild;
    clickScrim();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    // A fresh node each time, so the second refusal is announced as well.
    expect(region?.firstElementChild).not.toBe(first);
    expect(region).toHaveTextContent(DIALOG_KEPT_OPEN);
    // Escape is deliberate, so it still closes.
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("lets an outside click close a typed-into dialog when guardTyped is off", async () => {
    render(<Suspend guardTyped={false} />, strict);
    const { dialog } = open();
    await settle();
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Reason" }), { target: { value: "x" } });
    clickScrim();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("orders the footer primary-last in source AND on screen: at the foot on a phone, on the right on desktop (F4-8)", () => {
    render(<Suspend />, strict);
    const { dialog } = open();
    const footer = dialog.querySelector<HTMLElement>('[data-slot="dialog-footer"]');
    // Never reversed: Tab must run in the order the buttons are painted.
    expect(footer?.className).not.toContain("reverse");
    expect(footer?.className).toMatch(/(^| )flex-col( |$)/);
    expect(footer?.className).toContain("gap-2");
    expect(footer?.className).toContain("sm:flex-row");
    expect(footer?.className).toContain("sm:justify-end");
    const names = within(footer as HTMLElement).getAllByRole("button").map((b) => b.textContent);
    expect(names).toEqual(["Cancel", "Suspend"]);
  });
});

describe("Sheet", () => {
  function Filter({ side }: { side?: "bottom" | "right" }) {
    return (
      <Sheet>
        <SheetTrigger>Filters</SheetTrigger>
        <SheetContent side={side} aria-describedby={undefined}>
          <SheetTitle>Filter the list</SheetTitle>
          <button type="button">Apply</button>
        </SheetContent>
      </Sheet>
    );
  }

  it("opens from the bottom by default, with the same close button, which closes it", async () => {
    render(<Filter />, strict);
    const trigger = screen.getByRole("button", { name: "Filters" });
    fireEvent.click(trigger);
    const sheet = screen.getByRole("dialog", { name: "Filter the list" });
    expect(sheet).toHaveAttribute("data-side", "bottom");
    expect(sheet.className).toContain("animate-sheet-up");
    fireEvent.click(within(sheet).getByRole("button", { name: "Close Filter the list" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("can sit on the right and still closes on Escape", () => {
    render(<Filter side="right" />, strict);
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    const sheet = screen.getByRole("dialog", { name: "Filter the list" });
    expect(sheet).toHaveAttribute("data-side", "right");
    expect(sheet.className).toContain("right-0");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("R9 X9-3 — focus moved within a dialog is scrolled into view", () => {
  it("scrolls the control focus moves to from inside (Tab's wrap), never the open's own autofocus", async () => {
    const seen: string[] = [];
    const spy = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (this: HTMLElement) {
      seen.push(this.textContent ?? "");
    });
    try {
      render(<Suspend />, strict);
      fireEvent.click(screen.getByRole("button", { name: "Suspend Sam" }));
      const dialog = await screen.findByRole("dialog");
      await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
      // Opening put focus inside from outside: left where Radix put it, the sheet opens at its top.
      expect(seen).toEqual([]);
      const close = within(dialog).getByRole("button", { name: /^Close/ });
      act(() => close.focus());
      const first = within(dialog).getByRole("textbox", { name: "Reason" });
      // Radix's wrap focuses with preventScroll; the surface reveals it.
      act(() => first.focus({ preventScroll: true }));
      expect(spy).toHaveBeenCalled();
      expect(spy.mock.contexts.at(-1)).toBe(first);
      expect(spy.mock.calls.at(-1)?.[0]).toEqual({ block: "nearest", inline: "nearest" });
    } finally {
      spy.mockRestore();
    }
  });
});
