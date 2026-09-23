import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Field, FieldDescription, FieldLabel } from "../field";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "../select";

function Court({ onValueChange }: { onValueChange?: (value: string) => void }) {
  return (
    <Field>
      <FieldLabel>Court</FieldLabel>
      <Select onValueChange={onValueChange}>
        <SelectTrigger>
          <SelectValue placeholder="Choose a court" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>Glass back</SelectLabel>
            <SelectItem value="a">Court A</SelectItem>
            <SelectItem value="b">Court B</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
      <FieldDescription>Where you will play.</FieldDescription>
    </Field>
  );
}

const open = (trigger: HTMLElement) => fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });

describe("Select", () => {
  it("is a combobox labelled and described by its Field, showing the placeholder", () => {
    render(<Court />, { reactStrictMode: true });
    const trigger = screen.getByRole("combobox", { name: "Court" });
    expect(trigger).toHaveAccessibleDescription("Where you will play.");
    expect(trigger).toHaveTextContent("Choose a court");
    expect(trigger.className).toContain("border-control");
    expect(trigger.className).toContain("h-touch");
    // `:read-only` matches every <button>; a read-only fill on the trigger would paint it muted forever.
    expect(trigger.className).not.toContain("read-only:");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("opens on pointerdown into a raised popover-level listbox of 44px no-lift options, and selects", () => {
    const onValueChange = vi.fn();
    render(<Court onValueChange={onValueChange} />, { reactStrictMode: true });
    const trigger = screen.getByRole("combobox", { name: "Court" });
    open(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const listbox = screen.getByRole("listbox");
    expect(listbox.className).toContain("z-popover");
    expect(listbox.className).toContain("bg-bg-raised");
    const option = screen.getByRole("option", { name: "Court B" });
    expect(option.className).toContain("min-h-touch");
    expect(option.className).toContain("no-lift");
    fireEvent.click(option);
    expect(onValueChange).toHaveBeenCalledWith("b");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("combobox", { name: "Court" })).toHaveTextContent("Court B");
  });

  it("selects with the keyboard: Enter on a highlighted option", () => {
    const onValueChange = vi.fn();
    render(<Court onValueChange={onValueChange} />, { reactStrictMode: true });
    open(screen.getByRole("combobox", { name: "Court" }));
    const option = screen.getByRole("option", { name: "Court A" });
    option.focus();
    fireEvent.keyDown(option, { key: "Enter" });
    expect(onValueChange).toHaveBeenCalledWith("a");
  });
});
