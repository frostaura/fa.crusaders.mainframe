import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ToastProvider } from "./Toast";
import { useToast } from "./toastContext";
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
  return shown()!;
}

/** The toast on screen, or null (R19 X19-3: a toast is found by `data-toast`, not as a live region). */
function shown(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-toast]");
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
    expect(shown()).toBeInTheDocument();
    wait(600);
    expect(shown()).not.toBeInTheDocument();
  });

  it("stays while the pointer rests on it, and counts on from where it stopped", () => {
    const toast = raise("Saved.");
    wait(2_000);
    fireEvent.mouseEnter(toast);
    wait(20_000);
    expect(shown()).toBeInTheDocument();
    fireEvent.mouseLeave(toast);
    wait(1_500);
    expect(shown()).toBeInTheDocument();
    wait(1_000);
    expect(shown()).not.toBeInTheDocument();
  });

  it("stays while its dismiss button holds the keyboard's focus", () => {
    const toast = raise("Saved.");
    const dismiss = toast.querySelector("button")!;
    wait(1_000);
    fireEvent.focus(dismiss);
    wait(30_000);
    expect(shown()).toBeInTheDocument();
    fireEvent.blur(dismiss);
    wait(3_500);
    expect(shown()).not.toBeInTheDocument();
  });

  it("gives a long explanation the time it takes to read", () => {
    const long = "We couldn't hear back from the club, so we checked: the booking went through and 50.00 credits came off your wallet. Nothing else changed.";
    expect(toastReadingMs(long)).toBeGreaterThan(8_000);
    raise(long);
    wait(6_000);
    expect(shown()).toBeInTheDocument();
    wait(toastReadingMs(long));
    expect(shown()).not.toBeInTheDocument();
  });

  it("keeps a toast asked to stay until it is dismissed", () => {
    raise("Offline.", 0);
    wait(60_000);
    expect(shown()).toBeInTheDocument();
  });
});
