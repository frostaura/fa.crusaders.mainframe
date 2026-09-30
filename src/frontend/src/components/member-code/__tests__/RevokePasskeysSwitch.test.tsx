import { useState } from "react";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { RevokePasskeysSwitch } from "../RevokePasskeysSwitch";

/**
 * R2 leftovers: the switch is 44×26, so the row around it is the hit target — one 44px-min-height
 * label that holds the switch, its name and its hint, and flips it from anywhere on it. The name
 * stays the label alone and the hint stays the description, so a screen reader hears no change.
 */
const LABEL = "Also remove the passkeys";
const HINT = "A lost phone's passkey would sign straight back in.";

function Harness() {
  const [on, setOn] = useState(true);
  return <RevokePasskeysSwitch label={LABEL} hint={HINT} checked={on} onChange={setOn} />;
}

describe("RevokePasskeysSwitch", () => {
  it("is named by its label and described by its hint", () => {
    render(<Harness />);
    const toggle = screen.getByRole("switch", { name: LABEL });
    expect(toggle).toHaveAccessibleName(LABEL);
    expect(toggle).toHaveAccessibleDescription(HINT);
  });

  it("flips from anywhere on its row — the hint too — inside one 44px-min-height label", () => {
    render(<Harness />);
    const toggle = screen.getByRole("switch", { name: LABEL });
    const row = toggle.closest("label");
    expect(row).not.toBeNull();
    expect(row).toHaveClass("min-h-11");
    expect(row).toContainElement(screen.getByText(HINT));

    fireEvent.click(screen.getByText(HINT));
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(screen.getByText(LABEL));
    expect(toggle).toHaveAttribute("aria-checked", "true");
    // The switch itself flips once, not twice (a click inside a label is not re-dispatched).
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });
});
