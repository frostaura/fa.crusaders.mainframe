import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ScheduleConflict } from "@/lib/adminApi";
import { CONFLICT_REASON } from "@/lib/scheduleCopy";
import { ConflictPanel } from "../ConflictPanel";

/**
 * R17 X17-7 — "Cancel N bookings" was `disabled` until a reason was typed: a dead button that
 * left the tab order and said nothing, beside a field that was not marked required. Now the button
 * is always pressable; a press with no reason opens nothing, marks the field invalid with its
 * complaint and puts the keyboard there (the Sell / Cancel sheets' rule). Varied: one booking and
 * two, a blank and a whitespace-only reason.
 */
afterEach(() => { vi.restoreAllMocks(); });

const conflict = (n: number): ScheduleConflict => ({
  occurrence_date: "2030-10-06", court_id: `c${n}`, court_name: `Court ${n}`, starts_at: "2030-10-06T16:00:00Z",
  booking_id: `b${n}`, kind: "booking", member_name: `Member ${n}`, amount_minutes: 45, would_refund_minutes: 45,
});

function panel(count: number) {
  render(<ConflictPanel conflicts={Array.from({ length: count }, (_, i) => conflict(i + 1))} timezone="Africa/Johannesburg" onCleared={vi.fn()} leave={{ onLeaveOut: vi.fn(), leaving: false }} />);
  return screen.getByRole("textbox", { name: /reason/i });
}

describe("R17 X17-7 — the conflict panel's cancel button is never dead", () => {
  for (const count of [1, 2]) {
    for (const typed of ["", "   "]) {
      it(`${count} booking(s), reason ${JSON.stringify(typed)}: pressable, refuses in words, focuses the field`, async () => {
        const field = panel(count);
        expect(field).toHaveAttribute("aria-required", "true");
        if (typed) fireEvent.change(field, { target: { value: typed } });
        const go = screen.getByRole("button", { name: /^Cancel/ });
        expect(go).toBeEnabled();
        fireEvent.click(go);
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(await screen.findByText(CONFLICT_REASON.missing)).toBeInTheDocument();
        expect(field).toHaveAttribute("aria-invalid", "true");
        await vi.waitFor(() => expect(field).toHaveFocus());
      });
    }
  }

  it("with a reason, the press opens the confirmation", async () => {
    const field = panel(2);
    fireEvent.change(field, { target: { value: "League from 6 October" } });
    fireEvent.click(screen.getByRole("button", { name: /^Cancel/ }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByText(CONFLICT_REASON.missing)).toBeNull();
  });
});
