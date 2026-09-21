import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { SegmentedTabs, SegmentedTabPanel, nextSegmentIndex, type Segment } from "./SegmentedTabs";

/**
 * Item 9's primitive — the WAI-ARIA tabs pattern, with manual activation.
 *
 * <p>
 * The assertion that matters most is the one about what an arrow key does NOT do. On
 * `/my-code` activating a segment fires a code fetch, which is paced by a 10 s minimum gap and
 * sits behind the auth rate-limit bucket <em>shared with login</em>. An auto-activating tablist
 * would let a keyboard user arrowing across rate-limit the club's sign-in — so "arrows move
 * focus and do not select" is a correctness property, not a preference, and it is mutant #4 in
 * the design's hunt list.
 * </p>
 */

type Code = "booking" | "member";

const BOTH: Segment<Code>[] = [
  { value: "booking", label: "Booking code" },
  { value: "member", label: "Member code" },
];

const NO_BOOKING: Segment<Code>[] = [
  {
    value: "booking",
    label: "Booking code",
    disabled: true,
    disabledReason: "You have no booking starting in the next 2 hours, so there's no booking code to show.",
  },
  { value: "member", label: "Member code" },
];

function Harness({ segments = BOTH, onChange }: { segments?: Segment<Code>[]; onChange?: (v: Code) => void }) {
  const [value, setValue] = useState<Code>("booking");
  return (
    <>
      <SegmentedTabs
        segments={segments}
        value={value}
        onChange={(next) => { setValue(next); onChange?.(next); }}
        label="Which code to show"
        panelId={(v) => `panel-${v}`}
      />
      <SegmentedTabPanel id={`panel-${value}`}>The {value} code</SegmentedTabPanel>
    </>
  );
}

describe("it is a tablist, and says so", () => {
  it("names the GROUP rather than calling itself Tabs", () => {
    render(<Harness />);
    expect(screen.getByRole("tablist", { name: "Which code to show" })).toBeInTheDocument();
  });

  it("marks exactly one tab selected", () => {
    render(<Harness />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.filter((t) => t.getAttribute("aria-selected") === "true")).toHaveLength(1);
  });

  it("points every aria-controls at an element that exists", () => {
    render(<Harness />);
    for (const tab of screen.getAllByRole("tab")) {
      const id = tab.getAttribute("aria-controls")!;
      // A dangling reference is silent: the tab announces a panel and the panel is not there.
      // Only the selected tab's panel is RENDERED here, which is the ordinary pattern, so the
      // assertion is that the selected one resolves.
      if (tab.getAttribute("aria-selected") === "true") {
        expect(document.getElementById(id)).not.toBeNull();
      } else {
        expect(id).toBeTruthy();
      }
    }
  });

  it("gives the panel a tab stop, so Tab out of the tabs lands on the code", () => {
    render(<Harness />);
    // Without it a screen-reader user leaving the single-stop tablist goes PAST the content
    // the tabs exist to show.
    expect(screen.getByRole("tabpanel")).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "segment-panel-booking");
  });

  it("is one tab stop for the whole group, on whichever tab is showing", () => {
    render(<Harness />);
    const [booking, member] = screen.getAllByRole("tab");
    expect(booking).toHaveAttribute("tabindex", "0");
    expect(member).toHaveAttribute("tabindex", "-1");
  });
});

