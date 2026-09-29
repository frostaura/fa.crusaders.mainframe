import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { TZDate } from "react-day-picker";
import { Calendar } from "../calendar";
import { DatePicker } from "../date-picker";
import { formatClubDayLabel } from "../date-picker-day";
import { TimeSelect, timeOptions } from "../time-select";
import { SM_UP, useMediaQuery } from "../use-media-query";

const strict = { reactStrictMode: true };

/** The shared setup answers `matches: false` (a phone); this answers true for `sm` and up. */
function desktop() {
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: query === SM_UP,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** The club day an instant falls on in `zone` — independent of the code under test. */
function dayIn(date: Date, zone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function dayButton(container: HTMLElement, day: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`button[data-day="${day}"]`);
  if (!button) throw new Error(`no day button for ${day}`);
  return button;
}

// Auckland is the zone under test on purpose: the runner is pinned to Johannesburg, ten hours
// behind, so a calendar that ignored its zone would emit the 22nd for a tap on the 23rd.
const ZONE = "Pacific/Auckland";

describe("Calendar", () => {
  function renderCalendar(onSelect = vi.fn()) {
    const view = render(
      <Calendar
        mode="single"
        timeZone={ZONE}
        defaultMonth={new TZDate(2026, 8, 1, ZONE)}
        disabled={[{ before: new TZDate(2026, 8, 10, ZONE) }, { after: new TZDate(2026, 8, 25, ZONE) }]}
        onSelect={onSelect}
      />,
      strict,
    );
    return { ...view, onSelect };
  }

  it("disables the days outside the range and keeps those inside choosable", () => {
    const { container } = renderCalendar();
    expect(dayButton(container, "2026-09-09")).toBeDisabled();
    expect(dayButton(container, "2026-09-26")).toBeDisabled();
    expect(dayButton(container, "2026-09-10")).toBeEnabled();
    expect(dayButton(container, "2026-09-25")).toBeEnabled();
  });

  it("emits the tapped day in the club zone", () => {
    const { container, onSelect } = renderCalendar();
    fireEvent.click(dayButton(container, "2026-09-23"));
    const picked = onSelect.mock.calls[0][0] as Date;
    expect(dayIn(picked, ZONE)).toBe("2026-09-23");
  });

  it("starts the week on Monday and marks day buttons as no-lift calendar days of 44px", () => {
    const { container } = renderCalendar();
    expect(container.querySelector("th")).toHaveAttribute("aria-label", "Monday");
    const day = dayButton(container, "2026-09-23");
    expect(day).toHaveAttribute("data-slot", "calendar-day");
    expect(day.className).toContain("no-lift");
    expect(day.className).toContain("size-11");
    expect(day.className).not.toMatch(/outline-none|focus-visible:ring/);
  });

  it("marks the selected day", () => {
    const { container } = render(
      <Calendar mode="single" timeZone={ZONE} defaultMonth={new TZDate(2026, 8, 1, ZONE)} selected={new TZDate(2026, 8, 23, ZONE)} />,
      strict,
    );
    expect(dayButton(container, "2026-09-23")).toHaveAttribute("data-selected", "true");
    expect(dayButton(container, "2026-09-22")).not.toHaveAttribute("data-selected");
  });
});

describe("DatePicker", () => {
  // The spec's example is "Tue 23 Sep"; in 2026 the 23rd of September is a Wednesday.
  it("labels the trigger like the week strip: 'Wed 23 Sep'", () => {
    expect(formatClubDayLabel("2026-09-23")).toBe("Wed 23 Sep");
    expect(formatClubDayLabel("2026-01-05")).toBe("Mon 5 Jan");
    expect(formatClubDayLabel("23/09/2026")).toBeNull();
    expect(formatClubDayLabel(undefined)).toBeNull();
    render(<DatePicker label="Jump to a date" value="2026-09-23" onChange={() => undefined} />, strict);
    const trigger = screen.getByRole("button", { name: "Jump to a date: Wed 23 Sep" });
    expect(trigger).toHaveTextContent("Wed 23 Sep");
    expect(trigger.className).toContain("min-h-touch");
  });

  it("shows the placeholder with no value", () => {
    render(<DatePicker label="Jump to a date" value={null} onChange={() => undefined} />, strict);
    expect(screen.getByRole("button", { name: "Jump to a date" })).toHaveTextContent("Pick a date");
  });

  function Jump({ onChange }: { onChange: (day: string) => void }) {
    const [value, setValue] = useState("2026-09-23");
    return (
      <DatePicker
        label="Jump to a date"
        value={value}
        min="2026-09-20"
        max="2026-09-30"
        timeZone={ZONE}
        onChange={(day) => {
          setValue(day);
          onChange(day);
        }}
      />
    );
  }

  it("opens a sheet on a phone, bounds the days, and returns the chosen club day", async () => {
    const onChange = vi.fn();
    render(<Jump onChange={onChange} />, strict);
    fireEvent.click(screen.getByRole("button", { name: "Jump to a date: Wed 23 Sep" }));
    const sheet = screen.getByRole("dialog", { name: "Jump to a date" });
    // The calendar is its own lazily loaded chunk (P10); the sheet opens first.
    await within(sheet).findByRole("button", { name: /next month/i }, { timeout: 10_000 });
    expect(dayButton(sheet, "2026-09-19")).toBeDisabled();
    // max is in this month, so there is nowhere to navigate to in either direction.
    expect(within(sheet).getByRole("button", { name: /next month/i })).toHaveAttribute("aria-disabled", "true");
    expect(within(sheet).getByRole("button", { name: /previous month/i })).toHaveAttribute("aria-disabled", "true");
    expect(dayButton(sheet, "2026-09-23")).toHaveAttribute("data-selected", "true");
    fireEvent.click(dayButton(sheet, "2026-09-25"));
    expect(onChange).toHaveBeenCalledWith("2026-09-25");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Jump to a date: Fri 25 Sep" })).toBeInTheDocument();
  });
});

describe("DatePicker on a wide screen", () => {
  it("opens a popover rather than a sheet", async () => {
    desktop();
    const onChange = vi.fn();
    render(<DatePicker label="Jump to a date" value="2026-09-23" timeZone={ZONE} onChange={onChange} />, strict);
    fireEvent.click(screen.getByRole("button", { name: "Jump to a date: Wed 23 Sep" }));
    const panel = screen.getByRole("dialog", { name: "Jump to a date" });
    await within(panel).findByRole("button", { name: /next month/i }, { timeout: 10_000 });
    expect(panel).toHaveAttribute("data-slot", "popover-content");
    fireEvent.click(dayButton(panel, "2026-09-24"));
    expect(onChange).toHaveBeenCalledWith("2026-09-24");
  });
});

describe("useMediaQuery", () => {
  function Probe() {
    return <span>{useMediaQuery(SM_UP) ? "wide" : "narrow"}</span>;
  }

  it("answers false where the query does not match (the phone default), true where it does", () => {
    const { unmount } = render(<Probe />, strict);
    expect(screen.getByText("narrow")).toBeInTheDocument();
    unmount();
    desktop();
    render(<Probe />, strict);
    expect(screen.getByText("wide")).toBeInTheDocument();
  });
});

describe("TimeSelect", () => {
  it("generates only slice-aligned options, end exclusive unless asked", () => {
    expect(timeOptions("06:00", "08:00", 30)).toEqual(["06:00", "06:30", "07:00", "07:30"]);
    expect(timeOptions("06:00", "08:00", 30, true)).toEqual(["06:00", "06:30", "07:00", "07:30", "08:00"]);
    expect(timeOptions("22:00", "24:00", 45)).toEqual(["22:00", "22:45", "23:30"]);
    expect(timeOptions("08:00", "06:00", 30)).toEqual([]);
    expect(timeOptions("6am", "08:00", 30)).toEqual([]);
    expect(timeOptions("06:00", "08:00", 0)).toEqual([]);
  });

  it("renders only the aligned options, and selects one", () => {
    const onChange = vi.fn();
    render(<TimeSelect label="Start time" start="18:00" end="20:00" stepMinutes={45} value={null} onChange={onChange} />, strict);
    const trigger = screen.getByRole("combobox", { name: "Start time" });
    expect(trigger).toHaveTextContent("Choose a time");
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
    const listbox = screen.getByRole("listbox");
    expect(within(listbox).getAllByRole("option").map((o) => o.textContent)).toEqual(["18:00", "18:45", "19:30"]);
    fireEvent.click(within(listbox).getByRole("option", { name: "18:45" }));
    expect(onChange).toHaveBeenCalledWith("18:45");
  });

  it("shows the placeholder for a value that is not on the grid, rather than pretending", () => {
    render(<TimeSelect label="Start time" start="18:00" end="20:00" stepMinutes={30} value="18:10" onChange={() => undefined} />, strict);
    expect(screen.getByRole("combobox", { name: "Start time" })).toHaveTextContent("Choose a time");
  });

  it("clamps the value, not the icon + value row it sits in (the row stacked under the clamp)", () => {
    render(<TimeSelect label="Start time" start="18:00" end="20:00" stepMinutes={30} value="19:30" onChange={() => undefined} />, strict);
    const trigger = screen.getByRole("combobox", { name: "Start time" });
    expect(trigger.className).not.toMatch(/line-clamp/);
    const value = trigger.querySelector('[data-slot="select-value"]')!;
    expect(value.className).toContain("line-clamp-1");
    expect(value.parentElement!.className).toContain("flex");
    expect(value.parentElement!.className).not.toMatch(/line-clamp/);
  });

  it("shows an aligned value", () => {
    render(<TimeSelect label="Start time" start="18:00" end="20:00" stepMinutes={30} value="19:30" onChange={() => undefined} />, strict);
    expect(screen.getByRole("combobox", { name: "Start time" })).toHaveTextContent("19:30");
  });
});
