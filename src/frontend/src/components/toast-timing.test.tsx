import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ToastProvider, useToast } from "./Toast";
import { toastReadingMs } from "./toastTiming";

/**
 * X4-8 (review round 4, WCAG 2.2.1 Timing adjustable) — a toast vanished after 4 s whatever it
 * said and whatever the reader was doing: a pointer resting on it or a keyboard focused on it did
 * not hold it, and a two-sentence lost-reply explanation got the same 4 s as "Saved.".
 */

function Raise({ text, durationMs }: { text: string; durationMs?: number }) {
  const toast = useToast();
  return <button type="button" onClick={() => toast.push({ text, durationMs })}>Raise</button>;
}

function raise(text: string, durationMs?: number) {
  render(<ToastProvider><Raise text={text} durationMs={durationMs} /></ToastProvider>);
  act(() => { screen.getByRole("button", { name: "Raise" }).click(); });
  return screen.getByRole("status");
}

/** Advance time in small steps so the enter frame and every timer run as they would. */
function wait(ms: number) {
  act(() => { vi.advanceTimersByTime(ms); });
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("a toast's time on screen", () => {
  it("still leaves on its own after about 4 s when it is short", () => {
    raise("Saved.");
    wait(3_900);
    expect(screen.queryByRole("status")).toBeInTheDocument();
    wait(600);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("stays while the pointer rests on it, and counts on from where it stopped", () => {
    const toast = raise("Saved.");
    wait(2_000);
    fireEvent.mouseEnter(toast);
    wait(20_000);
    expect(screen.getByRole("status")).toBeInTheDocument();
    fireEvent.mouseLeave(toast);
    wait(1_500);
    expect(screen.getByRole("status")).toBeInTheDocument();
    wait(1_000);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("stays while it holds the keyboard's focus", () => {
    const toast = raise("Saved.");
    wait(1_000);
    fireEvent.focus(toast);
    wait(30_000);
    expect(screen.getByRole("status")).toBeInTheDocument();
    fireEvent.blur(toast);
    wait(3_500);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("gives a long explanation the time it takes to read", () => {
    const long = "We couldn't hear back from the club, so we checked: the booking went through and 50.00 credits came off your wallet. Nothing else changed.";
    expect(toastReadingMs(long)).toBeGreaterThan(8_000);
    raise(long);
    wait(6_000);
    expect(screen.getByRole("status")).toBeInTheDocument();
    wait(toastReadingMs(long));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("keeps a toast asked to stay until it is dismissed", () => {
    raise("Offline.", 0);
    wait(60_000);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });
});
