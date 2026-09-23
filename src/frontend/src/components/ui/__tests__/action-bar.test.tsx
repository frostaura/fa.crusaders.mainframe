import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { ActionBar, ActionBarItem } from "../action-bar";

const strict = { reactStrictMode: true };

describe("ActionBar", () => {
  it("is a named toolbar with the count, the detail line, an exit and the actions", () => {
    const onClose = vi.fn();
    render(
      <ActionBar count={3} detail="Tue 23 Sep · 18:00–19:30" onClose={onClose}>
        <ActionBarItem asChild><button type="button">Book 3</button></ActionBarItem>
      </ActionBar>,
      strict,
    );
    const toolbar = screen.getByRole("toolbar", { name: "Selection" });
    expect(within(toolbar).getByText("3 selected")).toBeInTheDocument();
    expect(within(toolbar).getByText("Tue 23 Sep · 18:00–19:30")).toBeInTheDocument();
    expect(within(toolbar).getByRole("button", { name: "Book 3" })).toBeInTheDocument();
    fireEvent.click(within(toolbar).getByRole("button", { name: "Clear selection" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("announces the count politely, outside the toolbar, and follows it", () => {
    const { rerender } = render(<ActionBar count={1} onClose={() => {}} />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("1 selected");
    expect(screen.getByRole("toolbar").contains(status)).toBe(false);
    rerender(<ActionBar count={4} onClose={() => {}} />);
    expect(screen.getByRole("status")).toHaveTextContent("4 selected");
  });

  it("uses the caller's words for the count when given", () => {
    render(<ActionBar count={2} countLabel="2 slots selected" onClose={() => {}} />);
    expect(screen.getByRole("status")).toHaveTextContent("2 slots selected");
  });

  it("exits on Escape from anywhere inside it", () => {
    const onClose = vi.fn();
    render(
      <ActionBar count={2} onClose={onClose}>
        <ActionBarItem asChild><button type="button">Cancel 2</button></ActionBarItem>
      </ActionBar>,
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "Cancel 2" }), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("floats above the tab bar and the home indicator, animates in, and stands still under reduced motion", () => {
    render(<ActionBar count={1} onClose={() => {}} />);
    const shell = document.querySelector<HTMLElement>("[data-action-bar]")!;
    expect(shell.className).toContain("fixed");
    expect(shell.className).toContain("z-actionbar");
    expect(shell.className).toContain("--app-bottom-bar-height");
    expect(shell.className).toContain("safe-area-inset-bottom");
    const toolbar = screen.getByRole("toolbar");
    expect(toolbar.className).toContain("max-w-screen-sm");
    expect(toolbar.className).toContain("animate-sheet-up");
    expect(toolbar.className).toContain("motion-reduce:animate-none");
  });

  it("gives the exit a 44px target", () => {
    render(<ActionBar count={1} onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "Clear selection" }).className).toContain("size-touch");
  });
});
