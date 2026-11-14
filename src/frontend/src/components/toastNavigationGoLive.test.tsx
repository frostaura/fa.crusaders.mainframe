import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { useNavigate } from "react-router-dom";
import { useToast } from "./toastContext";
import { TOAST_KEEP_ACROSS_NAV_MS } from "./Toast";
import { renderPage } from "../test/harness";

/**
 * Go-live BM-14 — "Couldn't add the passkey", raised on the get-started wizard, sat over My Code for
 * 40 s after Finish. A move to another page drops every toast raised before the move; one raised in
 * the same breath as the navigation is the news of it, and stays.
 */
function Page() {
  const toast = useToast();
  const navigate = useNavigate();
  return (
    <>
      <button type="button" onClick={() => toast.push({ tone: "danger", text: "Couldn't add the passkey.", durationMs: 60_000 })}>raise</button>
      <button type="button" onClick={() => navigate("/my-code")}>go</button>
      <button type="button" onClick={() => { toast.push({ tone: "success", text: "Booking cancelled." }); navigate("/bookings"); }}>cancel-and-go</button>
    </>
  );
}

afterEach(() => { vi.useRealTimers(); });

describe("toasts and navigation (BM-14)", () => {
  it("a toast from the last page is gone once the member moves on", () => {
    vi.useFakeTimers();
    renderPage(<Page />, { initialEntries: ["/get-started"] });
    fireEvent.click(screen.getByRole("button", { name: "raise" }));
    expect(screen.getByText("Couldn't add the passkey.")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(TOAST_KEEP_ACROSS_NAV_MS + 500); });
    fireEvent.click(screen.getByRole("button", { name: "go" }));
    expect(screen.queryByText("Couldn't add the passkey.")).toBeNull();
  });

  it("a toast raised with the navigation travels with it", () => {
    vi.useFakeTimers();
    renderPage(<Page />, { initialEntries: ["/bookings/1"] });
    fireEvent.click(screen.getByRole("button", { name: "cancel-and-go" }));
    expect(screen.getByText("Booking cancelled.")).toBeInTheDocument();
  });

  it("staying on the page leaves it to its own clock", () => {
    vi.useFakeTimers();
    renderPage(<Page />, { initialEntries: ["/get-started"] });
    fireEvent.click(screen.getByRole("button", { name: "raise" }));
    act(() => { vi.advanceTimersByTime(TOAST_KEEP_ACROSS_NAV_MS + 500); });
    expect(screen.getByText("Couldn't add the passkey.")).toBeInTheDocument();
  });
});
