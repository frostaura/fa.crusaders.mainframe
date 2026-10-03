import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Button } from "../button";
import { buttonVariants } from "../button-variants";
import { Dialog, DialogBody, DialogContent, DialogTitle } from "../dialog";

/**
 * R11 L11-2 / L11-4 / L11-5 / L11-6 / L10-1 — one root: buttons that could not wrap.
 *
 * <p>
 * The Button was `whitespace-nowrap` unless `block`, so at 320 px with 200 % text every label
 * wider than its column ran past the gutter ("Create a group", "Try again now", "Invite a
 * player"), and a wrapping label in the column-flex DialogBody was shrunk to its 44 px floor while
 * the two-line text spilled out ("Take minutes back instead"). The geometry itself is held by
 * `e2e/overflow-200.spec.ts`; this file pins the primitive's contract, since jsdom lays nothing out.
 * </p>
 */
describe("Button wraps instead of overflowing (R11)", () => {
  it("never forces one line, is capped at its container, and balances a wrapped label", () => {
    for (const size of ["sm", "md", "lg"] as const) {
      const classes = buttonVariants({ size }).split(/\s+/);
      expect(classes).not.toContain("whitespace-nowrap");
      expect(classes).toEqual(expect.arrayContaining(["max-w-full", "text-balance", "text-center"]));
      // Heights stay floors (min-h-*), never a fixed h-* that would cut a second line.
      expect(classes.some((c) => /^h-/.test(c))).toBe(false);
    }
  });

  it("an icon-only size keeps its fixed square", () => {
    expect(buttonVariants({ size: "icon" })).toContain("size-touch");
    expect(buttonVariants({ size: "icon-sm" })).toContain("size-9");
  });

  it("glues a figure to its unit so a wrap never leaves '15' on one line and 'minutes' on the next", () => {
    render(<Button>Book · 15 minutes</Button>);
    const button = screen.getByRole("button", { name: "Book · 15 minutes" });
    const label = button.querySelector("[data-slot=button-label]")!;
    expect(label.textContent).toBe("Book · 15 minutes");
    expect(button.querySelector("[data-label]")).toHaveAttribute("data-label", "Book · 15 minutes");
    // A label with no figure is untouched and carries no aria-label of its own.
    render(<Button>Create a group</Button>);
    expect(screen.getByRole("button", { name: "Create a group" })).not.toHaveAttribute("aria-label");
  });
});

describe("DialogBody keeps its rows whole (R11 L11-2)", () => {
  it("no child shrinks below its content in the column-flex scroller — the body scrolls instead", () => {
    render(
      <Dialog open>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Adjust minutes</DialogTitle>
          <DialogBody className="flex flex-col gap-4">
            <Button>Take minutes back instead</Button>
          </DialogBody>
        </DialogContent>
      </Dialog>,
    );
    const body = document.querySelector("[data-slot=dialog-body]")!;
    expect(body.className.split(/\s+/)).toContain("[&>*]:shrink-0");
  });
});
