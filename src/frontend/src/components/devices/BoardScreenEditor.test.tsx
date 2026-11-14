import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { AdminDevice } from "../../lib/api";
import { BoardScreenEditor } from "./BoardV3";

/** V-2: the per-box screen editor's two choices are each named on screen, not only to assistive tech. */
describe("the per-box screen editor", () => {
  const device = { name: "Box by the door", lcd_layout: null, lcd_marquee_enabled: null } as unknown as AdminDevice;

  it("heads each radio group with visible text that is also its accessible name", () => {
    render(<BoardScreenEditor device={device} club={{ layout: "compact", marquee: true }} onSave={vi.fn()} onClose={vi.fn()} />);
    const size = screen.getByRole("radiogroup", { name: "Screen size" });
    const lines = screen.getByRole("radiogroup", { name: "Long lines" });
    expect(screen.getByRole("heading", { name: "Screen size" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Long lines" })).toBeVisible();
    expect(size).toHaveTextContent("Expanded 20×4");
    expect(lines).toHaveTextContent("Scroll long lines");
  });
});
