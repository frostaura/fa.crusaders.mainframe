import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Freshness, MIN_SPIN_MS, RefreshButton } from "../refresh-button";

const strict = { reactStrictMode: true };

afterEach(() => vi.useRealTimers());

describe("RefreshButton", () => {
  it("is a named 44px icon button, not busy at rest", () => {
    render(<RefreshButton onRefresh={() => {}} />, strict);
    const button = screen.getByRole("button", { name: "Refresh" });
    // R6 L6-16 — at least 44px, and growing with the text.
    expect(button.className).toContain("size-[max(44px,2rem)]");
    expect(button).not.toHaveAttribute("aria-busy");
    expect(button.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("is aria-busy (and aria-disabled, so focus stays) while loading", () => {
    render(<RefreshButton onRefresh={() => {}} loading label="Refresh the board" />);
    const button = screen.getByRole("button", { name: "Refresh the board" });
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toBeDisabled();
    expect(button.querySelector("svg")!.getAttribute("class")).toContain("animate-spin");
    expect(button.querySelector("svg")!.getAttribute("class")).toContain("motion-reduce:animate-none");
  });

  it(`spins for at least ${MIN_SPIN_MS}ms after a press, however fast the read answers`, () => {
    vi.useFakeTimers();
    const onRefresh = vi.fn();
    const { rerender } = render(<RefreshButton onRefresh={onRefresh} loading={false} />, strict);
    const button = screen.getByRole("button", { name: "Refresh" });

    fireEvent.click(button);
    expect(onRefresh).toHaveBeenCalledOnce();
    rerender(<RefreshButton onRefresh={onRefresh} loading />);
    rerender(<RefreshButton onRefresh={onRefresh} loading={false} />); // answered in ~0ms
    expect(button, "still spinning — a 40ms read must not flicker").toHaveAttribute("aria-busy", "true");

    act(() => { vi.advanceTimersByTime(MIN_SPIN_MS - 1); });
    expect(button).toHaveAttribute("aria-busy", "true");
    act(() => { vi.advanceTimersByTime(1); });
    expect(button).not.toHaveAttribute("aria-busy");
  });

  it("ignores a press while it is spinning", () => {
    vi.useFakeTimers();
    const onRefresh = vi.fn();
    render(<RefreshButton onRefresh={onRefresh} />);
    const button = screen.getByRole("button", { name: "Refresh" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onRefresh).toHaveBeenCalledOnce();
    act(() => { vi.advanceTimersByTime(MIN_SPIN_MS); });
    fireEvent.click(button);
    expect(onRefresh).toHaveBeenCalledTimes(2);
  });

  it("keeps spinning for as long as a slow read takes", () => {
    vi.useFakeTimers();
    render(<RefreshButton onRefresh={() => {}} loading />);
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(screen.getByRole("button", { name: "Refresh" })).toHaveAttribute("aria-busy", "true");
  });
});

describe("Freshness", () => {
  const NOW = new Date("2026-09-23T16:00:00Z").getTime();
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it("says how old the screen is, in a <time>", () => {
    render(<Freshness at={NOW - 12_000} />, strict);
    const time = screen.getByText("Updated 12 seconds ago");
    expect(time.tagName).toBe("TIME");
    expect(time).toHaveAttribute("datetime", new Date(NOW - 12_000).toISOString());
    expect(time).not.toHaveAttribute("data-stale");
    expect(time.className).toContain("text-text-muted");
  });

  it("accepts a Date and says 'just now' for a fresh read", () => {
    render(<Freshness at={new Date(NOW)} />);
    expect(screen.getByText("Updated just now")).toBeInTheDocument();
  });

  it("re-renders every 10 seconds", () => {
    render(<Freshness at={NOW - 12_000} />);
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(screen.getByText("Updated 22 seconds ago")).toBeInTheDocument();
  });

  it("turns warning — colour AND an icon — once stale", () => {
    render(<Freshness at={NOW - 90_000} />);
    const time = screen.getByText("Updated 1 minute ago");
    expect(time).toHaveAttribute("data-stale", "true");
    expect(time.className).toContain("text-warning-strong");
    expect(time.querySelector("svg"), "colour is never the only signal").toHaveAttribute("aria-hidden", "true");
  });

  it("goes stale on the clock, not only on arrival", () => {
    render(<Freshness at={NOW - 55_000} staleAfterMs={60_000} />);
    expect(screen.getByText("Updated 55 seconds ago")).not.toHaveAttribute("data-stale");
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(screen.getByText("Updated 1 minute ago")).toHaveAttribute("data-stale", "true");
  });

  it("renders nothing before the first read", () => {
    const { container } = render(<Freshness at={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
