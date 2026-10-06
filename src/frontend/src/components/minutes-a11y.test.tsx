import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Minutes } from "./Minutes";
import { MINUS_SIGN } from "../lib/minutes";

/**
 * `<Minutes>` (P13 contract §7.1): the eye reads the compact form, a screen reader hears the
 * long one, and neither hears the other.
 */
function parts(ui: ReturnType<typeof render>) {
  const root = ui.container.firstElementChild as HTMLElement;
  const shown = root.querySelector("[aria-hidden='true']") as HTMLElement;
  const spoken = root.querySelector(".sr-only") as HTMLElement;
  return { root, shown, spoken };
}

describe("<Minutes>", () => {
  it("shows the compact form, hidden from assistive tech, and says the long form", () => {
    const { root, shown, spoken } = parts(render(<Minutes value={90} />));
    // R19 L19-3 — each figure glued to its unit (no-break spaces): a wrap never splits "30 / min".
    expect(shown.textContent).toBe("1\u00a0h 30\u00a0min");
    expect(shown.getAttribute("aria-hidden")).toBe("true");
    expect(spoken.textContent).toBe("1 hour 30 minutes");
    expect(root.className).toContain("tabular-nums");
  });

  it("a signed movement: '+1 h' to the eye, 'plus 1 hour' to the ear", () => {
    const { shown, spoken } = parts(render(<Minutes value={60} signed />));
    expect(shown.textContent).toBe("+1\u00a0h");
    expect(spoken.textContent).toBe("plus 1 hour");
  });

  it("a negative value wears the negative tone and is spoken with 'minus'", () => {
    const { root, shown, spoken } = parts(render(<Minutes value={-45} />));
    expect(shown.textContent).toBe(`${MINUS_SIGN}45\u00a0min`);
    expect(spoken.textContent).toBe("minus 45 minutes");
    expect(root.className).toContain("text-danger-strong");
  });

  it("zero and a positive value wear no negative tone; a zero is never signed", () => {
    for (const value of [0, 30]) {
      expect(parts(render(<Minutes value={value} />)).root.className).not.toContain("text-danger-strong");
    }
    const { shown, spoken } = parts(render(<Minutes value={0} signed />));
    expect(shown.textContent).toBe("0\u00a0min");
    expect(spoken.textContent).toBe("0 minutes");
  });

  it("a fraction that truncates to zero is neither red nor signed", () => {
    const { root, shown } = parts(render(<Minutes value={-0.5} signed />));
    expect(shown.textContent).toBe("0\u00a0min");
    expect(root.className).not.toContain("text-danger-strong");
  });

  it("the accessible text never contains h, d or min", () => {
    for (const value of [45, 60, 90, 1440, 1815, -90]) {
      const { root } = parts(render(<Minutes value={value} signed />));
      const copy = root.cloneNode(true) as HTMLElement;
      copy.querySelectorAll("[aria-hidden='true']").forEach((el) => el.remove());
      const heard = copy.textContent ?? "";
      expect(heard.length).toBeGreaterThan(0);
      expect(heard).not.toMatch(/\b(h|d|min)\b/);
    }
  });

  it("passes a className through", () => {
    expect(parts(render(<Minutes value={5} className="font-semibold" />)).root.className).toContain("font-semibold");
  });
});
