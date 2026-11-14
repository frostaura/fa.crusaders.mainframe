import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SettingControl } from "./SettingControl";
import type { SettingDef } from "@/lib/settingsSchema";

/**
 * A numeric enumeration (`numericChoice`: the LCD address, the scanner speed — device-api §12) is
 * a select of strings on screen and a number on the wire: a PUT carrying "39" for a key the API
 * binds as an int would be refused, or worse, ignored.
 */

const def: SettingDef = {
  key: "hw_lcd_i2c_address", section: "boxes", kind: "select", numericChoice: true, label: "Screen (LCD) address",
  description: "", options: [{ value: "0", label: "Search for it" }, { value: "39", label: "0x27" }],
};

describe("a numeric choice", () => {
  it("shows the number it holds and hands back a number", async () => {
    const update = vi.fn();
    render(<SettingControl def={def} value={0} update={update} currency="R" />);
    const trigger = screen.getByRole("combobox");
    expect(trigger).toHaveTextContent("Search for it");
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("option", { name: "0x27" }));
    expect(update).toHaveBeenCalledWith({ hw_lcd_i2c_address: 39 });
  });

  it("leaves a string choice a string", async () => {
    const update = vi.fn();
    const text: SettingDef = { ...def, key: "hw_relay_active_level", numericChoice: undefined,
      options: [{ value: "high", label: "High" }, { value: "low", label: "Low" }] };
    render(<SettingControl def={text} value="high" update={update} currency="R" />);
    fireEvent.pointerDown(screen.getByRole("combobox"), { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("option", { name: "Low" }));
    expect(update).toHaveBeenCalledWith({ hw_relay_active_level: "low" });
  });
});
