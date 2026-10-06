import { describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { NOTHING_CHANGED, TOAST_COPY, ToastProvider } from "./Toast";
import { useToast } from "./toastContext";

/**
 * R19 X19-3 — NVDA and JAWS announce a live region's CHANGES, not a region that arrives already
 * holding its words: each toast was inserted as its own pre-filled `role="status"` (with an
 * `aria-label` overriding its text), which those readers may say nothing about. The rule now: one
 * polite live region, empty and in the document from the start, that the toast's words arrive in;
 * the toast itself is not a live region and has no label overriding its words; its dismiss control
 * is a real button with a name.
 */
function Raise({ text, unchanged = false }: { text: string; unchanged?: boolean }) {
  const toast = useToast();
  return <button type="button" onClick={() => toast.push({ text, unchanged, durationMs: 0 })}>{`Raise ${text}`}</button>;
}

function announcer(): HTMLElement {
  const regions = [...document.querySelectorAll<HTMLElement>("[aria-live]")];
  expect(regions, "exactly one live region for toasts").toHaveLength(1);
  return regions[0];
}

describe("R19 X19-3 — toasts are announced through a region that was already there", () => {
  it("the polite region is in the document, empty, before any toast", () => {
    render(<ToastProvider><Raise text="Saved." /></ToastProvider>);
    const region = announcer();
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.textContent).toBe("");
  });

  it("a toast's words arrive in that same region after it mounts, and nothing inside is a live region of its own", () => {
    render(<ToastProvider><Raise text="Saved." unchanged /></ToastProvider>);
    const before = announcer();
    act(() => { screen.getByRole("button", { name: "Raise Saved." }).click(); });
    const after = announcer();
    expect(after).toBe(before);
    expect(after).toHaveTextContent(`Saved. ${NOTHING_CHANGED}`);
    expect(after.querySelectorAll('[role="status"], [role="alert"], [aria-live], [aria-label]:not(button)')).toHaveLength(0);
  });

  it("the toast's own element carries no live role and no label overriding its words", () => {
    render(<ToastProvider><Raise text="Booked." /></ToastProvider>);
    act(() => { screen.getByRole("button", { name: "Raise Booked." }).click(); });
    const toast = document.querySelector<HTMLElement>("[data-toast]")!;
    expect(toast.getAttribute("role")).toBeNull();
    expect(toast.getAttribute("aria-label")).toBeNull();
    expect(toast).toHaveTextContent("Booked.");
  });

  it("the dismiss control is a named button, described by the toast's words, and it dismisses", async () => {
    render(<ToastProvider><Raise text="Booked." /><Raise text="Paid." /></ToastProvider>);
    act(() => { screen.getByRole("button", { name: "Raise Booked." }).click(); });
    act(() => { screen.getByRole("button", { name: "Raise Paid." }).click(); });
    const dismiss = screen.getAllByRole("button", { name: TOAST_COPY.dismiss });
    expect(dismiss).toHaveLength(2);
    expect(dismiss[0]).toHaveAccessibleDescription("Booked.");
    expect(dismiss[1]).toHaveAccessibleDescription("Paid.");
    fireEvent.click(dismiss[0]);
    await act(() => new Promise((r) => setTimeout(r, 300)));
    expect(announcer()).not.toHaveTextContent("Booked.");
    expect(announcer()).toHaveTextContent("Paid.");
  });
});
