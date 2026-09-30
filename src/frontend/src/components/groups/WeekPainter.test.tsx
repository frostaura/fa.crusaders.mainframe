import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { WeekPainter } from "./WeekPainter";
import { cellsFromValue, intervalsFromCells, rowStarts } from "./weekGrid";
import type { PaintedWeek } from "../../lib/groupsCopy";

/**
 * The weekly painter — GOAL item 3's "times range that are allowed to book between".
 *
 * <p>
 * <b>The grid is not the primary interface, and the tests are written that way round.</b> A 7 ×
 * 64 grid of coloured squares is nothing at all to somebody who cannot see it, so this control
 * has to be operable by keyboard alone and has to say what it means in one sentence that is
 * correct rather than decorative. The sentence is generated from the same intervals the cells
 * are, which is what stops the two drifting.
 * </p>
 *
 * <p>
 * <b>The live region is the part a keyboard user abandons the page over.</b> `Shift+Down` twelve
 * times is one decision, and announcing twelve cells is a screen reader somebody turns off —
 * which costs them every other announcement on the screen. The run is spoken once, when the run
 * ends.
 * </p>
 */

const CLUB: PaintedWeek = {
  mon: [{ start: 360, end: 480 }], tue: [{ start: 360, end: 480 }], wed: [{ start: 360, end: 480 }],
  thu: [{ start: 360, end: 480 }], fri: [{ start: 360, end: 480 }], sat: [{ start: 420, end: 480 }],
  sun: [],
};

function paint(value: PaintedWeek = {}, onChange = vi.fn()) {
  render(<WeekPainter club={CLUB} value={value} onChange={onChange} sliceMinutes={30} />);
  return onChange;
}

/** "Tuesday 06:00, allowed" and friends — the cell names this control is driven by. */
const cell = (name: RegExp) => screen.getByRole("gridcell", { name });

describe("the arithmetic under the grid", () => {
  it("lays out one row per slice across the widest day the club is open", () => {
    // 06:00–08:00 on weekdays, 07:00–08:00 on Saturday: the grid spans 06:00–08:00.
    expect(rowStarts(CLUB, 30)).toEqual([360, 390, 420, 450]);
  });

  it("paints a cell only where the whole slice is inside a saved window", () => {
    const cells = cellsFromValue({ tue: [{ start: 360, end: 405 }] }, [360, 390, 420, 450], 30);
    // 06:00–06:30 is wholly inside; 06:30–07:00 is only half inside and is NOT claimed.
    expect(cells.tue).toEqual([true, false, false, false]);
  });

  it("rebuilds touching rows into one interval, and keeps a real gap apart", () => {
    expect(intervalsFromCells({ tue: [true, true, false, true] }, [360, 390, 420, 450], 30).tue)
      .toEqual([{ start: 360, end: 420 }, { start: 450, end: 480 }]);
  });
});

