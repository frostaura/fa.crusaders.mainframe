import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WeekStrip, type WeekStripProps } from "../week-strip";

const strict = { reactStrictMode: true };

/** Wednesday 23 September 2026 is "today" throughout. */
function strip(overrides: Partial<WeekStripProps> = {}) {
  const onChange = vi.fn();
  const props: WeekStripProps = {
    value: "2026-09-23", onChange, min: "2026-09-01", max: "2026-10-07", today: "2026-09-23", ...overrides,
  };
  render(<WeekStrip {...props} />, strict);
  return { onChange: props.onChange as ReturnType<typeof vi.fn> };
}

const chip = (date: string) => document.querySelector<HTMLElement>(`[data-date="${date}"]`)!;

describe("WeekStrip", () => {
  it("shows Monday to Sunday of the selected week, with today selected and ringed", () => {
    strip();
    const days = screen.getAllByRole("radio");
    expect(days.map((d) => d.getAttribute("data-date"))).toEqual([
      "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27",
    ]);
    const today = screen.getByRole("radio", { name: "Wednesday 23 September, today" });
    expect(today).toHaveAttribute("aria-checked", "true");
    expect(today).toHaveAttribute("data-state", "on");
    expect(today.className).toContain("ring-accent-strong");
    expect(screen.getByRole("radiogroup", { name: "Choose a day" })).toBeInTheDocument();
    expect(screen.getByText("September 2026")).toBeInTheDocument();
  });

  it("chips carry the weekday (xs) and the day number (lg, tabular), 56px tall", () => {
    strip();
    const thursday = chip("2026-09-24");
    expect(thursday.textContent).toBe("Thu24");
    expect(thursday.className).toContain("h-14");
    expect(thursday.querySelector(".text-lg.tabular-nums")).toHaveTextContent("24");
  });

  it("mutes and disables the past for members", () => {
    strip({ disablePast: true });
    for (const date of ["2026-09-21", "2026-09-22"]) {
      expect(chip(date)).toBeDisabled();
      expect(chip(date)).toHaveAttribute("aria-disabled", "true");
      expect(chip(date).className).toContain("text-text-muted");
    }
    expect(chip("2026-09-23")).not.toBeDisabled();
  });

  it("leaves the past selectable when disablePast is off (admins)", () => {
    const { onChange } = strip();
    expect(chip("2026-09-22")).not.toBeDisabled();
    fireEvent.click(chip("2026-09-22"));
    expect(onChange).toHaveBeenCalledWith("2026-09-22");
  });

  it("disables days outside the booking window", () => {
    strip({ value: "2026-10-06" });
    expect(chip("2026-10-07")).not.toBeDisabled();
    expect(chip("2026-10-08")).toBeDisabled();
  });

  it("dots the days the member has a booking, and says so in the name", () => {
    strip({ markedDays: new Set(["2026-09-25"]) });
    const friday = screen.getByRole("radio", { name: "Friday 25 September, you have a booking" });
    expect(friday.querySelector("[data-marked-dot]")).toHaveAttribute("aria-hidden", "true");
    expect(chip("2026-09-24").querySelector("[data-marked-dot]")).toBeNull();
  });

  it("selects a day on click and never clears the selection", () => {
    const { onChange } = strip();
    fireEvent.click(chip("2026-09-24"));
    expect(onChange).toHaveBeenLastCalledWith("2026-09-24");
    onChange.mockClear();
    fireEvent.click(chip("2026-09-23")); // the selected chip again
    expect(onChange).not.toHaveBeenCalled();
  });

  it("roves with the arrow keys", async () => {
    strip();
    const today = chip("2026-09-23");
    today.focus();
    fireEvent.keyDown(today, { key: "ArrowRight" });
    await waitFor(() => expect(document.activeElement).toBe(chip("2026-09-24")));
    fireEvent.keyDown(chip("2026-09-24"), { key: "ArrowLeft" });
    await waitFor(() => expect(document.activeElement).toBe(today));
  });

  it("moves a week at a time, keeping the weekday", () => {
    const { onChange } = strip({ value: "2026-09-30" });
    fireEvent.click(screen.getByRole("button", { name: "Next week" }));
    expect(onChange).toHaveBeenLastCalledWith("2026-10-07");
    fireEvent.click(screen.getByRole("button", { name: "Previous week" }));
    expect(onChange).toHaveBeenLastCalledWith("2026-09-23");
  });

  it("clamps next week to the end of the window", () => {
    const { onChange } = strip({ value: "2026-09-30", max: "2026-10-05" });
    fireEvent.click(screen.getByRole("button", { name: "Next week" }));
    expect(onChange).toHaveBeenLastCalledWith("2026-10-05");
  });

  it("clamps previous week to today for members", () => {
    const { onChange } = strip({ value: "2026-09-28", disablePast: true });
    fireEvent.click(screen.getByRole("button", { name: "Previous week" }));
    expect(onChange).toHaveBeenLastCalledWith("2026-09-23");
  });

  it("blocks prev/next at the window's edges without dropping focus", () => {
    const { onChange } = strip({ value: "2026-09-24", disablePast: true, max: "2026-09-27" });
    const prev = screen.getByRole("button", { name: "Previous week" });
    const next = screen.getByRole("button", { name: "Next week" });
    expect(prev).toHaveAttribute("aria-disabled", "true");
    expect(next).toHaveAttribute("aria-disabled", "true");
    expect(prev).not.toBeDisabled();
    fireEvent.click(prev);
    fireEvent.click(next);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("labels a week that spans two months", () => {
    strip({ value: "2026-09-30" });
    expect(screen.getByText("September – October 2026")).toBeInTheDocument();
  });

  it("renders the trailing slot beside the week buttons", () => {
    strip({ trailing: <button type="button" aria-label="Pick a date">C</button> });
    expect(screen.getByRole("button", { name: "Pick a date" })).toBeInTheDocument();
  });

  it("starts the week on Sunday when asked", () => {
    strip({ weekStartsOn: 0 });
    expect(screen.getAllByRole("radio")[0]).toHaveAttribute("data-date", "2026-09-20");
  });

  it("derives today from the given zone, not the runner's, when today is not passed", () => {
    vi.useFakeTimers();
    // 23:30 UTC on the 22nd: already the 23rd on this runner (TZ=Africa/Johannesburg), still
    // the 22nd in UTC. Asking for UTC must say the 22nd, or the zone is being ignored.
    vi.setSystemTime(new Date("2026-09-22T23:30:00Z"));
    strip({ today: undefined, timeZone: "UTC" });
    vi.useRealTimers();
    expect(chip("2026-09-22")).toHaveAttribute("data-today", "true");
    expect(chip("2026-09-23")).not.toHaveAttribute("data-today");
  });
});
