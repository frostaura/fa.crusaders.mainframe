import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../tabs";
import { Toggle } from "../toggle";
import { ToggleGroup, ToggleGroupItem } from "../toggle-group";

const strict = { reactStrictMode: true };

describe("Toggle", () => {
  it("is a pressed-state button, 44px, no-lift, soft accent when on", () => {
    render(<Toggle aria-label="Only mine">Mine</Toggle>, strict);
    const toggle = screen.getByRole("button", { name: "Only mine" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle.className).toContain("min-h-touch");
    expect(toggle.className).toContain("no-lift");
    expect(toggle.className).toContain("data-[state=on]:bg-accent-soft");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
  });
});

describe("ToggleGroup", () => {
  function Days({ onValueChange }: { onValueChange?: (v: string) => void }) {
    return (
      <ToggleGroup type="single" aria-label="Day" defaultValue="mon" variant="outline" onValueChange={onValueChange}>
        <ToggleGroupItem value="mon">Mon</ToggleGroupItem>
        <ToggleGroupItem value="tue">Tue</ToggleGroupItem>
        <ToggleGroupItem value="wed">Wed</ToggleGroupItem>
      </ToggleGroup>
    );
  }

  it("single: items are radios in a radiogroup, sharing the group's variant", () => {
    render(<Days />, strict);
    expect(screen.getByRole("radiogroup", { name: "Day" })).toBeTruthy();
    const mon = screen.getByRole("radio", { name: "Mon" });
    expect(mon).toHaveAttribute("aria-checked", "true");
    expect(mon.className).toContain("border-control");
    expect(mon.className).toContain("no-lift");
  });

  // Radix roving focus moves focus in a setTimeout after the keydown, hence waitFor.
  // F4-11 — a single group is a radio group: the arrow keys move the SELECTION with the focus.
  it("single: arrow keys move focus AND select, like any radio group; clicking selects too", async () => {
    const onValueChange = vi.fn();
    render(<Days onValueChange={onValueChange} />, strict);
    const mon = screen.getByRole("radio", { name: "Mon" });
    mon.focus();
    fireEvent.keyDown(mon, { key: "ArrowRight" });
    const tue = screen.getByRole("radio", { name: "Tue" });
    await waitFor(() => expect(document.activeElement).toBe(tue));
    await waitFor(() => expect(tue).toHaveAttribute("aria-checked", "true"));
    expect(onValueChange).toHaveBeenLastCalledWith("tue");
    expect(mon).toHaveAttribute("aria-checked", "false");
    fireEvent.keyDown(tue, { key: "End" });
    const wed = screen.getByRole("radio", { name: "Wed" });
    await waitFor(() => expect(wed).toHaveAttribute("aria-checked", "true"));
    fireEvent.click(mon);
    expect(onValueChange).toHaveBeenLastCalledWith("mon");
  });

  it("multiple: arrows only move focus — each item is an independent toggle", async () => {
    const onValueChange = vi.fn();
    render(
      <ToggleGroup type="multiple" aria-label="Days" onValueChange={onValueChange}>
        <ToggleGroupItem value="mon">Mon</ToggleGroupItem>
        <ToggleGroupItem value="tue">Tue</ToggleGroupItem>
      </ToggleGroup>,
      strict,
    );
    const mon = screen.getByRole("button", { name: "Mon" });
    mon.focus();
    fireEvent.keyDown(mon, { key: "ArrowRight" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Tue" })));
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("an 'on' item is restated in system colours for forced-colours mode (F4-5)", () => {
    render(<Days />, strict);
    expect(screen.getByRole("radio", { name: "Mon" }).className).toContain("forced-colors:data-[state=on]:bg-[Highlight]");
  });
});

describe("Tabs", () => {
  function Sections({ variant }: { variant?: "segmented" | "underline" }) {
    return (
      <Tabs defaultValue="overview" variant={variant}>
        <TabsList aria-label="Member">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="wallet">Wallet</TabsTrigger>
          <TabsTrigger value="doors">Doors</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">Overview body</TabsContent>
        <TabsContent value="wallet">Wallet body</TabsContent>
        <TabsContent value="doors">Doors body</TabsContent>
      </Tabs>
    );
  }

  it("segmented (default): a named tablist of 44px no-lift tabs, active one lifted to the surface", () => {
    render(<Sections />, strict);
    expect(screen.getByRole("tablist", { name: "Member" }).className).toContain("bg-bg-muted");
    const tab = screen.getByRole("tab", { name: "Overview" });
    expect(tab).toHaveAttribute("aria-selected", "true");
    expect(tab.className).toContain("min-h-touch");
    expect(tab.className).toContain("no-lift");
    expect(tab.className).toContain("data-[state=active]:bg-bg-surface");
    // F4-5 — the lifted surface is discarded in forced colours; the active tab takes Highlight.
    expect(tab.className).toContain("forced-colors:data-[state=active]:bg-[Highlight]");
    expect(screen.getByRole("tabpanel", { name: "Overview" })).toHaveTextContent("Overview body");
  });

  it("underline: a hairline list with an accent bar under the active tab", () => {
    render(<Sections variant="underline" />, strict);
    expect(screen.getByRole("tablist", { name: "Member" }).className).toContain("border-b");
    expect(screen.getByRole("tab", { name: "Wallet" }).className).toContain("data-[state=active]:after:bg-accent-strong");
  });

  it("arrow keys move focus and activate (automatic activation)", async () => {
    render(<Sections />, strict);
    const overview = screen.getByRole("tab", { name: "Overview" });
    overview.focus();
    fireEvent.keyDown(overview, { key: "ArrowRight" });
    const wallet = screen.getByRole("tab", { name: "Wallet" });
    await waitFor(() => expect(document.activeElement).toBe(wallet));
    expect(wallet).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Wallet" })).toHaveTextContent("Wallet body");
    fireEvent.keyDown(wallet, { key: "End" });
    await waitFor(() => expect(screen.getByRole("tab", { name: "Doors" })).toHaveAttribute("aria-selected", "true"));
  });

  it("a pointer press activates", () => {
    render(<Sections />, strict);
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Doors" }), { button: 0, ctrlKey: false });
    expect(screen.getByRole("tab", { name: "Doors" })).toHaveAttribute("aria-selected", "true");
  });
});