describe("painting", () => {
  it("paints a cell on a click and emits the interval it means", () => {
    const onChange = paint();
    fireEvent.mouseDown(cell(/Tuesday 06:00/));
    fireEvent.mouseUp(window);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ tue: [{ start: 360, end: 390 }] }));
  });

  it("paints a run by dragging, in one emitted change per cell entered", () => {
    const onChange = paint();
    fireEvent.mouseDown(cell(/Tuesday 06:00/));
    fireEvent.mouseEnter(cell(/Tuesday 06:30/));
    fireEvent.mouseEnter(cell(/Tuesday 07:00/));
    fireEvent.mouseUp(window);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ tue: [{ start: 360, end: 450 }] }));
  });

  it("erases with Alt held, which is the only way back out of a mis-drag", () => {
    const onChange = paint({ tue: [{ start: 360, end: 450 }] });
    fireEvent.mouseDown(cell(/Tuesday 06:30/), { altKey: true });
    fireEvent.mouseUp(window);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      tue: [{ start: 360, end: 390 }, { start: 420, end: 450 }],
    }));
  });

  it("will not paint an hour the club is shut, however hard it is dragged at", () => {
    const onChange = paint();
    // Saturday opens at 07:00. The 06:00 cell exists so the grid stays rectangular and says
    // what it is — an empty column would read as a day that is simply missing.
    const closed = cell(/Saturday 06:00, the club is closed/);
    expect(closed).toHaveAttribute("aria-disabled", "true");
    fireEvent.mouseDown(closed);
    fireEvent.mouseUp(window);
    expect(onChange).not.toHaveBeenCalled();
  });

  /**
   * <b>A surviving mutant found this one.</b> The guard on the FIRST cell of a gesture was
   * tested and the guard on every cell the drag passes through was not — so dropping the
   * second one stayed green while a drag from Friday into Saturday's closed hours painted a
   * window the club is shut for. The API would refuse it on save with a code, at the end,
   * after the admin had painted forty cells.
   */
  it("will not paint a closed hour a drag passes THROUGH either", () => {
    const onChange = paint();
    fireEvent.mouseDown(cell(/Friday 06:00/));
    fireEvent.mouseEnter(cell(/Saturday 06:00, the club is closed/));
    fireEvent.mouseUp(window);
    const emitted = onChange.mock.calls[onChange.mock.calls.length - 1][0] as PaintedWeek;
    expect(emitted.fri).toEqual([{ start: 360, end: 390 }]);
    expect(emitted.sat ?? []).toEqual([]);
  });

  it("paints a whole day from its header, and clears it from the same control", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <WeekPainter club={CLUB} value={{}} onChange={onChange} sliceMinutes={30} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Paint all of Tuesday/ }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ tue: [{ start: 360, end: 480 }] }));

    rerender(<WeekPainter club={CLUB} value={{ tue: [{ start: 360, end: 480 }] }} onChange={onChange} sliceMinutes={30} />);
    // The same control, renamed for what it will now do. A toggle whose label does not change
    // is a control an admin presses twice to find out what it does.
    fireEvent.click(screen.getByRole("button", { name: /Clear all of Tuesday/ }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ tue: [] }));
  });

  it("paints one time across the week from its row label", () => {
    const onChange = paint();
    fireEvent.click(screen.getByRole("button", { name: /Paint 07:00 on every day/ }));
    const emitted = onChange.mock.calls[0][0] as PaintedWeek;
    expect(emitted.mon).toEqual([{ start: 420, end: 450 }]);
    // Saturday is open at 07:00 and gets it; Sunday is shut all day and does not.
    expect(emitted.sat).toEqual([{ start: 420, end: 450 }]);
    expect(emitted.sun ?? []).toEqual([]);
  });

  it("offers the three shortcuts, and weekdays-only means weekdays only", () => {
    const onChange = paint();
    fireEvent.click(screen.getByRole("button", { name: "Weekdays only" }));
    const emitted = onChange.mock.calls[0][0] as PaintedWeek;
    expect(emitted.mon).toEqual([{ start: 360, end: 480 }]);
    expect(emitted.sat ?? []).toEqual([]);
  });

  it("clears everything from one control", () => {
    const onChange = paint({ tue: [{ start: 360, end: 480 }] });
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onChange).toHaveBeenCalledWith({});
  });
});

