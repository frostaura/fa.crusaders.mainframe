import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ToggleGroup, ToggleGroupItem } from "../toggle-group";
import { Tabs, TabsList, TabsTrigger } from "../tabs";

/**
 * R17 (CI e2e 3/5 class) — a control wraps at 200 % text, and a wrap must never leave a figure at
 * the end of one line and its unit on the next ("6 / Sep", "+15 / minutes"). Button glued its own
 * plain-text label since R11; a toggle-group item and a tab trigger did not — the desk's "+15
 * minutes" quick amounts and any tab whose label carries a figure. Paint gets a no-break space;
 * the accessible name keeps the plain spelling. Varied: a label with figures and one without.
 */
const NBSP = " ";

describe("R17 — toggle items and tab triggers keep a figure with its unit", () => {
  it("a toggle-group item: '+15 minutes' painted whole, named plainly", () => {
    render(
      <ToggleGroup type="single" aria-label="Amount">
        <ToggleGroupItem value="15">+15 minutes</ToggleGroupItem>
        <ToggleGroupItem value="custom">Other amount</ToggleGroupItem>
      </ToggleGroup>,
    );
    const item = screen.getByRole("radio", { name: "+15 minutes" });
    expect(item.textContent).toBe(`+15${NBSP}minutes`);
    const plain = screen.getByRole("radio", { name: "Other amount" });
    expect(plain.textContent).toBe("Other amount");
    expect(plain).not.toHaveAttribute("aria-label");
  });

  it("a tab trigger: 'Last 7 days' painted whole, named plainly", () => {
    render(
      <Tabs defaultValue="week">
        <TabsList aria-label="Range">
          <TabsTrigger value="week">Last 7 days</TabsTrigger>
          <TabsTrigger value="all">All time</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    const tab = screen.getByRole("tab", { name: "Last 7 days" });
    expect(tab.textContent).toContain(`7${NBSP}days`);
    expect(screen.getByRole("tab", { name: "All time" })).not.toHaveAttribute("aria-label");
  });
});
