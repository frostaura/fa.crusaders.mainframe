import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { IconButton } from "../icon-button";
import { ArrowsClockwise } from "../icons";

const strict = { reactStrictMode: true };

describe("IconButton", () => {
  it("is named by its label, 44px ghost by default, with the icon hidden inside", () => {
    render(<IconButton label="Refresh"><ArrowsClockwise data-testid="glyph" /></IconButton>, strict);
    const button = screen.getByRole("button", { name: "Refresh" });
    expect(button).toHaveAttribute("aria-label", "Refresh");
    expect(button.className).toContain("size-touch");
    expect(button.className).toContain("bg-transparent");
    expect(button).toContainElement(screen.getByTestId("glyph"));
  });

  it("shows the label as a tooltip on keyboard focus", () => {
    render(<IconButton label="Select slots"><ArrowsClockwise /></IconButton>, strict);
    fireEvent.focus(screen.getByRole("button", { name: "Select slots" }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Select slots");
  });

  it("pending: the spinner replaces the icon, name and focus kept, clicks ignored", () => {
    const onClick = vi.fn();
    render(<IconButton label="Refresh" pending onClick={onClick}><ArrowsClockwise data-testid="glyph" /></IconButton>, strict);
    const button = screen.getByRole("button", { name: "Refresh" });
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).not.toBeDisabled();
    expect(screen.getByTestId("glyph").parentElement?.className).toContain("opacity-0");
    expect(button.querySelector("[data-slot=button-pending] [data-slot=spinner]")).not.toBeNull();
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("passes size and variant through", () => {
    render(<IconButton label="Close" size="icon-sm" variant="outline"><ArrowsClockwise /></IconButton>, strict);
    const button = screen.getByRole("button", { name: "Close" });
    expect(button.className).toContain("size-9");
    expect(button.className).toContain("border-control");
  });
});
