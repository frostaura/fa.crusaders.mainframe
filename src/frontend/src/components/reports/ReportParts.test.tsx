import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { NetMinutes, ReportSkeleton, Stat, StatTiles } from "./ReportParts";
import { Minutes } from "../Minutes";

/**
 * R5 X5-4: the headline tiles were a fixed `grid-cols-2 sm:grid-cols-4`, and at 390 with 200 %
 * text each tile was ~150px, so `break-words` cut the money inside the figure ("R2 / 50. / 50").
 * They are an AutoGrid of 9rem tiles now (one column at 200 % text on a phone), and a figure
 * never breaks inside a word. The real widths are measured in `e2e/ledger-r5.spec.ts`.
 */
describe("StatTiles", () => {
  const tiles = [
    { label: "Rand received", value: "R125050.50", tone: "accent" as const },
    { label: "Minutes sold", value: <Minutes value={98765} />, tone: "success" as const },
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

/**
 * P13 — a minutes figure on the reports is whole minutes in the app's one format, and a screen
 * reader hears it in words ("1 hour 30 minutes"), never "h" or "min".
 */
describe("minutes on the report parts", () => {
  it("puts a minutes figure in a tile and a totals stat with its spoken form", () => {
    render(<StatTiles tiles={[{ label: "Minutes sold", value: <Minutes value={90} />, tone: "success" }]} label="Glance" />);
    const dd = screen.getByLabelText("Glance").querySelector("dd")!;
    expect(dd).toHaveTextContent("1 h 30 min");
    expect(dd.querySelector(".sr-only")).toHaveTextContent("1 hour 30 minutes");
    render(<dl><Stat label="Sold" value={<Minutes value={-45} signed />} /></dl>);
    expect(screen.getByText("Sold").closest("dt")!.nextElementSibling).toHaveTextContent("−45 min");
  });

  it("marks a negative net day in the warning ink, not the danger ink, and keeps the sign", () => {
    const { container } = render(<NetMinutes value={-90} />);
    const span = container.firstElementChild as HTMLElement;
    expect(span).toHaveTextContent("−1 h 30 min");
    expect(span.className).toContain("text-warning-strong");
    // The netting working is "look at this day", not an error.
    expect(span.className).not.toContain("text-danger-strong");
    expect(span.className).toContain("whitespace-nowrap");
  });

  it("leaves a positive or zero day in the body ink, unsigned like every other figure", () => {
    const { container } = render(<><NetMinutes value={0} /><NetMinutes value={45} /></>);
    const [zero, positive] = Array.from(container.children) as HTMLElement[];
    expect(zero).toHaveTextContent("0 min");
    expect(positive).toHaveTextContent("45 min");
    expect(positive.className).not.toMatch(/text-(warning|danger)-strong/);
  });
});
