import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearNavigationPending, noteChunk } from "@/routeChunks";
import { RoutePendingBar } from "./RoutePending";

/**
 * P5-3 (review round 5) — a tap on a link to a page whose code is not on the phone shows a cue at
 * ONCE. The router moves in a transition, so the old page stands until the code arrives; this is
 * what says the tap landed. (The browser half, with a held chunk: `e2e/app-chrome` "P5-3".)
 */
afterEach(() => { clearNavigationPending(); window.history.pushState({}, "", "/"); });

function renderWithLink() {
  return render(
    <MemoryRouter initialEntries={["/bookings"]}>
      <RoutePendingBar />
      {/* What the router does: the URL moves at once, the page renders later (a transition). */}
      <a href="/bookings/b1" onClick={(event) => { event.preventDefault(); window.history.pushState({}, "", "/bookings/b1"); }}>Court 2, 18:00</a>
      <a href="/inbox" onClick={(event) => event.preventDefault()}>Kept by its own handler</a>
      <a href="/wallet" onClick={(event) => event.preventDefault()}>Wallet</a>
      <a href="https://elsewhere.example/profile" onClick={(event) => event.preventDefault()}>Elsewhere</a>
    </MemoryRouter>,
  );
}

describe("the pending cue", () => {
  it("shows at the tap and goes when the page's code arrives", async () => {
    renderWithLink();
    expect(document.querySelector("[data-route-pending]")).toBeNull();

    fireEvent.click(screen.getByRole("link", { name: "Court 2, 18:00" }));
    expect(document.querySelector("[data-route-pending]")).not.toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(document.querySelector("[data-route-pending]"), "a navigation that did happen keeps its cue").not.toBeNull();
    const code = Promise.resolve({ default: () => null });
    noteChunk("bookingDetail", code);
    await code;
    await screen.findByRole("link", { name: "Court 2, 18:00" });
    expect(document.querySelector("[data-route-pending]")).toBeNull();
  });

  it("ignores a link off the club's site, a click meant for a new tab, and a click that went nowhere", async () => {
    renderWithLink();
    fireEvent.click(screen.getByRole("link", { name: "Kept by its own handler" }));
    expect(document.querySelector("[data-route-pending]"), "marked at the tap").not.toBeNull();
    await vi.waitFor(() => expect(document.querySelector("[data-route-pending]")).toBeNull());
    fireEvent.click(screen.getByRole("link", { name: "Elsewhere" }));
    fireEvent.click(screen.getByRole("link", { name: "Wallet" }), { metaKey: true });
    expect(document.querySelector("[data-route-pending]")).toBeNull();
  });
});
