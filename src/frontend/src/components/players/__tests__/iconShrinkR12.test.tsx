import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Attendance } from "../detail/AttendanceAndCancel";
import { detail } from "./detailKit";

/**
 * R12 L12-2 — at 320 / 200 % the "At the court" line wraps and its Clock / CheckCircle icon, a
 * flex item without shrink-0, shrank to 7.7 px. An icon beside wrapping text never shrinks.
 */
describe("R12 L12-2 — icons beside wrapping text keep their size", () => {
  it.each([
    ["not checked in", null],
    ["checked in", "2026-09-30T16:02:00Z"],
  ])("Attendance, %s", (_, at) => {
    const { container } = render(
      <MemoryRouter><Attendance detail={detail({ attendance: { checked_in_at: at, players_checked_in: at ? 1 : 0 } })} /></MemoryRouter>,
    );
    const icons = container.querySelectorAll("svg");
    expect(icons.length).toBeGreaterThan(0);
    for (const icon of icons) expect(icon.getAttribute("class") ?? "").toMatch(/\bshrink-0\b/);
  });
});
