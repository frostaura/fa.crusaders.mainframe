import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Checkbox } from "../checkbox";
import { Field, FieldError, FieldLabel } from "../field";
import { RadioCard, RadioGroup, RadioGroupItem } from "../radio-group";
import { Switch } from "../switch";

const strict = { reactStrictMode: true };

describe("Checkbox", () => {
  it("is a named native-button checkbox, 20px with a 2px control edge, no-lift, and toggles on click", () => {
    const onCheckedChange = vi.fn();
    render(<Checkbox aria-label="Remember me" onCheckedChange={onCheckedChange} />, strict);
    const box = screen.getByRole("checkbox", { name: "Remember me" });
    expect(box.tagName).toBe("BUTTON");
    expect(box).toHaveAttribute("type", "button");
    expect(box).toHaveAttribute("aria-checked", "false");
    expect(box.className).toMatch(/\bsize-5\b/);
    expect(box.className).toContain("border-2 border-control");
    expect(box.className).toContain("rounded-sm");
    expect(box.className).toContain("no-lift");
    fireEvent.click(box);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
    expect(box).toHaveAttribute("aria-checked", "true");
  });

  it("keyboard: Space is left to the native button (activation), Enter is swallowed (WAI-ARIA)", () => {
    render(<Checkbox aria-label="Agree" />, strict);
    const box = screen.getByRole("checkbox", { name: "Agree" });
    // fireEvent returns false when the handler called preventDefault.
    expect(fireEvent.keyDown(box, { key: "Enter" })).toBe(false);
    expect(fireEvent.keyDown(box, { key: " " })).toBe(true);
    expect(box).toHaveAttribute("aria-checked", "false");
  });

  it("indeterminate reads as mixed", () => {
    render(<Checkbox aria-label="All" checked="indeterminate" />, strict);
    expect(screen.getByRole("checkbox", { name: "All" })).toHaveAttribute("aria-checked", "mixed");
  });

  it("takes its label and invalid state from a Field", () => {
    render(<Field><FieldLabel>Accept terms</FieldLabel><Checkbox /><FieldError>Required.</FieldError></Field>, strict);
    const box = screen.getByRole("checkbox", { name: "Accept terms" });
    expect(box).toHaveAttribute("aria-invalid", "true");
    expect(box).toHaveAccessibleDescription("Required.");
  });
});

describe("Switch", () => {
  it("is a named 44×26 no-lift switch that flips on click", () => {
    const onCheckedChange = vi.fn();
    render(<Switch aria-label="Email me" onCheckedChange={onCheckedChange} />, strict);
    const sw = screen.getByRole("switch", { name: "Email me" });
    expect(sw.tagName).toBe("BUTTON");
    expect(sw.className).toContain("w-11");
    expect(sw.className).toContain("h-[26px]");
    expect(sw.className).toContain("no-lift");
    expect(sw.className).toContain("border-transparent");
    expect(sw).toHaveAttribute("aria-checked", "false");
    fireEvent.click(sw);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
    expect(sw).toHaveAttribute("aria-checked", "true");
  });

  it("keyboard: neither Space nor Enter is swallowed, so the native button activates on both", () => {
    render(<Switch aria-label="Dark" />, strict);
    const sw = screen.getByRole("switch", { name: "Dark" });
    expect(fireEvent.keyDown(sw, { key: "Enter" })).toBe(true);
    expect(fireEvent.keyDown(sw, { key: " " })).toBe(true);
  });

  it("takes its label from a Field", () => {
    render(<Field><FieldLabel>Notify admins</FieldLabel><Switch /></Field>, strict);
    expect(screen.getByRole("switch", { name: "Notify admins" })).toBeTruthy();
  });
});

describe("RadioGroup", () => {
  function Plan({ onValueChange }: { onValueChange?: (v: string) => void }) {
    return (
      <RadioGroup aria-label="Plan" defaultValue="a" onValueChange={onValueChange}>
        <label><RadioGroupItem value="a" /> Morning</label>
        <label><RadioGroupItem value="b" /> Evening</label>
        <label><RadioGroupItem value="c" /> Weekend</label>
      </RadioGroup>
    );
  }

  it("is a named radiogroup of no-lift radios", () => {
    render(<Plan />, strict);
    expect(screen.getByRole("radiogroup", { name: "Plan" })).toBeTruthy();
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    for (const radio of radios) expect(radio.className).toContain("no-lift");
    expect(screen.getByRole("radio", { name: "Morning" })).toHaveAttribute("aria-checked", "true");
  });

  // Radix roving focus moves focus in a setTimeout after the keydown, hence waitFor.
  it("arrow keys move focus and select", async () => {
    const onValueChange = vi.fn();
    render(<Plan onValueChange={onValueChange} />, strict);
    const morning = screen.getByRole("radio", { name: "Morning" });
    morning.focus();
    fireEvent.keyDown(morning, { key: "ArrowDown" });
    const evening = screen.getByRole("radio", { name: "Evening" });
    await waitFor(() => expect(document.activeElement).toBe(evening));
    await waitFor(() => expect(evening).toHaveAttribute("aria-checked", "true"));
    expect(onValueChange).toHaveBeenLastCalledWith("b");
    fireEvent.keyUp(evening, { key: "ArrowDown" });
    fireEvent.keyDown(evening, { key: "ArrowUp" });
    await waitFor(() => expect(document.activeElement).toBe(morning));
    await waitFor(() => expect(morning).toHaveAttribute("aria-checked", "true"));
  });
});

describe("RadioCard", () => {
  it("is named by its title only and described by its description; selecting it fills and edges it", () => {
    render(
      <RadioGroup aria-label="Book as">
        <RadioCard value="me" title="Myself" description="Charged to your wallet." />
        <RadioCard value="member" title="A member" description="Charged to them." />
      </RadioGroup>,
      strict,
    );
    const card = screen.getByRole("radio", { name: "A member" });
    expect(card).toHaveAccessibleDescription("Charged to them.");
    expect(card.className).toContain("min-h-touch");
    expect(card.className).toContain("no-lift");
    expect(card.className).toContain("data-[state=checked]:border-accent-strong");
    fireEvent.click(card);
    expect(card).toHaveAttribute("aria-checked", "true");
    expect(card).toHaveAttribute("data-state", "checked");
  });
});
