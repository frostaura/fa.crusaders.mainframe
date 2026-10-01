import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ReportSkeleton, StatTiles } from "./ReportParts";

/**
 * R5 X5-4: the headline tiles were a fixed `grid-cols-2 sm:grid-cols-4`, and at 390 with 200 %
 * text each tile was ~150px, so `break-words` cut the money inside the figure ("R2 / 50. / 50").
 * They are an AutoGrid of 9rem tiles now (one column at 200 % text on a phone), and a figure
 * never breaks inside a word. The real widths are measured in `e2e/ledger-r5.spec.ts`.
 */
describe("StatTiles", () => {
  const tiles = [
    { label: "Top-ups", value: "125050.50 cr", tone: "success" as const },
    { label: "Spent", value: "98765.25 cr", tone: "accent" as const },
  ];

  it("lays the tiles out by the box (AutoGrid), not by two fixed columns", () => {
    render(<StatTiles tiles={tiles} label="This period at a glance" />);
    const list = screen.getByLabelText("This period at a glance");
    expect(list.tagName).toBe("DL");
    expect(list).toHaveAttribute("data-auto-grid", "stat");
    expect(list.className).not.toMatch(/grid-cols-2/);
    expect(list.style.gridTemplateColumns).toContain("9rem");
  });

  it("never breaks a figure inside its number", () => {
    render(<StatTiles tiles={tiles} label="This period at a glance" />);
    for (const dd of screen.getByLabelText("This period at a glance").querySelectorAll("dd")) {
      expect(dd.className).not.toMatch(/break-words|break-all/);
    }
  });

  it("holds the same grid while it is read", () => {
    const { container } = render(<ReportSkeleton />);
    const grid = container.querySelector("[data-auto-grid]") as HTMLElement;
    expect(grid).toHaveAttribute("data-auto-grid", "stat");
    expect(grid.children).toHaveLength(4);
    expect(container.innerHTML).not.toMatch(/grid-cols-2/);
  });
});
