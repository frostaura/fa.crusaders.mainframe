import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SlotList, type SlotLine } from "../SheetParts";

const LINE: SlotLine = {
  key: "c1@2030-01-01T10:00:00Z", courtName: "Court 1 — the glass-back show court", day: "Tue 1 Jan", time: "10:00–10:30",
  minutes: 30, price: 30,
};

describe("the Book sheet's slot row (R7)", () => {
  it("L7-4 — the court's name is never cut to an ellipsis; it wraps, and the figure drops under it", () => {
    render(<SlotList lines={[LINE]} label="Slots" refusedWord="Refused" />);
    const name = screen.getByText(LINE.courtName);
    expect(name.className).not.toMatch(/\btruncate\b/);
    expect(name.className).toMatch(/break-words/);
    // The row wraps, and the figure keeps to the right edge of whichever line it lands on.
    expect(name.parentElement!.className).toMatch(/flex-wrap/);
  });

  it("X7-6 — the slot's length is a figure with its spoken twin: a screen reader hears minutes, never \"min\"", () => {
    render(<SlotList lines={[LINE]} label="Slots" refusedWord="Refused" />);
    const row = screen.getByRole("listitem");
    // The price and the length both say "30 minutes" to a screen reader.
    expect(within(row).getAllByText("30 minutes", { selector: ".sr-only" })).toHaveLength(2);
    for (const el of within(row).getAllByText("30 min")) expect(el).toHaveAttribute("aria-hidden", "true");
  });
});