describe("keyboard, which is not optional on a grid of squares", () => {
  it("moves with the arrows and toggles with Space", () => {
    const onChange = paint();
    const start = cell(/Monday 06:00/);
    act(() => start.focus());
    fireEvent.keyDown(start, { key: "ArrowRight" });
    expect(cell(/Tuesday 06:00/)).toHaveFocus();
    fireEvent.keyDown(cell(/Tuesday 06:00/), { key: "ArrowDown" });
    expect(cell(/Tuesday 06:30/)).toHaveFocus();
    fireEvent.keyDown(cell(/Tuesday 06:30/), { key: " " });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ tue: [{ start: 390, end: 420 }] }));
  });

  it("never lands focus on an hour the club is shut", () => {
    paint();
    const start = cell(/Friday 06:00/);
    act(() => start.focus());
    fireEvent.keyDown(start, { key: "ArrowRight" });
    // Saturday opens at 07:00, and there is nothing open to the right of Friday on this row, so
    // focus STAYS rather than landing on a cell that cannot be acted on. A grid that parks
    // focus on an inert square is one a keyboard user presses Space at and gets nothing from.
    expect(cell(/Saturday 06:00, the club is closed/)).not.toHaveFocus();
    expect(start).toHaveFocus();
    // Down a row, Saturday IS open, and the arrow reaches it.
    fireEvent.keyDown(start, { key: "ArrowDown" });
    fireEvent.keyDown(cell(/Friday 06:30/), { key: "ArrowRight" });
    expect(cell(/Saturday 06:30/)).not.toHaveFocus();
    fireEvent.keyDown(cell(/Friday 06:30/), { key: "ArrowDown" });
    fireEvent.keyDown(cell(/Friday 07:00/), { key: "ArrowRight" });
    expect(cell(/^Saturday 07:00, not allowed$/)).toHaveFocus();
  });

  /**
   * <b>The announcement is what makes this control usable, and it is why it fires ONCE.</b>
   * Twelve `Shift+Down`s are one decision. Announcing each cell is a live region somebody turns
   * their screen reader off to escape.
   */
  it("paints a run with Shift and speaks it once, when the run ends", () => {
    const onChange = paint();
    const start = cell(/Tuesday 06:00/);
    act(() => start.focus());
    fireEvent.keyDown(start, { key: " " });
    // One press, one sentence — that much is right and is the baseline for what follows.
    const live = screen.getByTestId("painter-announcement");
    expect(live).toHaveTextContent("Tuesday 06:00 to 06:30 allowed.");

    fireEvent.keyDown(cell(/Tuesday 06:00/), { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(cell(/Tuesday 06:30/), { key: "ArrowDown", shiftKey: true });
    // Two more cells painted and NOTHING new said. This is the assertion the control exists
    // for: twelve Shift+Downs are one decision, and twelve announcements are a screen reader
    // somebody switches off — which costs them every other announcement on the page.
    expect(live).toHaveTextContent("Tuesday 06:00 to 06:30 allowed.");
    fireEvent.keyUp(cell(/Tuesday 07:00/), { key: "Shift" });
    expect(screen.getByTestId("painter-announcement"))
      .toHaveTextContent("Tuesday 06:00 to 07:30 allowed.");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ tue: [{ start: 360, end: 450 }] }));
  });
});

describe("saying what it means without colour", () => {
  it("names every cell with the word as well as the fill", () => {
    paint({ tue: [{ start: 360, end: 390 }] });
    // Under forced colours the fill and the ring are both discarded; the name is what is left.
    expect(cell(/^Tuesday 06:00, allowed$/)).toHaveAttribute("aria-selected", "true");
    expect(cell(/^Tuesday 06:30, not allowed$/)).toHaveAttribute("aria-selected", "false");
  });

  it("carries a legend with a word on every swatch", () => {
    paint();
    const legend = screen.getByRole("list", { name: /What the colours mean/ });
    expect(within(legend).getByText("Allowed")).toBeInTheDocument();
    expect(within(legend).getByText("Not allowed")).toBeInTheDocument();
    expect(within(legend).getByText("Club closed")).toBeInTheDocument();
  });

  it("describes the grid with the sentence the painting means", () => {
    paint({ tue: [{ start: 360, end: 480 }] });
    const grid = screen.getByRole("grid");
    const description = document.getElementById(grid.getAttribute("aria-describedby") ?? "");
    expect(description?.textContent).toContain("Tuesdays 06:00–08:00");
    expect(description?.textContent).toContain("4 of the 22 slots the club is open");
  });

  /**
   * A saved window that does not line up with the club's slices cannot be represented by whole
   * cells, and rounding it silently is an access rule rewritten by a rendering decision.
   */
  it("says so when a saved time does not line up with the club's slots", () => {
    paint({ tue: [{ start: 367, end: 480 }] });
    expect(screen.getByText(/doesn't line up with the club's 30-minute slots/)).toBeInTheDocument();
    expect(screen.getByText(/Tuesdays 06:07–08:00/)).toBeInTheDocument();
  });
});

/** Review round 1, F3.22: the painter was one tab stop per row button, 72 on a long day. */
describe("the painter's keyboard stops", () => {
  it("gives the column of row buttons ONE tab stop, moved by Up and Down", () => {
    paint();
    const rowButtons = screen.getAllByRole("button", { name: / on every day$/ });
    expect(rowButtons.filter((b) => b.tabIndex === 0)).toHaveLength(1);
    rowButtons[0].focus();
    fireEvent.keyDown(rowButtons[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(rowButtons[1]);
    expect(rowButtons[1].tabIndex).toBe(0);
    expect(rowButtons[0].tabIndex).toBe(-1);
  });

  it("names the corner of the grid", () => {
    paint();
    expect(screen.getAllByRole("columnheader")[0]).toHaveTextContent("Time");
  });
});
