import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Button, buttonVariants } from "../button";
import { Plus } from "../icons";

const strict = { reactStrictMode: true };

describe("Button", () => {
  it("is a button named by its label, primary/md by default, with no outline-none or ring classes", () => {
    render(<Button>Book court</Button>, strict);
    const button = screen.getByRole("button", { name: "Book court" });
    expect(button.className).toContain("bg-primary");
    expect(button.className).toContain("text-primary-ink");
    expect(button.className).toContain("h-touch");
    expect(button.className).toContain("border-transparent");
    expect(button.className).not.toMatch(/outline-none|focus-visible:ring/);
  });

  it("offers exactly the six variants and six sizes the spec names — no link variant", () => {
    for (const variant of ["primary", "secondary", "outline", "ghost", "danger", "danger-soft"] as const) {
      expect(buttonVariants({ variant })).toBeTruthy();
    }
    expect(buttonVariants({ variant: "danger" })).toContain("bg-danger-solid");
    expect(buttonVariants({ variant: "outline" })).toContain("border-control");
    expect(buttonVariants({ size: "sm" })).toContain("after:-inset-y-[5px]");
    expect(buttonVariants({ size: "icon" })).toContain("size-touch");
    expect(buttonVariants({ size: "lg" })).toContain("h-[52px]");
    expect(buttonVariants({ block: true })).toContain("w-full");
    // @ts-expect-error — there is no link variant, by design.
    expect(buttonVariants({ variant: "link" })).not.toContain("underline");
  });

  it("calls onClick when not pending", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>, strict);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("while pending: aria-busy + aria-disabled, NOT disabled, label kept once, spinner shown, clicks ignored", () => {
    const onClick = vi.fn();
    render(<Button pending onClick={onClick} icon={<Plus data-testid="lead" />}>Save changes</Button>, strict);
    const button = screen.getByRole("button", { name: "Save changes" });
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toBeDisabled();
    const working = button.querySelector("[data-slot=button-pending]") as HTMLElement;
    expect(working).toHaveAttribute("aria-hidden", "true");
    expect(working.className).not.toContain("opacity-0");
    // The label is in the DOM once (the working layer sizes itself with a CSS attr() box).
    expect(screen.getAllByText("Save changes")).toHaveLength(1);
    expect(working.querySelector("[data-label]")).toHaveAttribute("data-label", "Save changes");
    expect(working.querySelector("[data-slot=spinner]")).not.toBeNull();
    // The resting layer (with the leading icon) fades out but stays in the accessibility tree.
    expect(screen.getByTestId("lead").parentElement?.className).toContain("opacity-0");
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("keeps focus while it becomes pending (aria-disabled, not disabled)", () => {
    const { rerender } = render(<Button>Pay</Button>, strict);
    const button = screen.getByRole("button", { name: "Pay" });
    button.focus();
    rerender(<Button pending>Pay</Button>);
    expect(document.activeElement).toBe(button);
  });

  it("does not submit its form while pending", () => {
    const onSubmit = vi.fn((event: Event) => event.preventDefault());
    render(
      <form onSubmit={(e) => onSubmit(e.nativeEvent)}>
        <Button type="submit" pending>Send</Button>
      </form>,
      strict,
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("stacks both layers in one grid cell so the width is locked (the spinner always occupies its slot)", () => {
    render(<Button>Top up</Button>, strict);
    const button = screen.getByRole("button", { name: "Top up" });
    const grid = button.firstElementChild as HTMLElement;
    expect(grid.className).toContain("inline-grid");
    const layers = Array.from(grid.children) as HTMLElement[];
    expect(layers).toHaveLength(2);
    for (const layer of layers) expect(layer.className).toContain("col-start-1 row-start-1");
    expect(layers[1].querySelector("[data-slot=spinner]")).not.toBeNull();
    expect(layers[1].className).toContain("opacity-0");
    expect(button).not.toHaveAttribute("aria-busy");
  });

  it("a markup label is cloned into the working layer only as aria-hidden, so the name is said once", () => {
    render(<Button pending>Book <strong>8 cr</strong></Button>, strict);
    expect(screen.getByRole("button", { name: "Book 8 cr" })).toHaveAttribute("aria-busy", "true");
  });

  it("asChild renders the child link with the button's look and no nested button", () => {
    render(<Button asChild variant="outline"><a href="/wallet">Go to wallet</a></Button>, strict);
    const link = screen.getByRole("link", { name: "Go to wallet" });
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("href", "/wallet");
    expect(link.className).toContain("border-control");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