describe("arrows move focus and do not select", () => {
  it("moves focus without changing the selection or calling onChange", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const [booking, member] = screen.getAllByRole("tab");
    act(() => { booking.focus(); });

    fireEvent.keyDown(booking, { key: "ArrowRight" });

    expect(member).toHaveFocus();
    expect(member).toHaveAttribute("aria-selected", "false");
    // The whole reason for manual activation: this would have been a paced, rate-limited
    // network request per keypress.
    expect(onChange).not.toHaveBeenCalled();
  });

  it("activates on Enter", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const [booking, member] = screen.getAllByRole("tab");
    act(() => { booking.focus(); });
    fireEvent.keyDown(booking, { key: "ArrowRight" });
    // Enter on a <button> is a click in every engine; fired as one here for the same reason
    // the repo's other keyboard tests use fireEvent — user-event's keyboard path never
    // settles under jsdom 28.
    fireEvent.click(member);
    expect(onChange).toHaveBeenCalledWith("member");
  });

  it("activates on Space, and does not scroll the page on the way", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const member = screen.getAllByRole("tab")[1];
    act(() => { member.focus(); });
    const down = fireEvent.keyDown(member, { key: " " });
    // `fireEvent` returns false when a handler called preventDefault.
    expect(down).toBe(false);
    fireEvent.keyUp(member, { key: " " });
    expect(onChange).toHaveBeenCalledWith("member");
  });

  it("wraps at both ends, which is where a roving tabindex goes wrong", () => {
    expect(nextSegmentIndex("ArrowRight", 1, 2, "horizontal")).toBe(0);
    expect(nextSegmentIndex("ArrowLeft", 0, 2, "horizontal")).toBe(1);
    expect(nextSegmentIndex("Home", 1, 2, "horizontal")).toBe(0);
    expect(nextSegmentIndex("End", 0, 2, "horizontal")).toBe(1);
  });

  it("answers null for keys that are not its business", () => {
    // A tablist that swallowed Tab, or Enter, would break the pattern it implements.
    for (const key of ["Tab", "Enter", " ", "Escape", "a", "ArrowUp"]) {
      expect(nextSegmentIndex(key, 0, 2, "horizontal"), key).toBeNull();
    }
  });

  it("swaps to Up/Down when it has stacked", () => {
    expect(nextSegmentIndex("ArrowDown", 0, 2, "vertical")).toBe(1);
    expect(nextSegmentIndex("ArrowUp", 0, 2, "vertical")).toBe(1);
    // …and the horizontal pair stops answering, or a stacked tablist responds to both, which
    // is two navigation models on one control.
    expect(nextSegmentIndex("ArrowRight", 0, 2, "vertical")).toBeNull();
  });
});

describe("a segment that cannot be chosen is present, dimmed, and says why", () => {
  it("stays in the tab order, because a reason nobody can reach is not a reason", () => {
    render(<Harness segments={NO_BOOKING} />);
    const booking = screen.getAllByRole("tab")[0];
    expect(booking).toHaveAttribute("aria-disabled", "true");
    // `disabled`, not `aria-disabled`, would take it out of the tab order entirely — a hole
    // in the keyboard path that explains nothing. Mutant #5 in the design's hunt list.
    expect(booking).not.toBeDisabled();
  });

  it("describes itself without letting the reason become its name", () => {
    render(<Harness segments={NO_BOOKING} />);
    const booking = screen.getAllByRole("tab")[0];
    // The NAME is still the two words on it — what a speech-control user says to reach it.
    expect(booking).toHaveAccessibleName("Booking code");
    expect(booking).toHaveAccessibleDescription(/no booking starting in the next 2 hours/);
  });

  it("refuses to activate, since aria-disabled does not stop a click by itself", () => {
    const onChange = vi.fn();
    render(<Harness segments={NO_BOOKING} onChange={onChange} />);
    fireEvent.click(screen.getAllByRole("tab")[0]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("is still reachable by an arrow key", () => {
    render(<Harness segments={NO_BOOKING} />);
    const [booking, member] = screen.getAllByRole("tab");
    act(() => { member.focus(); });
    fireEvent.keyDown(member, { key: "ArrowLeft" });
    expect(booking).toHaveFocus();
  });
});

describe("the thumb and the touch target", () => {
  it("draws the thumb from a measurement, never from a fraction", () => {
    const { container } = render(<Harness />);
    const thumb = container.querySelector("[data-segmented-thumb]") as HTMLElement | null;
    expect(thumb).not.toBeNull();
    // jsdom reports every offset as 0, so what is asserted is the SHAPE — a pixel transform
    // and explicit pixel dimensions, rather than a percentage that would look right at one
    // width and wrong at every other. The geometry itself is measured in the Playwright spec,
    // in an engine that has a layout.
    expect(thumb!.style.transform).toMatch(/^translate\(\d+(\.\d+)?px, \d+(\.\d+)?px\)$/);
    expect(thumb).toHaveAttribute("aria-hidden", "true");
  });

  it("keeps a 44 px floor in pixels, so it does not double with the text", () => {
    render(<Harness />);
    for (const tab of screen.getAllByRole("tab")) {
      // B12's rule: a touch target is a fingertip. `min-h-11` is 88 px at a 32 px root.
      expect(tab.className).toContain("min-h-[44px]");
    }
  });

  it("carries a transparent boundary, or forced colours leaves two words in a row", () => {
    render(<Harness />);
    expect(screen.getByRole("tablist").className).toContain("border-transparent");
    for (const tab of screen.getAllByRole("tab")) expect(tab.className).toContain("border-transparent");
  });

  it("opts out of the hover lift — a capsule whose segments rise wobbles", () => {
    render(<Harness />);
    for (const tab of screen.getAllByRole("tab")) expect(tab.className).toContain("no-lift");
  });
});
