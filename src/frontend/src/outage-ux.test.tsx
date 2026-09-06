import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "./App";
import { tokenStore } from "./lib/api";

/**
 * What a member is actually looking at while the club is unreachable.
 *
 * <p>
 * The session-level behaviour — keep the token, retry with backoff, recover without a click — is
 * right and is covered in `lib/resilience.test.tsx`. This file is about the screen in front of
 * that behaviour, which was measured on a live page and was two separate silences:
 * </p>
 *
 * <ul>
 *   <li>the bootstrap showed the literal word "Loading…" at 14px in the top-left corner, identical
 *       at 2s, 6s, 12s and 20.1s against a backend that accepts the connection and never answers.
 *       Twenty seconds of that reads as a broken app;</li>
 *   <li>"Try again now" — the only control the outage screen offers — held one state for 25.3
 *       seconds after being pressed: not disabled, no `aria-busy`, no label change, no spinner.
 *       The member presses the one thing they are given and nothing happens, so they press it
 *       again.</li>
 * </ul>
 *
 * <p>
 * Driven through the real `App` and its real router rather than by rendering the two components
 * directly: what was wrong was which screen `RequireAuth` puts up and what the auth context hands
 * it, and a component rendered on its own cannot be wrong about either.
 * </p>
 *
 * <p>
 * And inside `StrictMode`, because `src/main.tsx` mounts it that way. The first attempt at the
 * pending state guarded its `setRetrying(false)` behind the mounted-ref idiom, which StrictMode's
 * mount → cleanup → mount falsifies before the first paint — the button then read "Trying…",
 * disabled, for the life of the tab. Every test here rendered a bare `<App />` and saw none of it.
 * </p>
 */

afterEach(() => {
  vi.unstubAllGlobals();
  tokenStore.clear();
  window.history.pushState({}, "", "/");
});

/** A fetch that accepts the connection and never answers. */
const hang = () => new Promise<Response>(() => {});

/** A fetch that fails outright — the club is not reachable at all. */
const unreachable = () => Promise.reject(new TypeError("Failed to fetch"));

function renderAppAt(path: string) {
  window.history.pushState({}, "", path);
  return render(<StrictMode><App /></StrictMode>);
}

/** Let real macrotasks and microtasks drain — this file runs on the real clock, not fake timers. */
async function settle(ms = 50) {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

describe("the wait before the app knows whether you are signed in", () => {
  it("says what it is doing and shows something moving, rather than the word Loading", async () => {
    tokenStore.set("member.jwt.value");
    vi.stubGlobal("fetch", vi.fn(hang));

    renderAppAt("/wallet");

    // A live region, because a spinner tells a screen-reader user nothing at all.
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent(/connecting to the club/i);
    expect(screen.getByTestId("boot-splash")).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });
});

describe("the outage screen's only control", () => {
  it("shows it is working while the retry is in flight, and comes back when it is not", async () => {
    tokenStore.set("member.jwt.value");
    // First answer fails fast so the app reaches the outage screen; everything after it hangs, so
    // the retry is still in flight when the assertion runs. That is the case that was broken:
    // against a backend that answers, the button was never pending long enough to notice.
    let first = true;
    vi.stubGlobal("fetch", vi.fn(() => {
      if (first) { first = false; return unreachable(); }
      return hang();
    }));

    renderAppAt("/wallet");

    const button = await screen.findByRole("button", { name: /try again now/i });
    expect(button).not.toBeDisabled();
    expect(button).not.toHaveAttribute("aria-busy", "true");

    fireEvent.click(button);

    await waitFor(() => {
      const busy = screen.getByRole("button", { name: /trying/i });
      expect(busy).toBeDisabled();
      expect(busy).toHaveAttribute("aria-busy", "true");
    });

    // The assertion above is not enough on its own, and a refuter proved it: `waitFor` runs its
    // first check synchronously, so it passes on the render that `setRetrying(true)` caused and
    // never looks again. Replace `return refreshFromToken()` in `retryConnection` with
    // `void refreshFromToken()` — the exact regression this pending state exists to prevent — and
    // the button flicks back to "Try again now" a microtask later while everything above stays
    // green. So: still busy after the clock has actually moved, with the probe still in flight.
    await settle();
    const stillBusy = screen.getByRole("button", { name: /trying/i });
    expect(stillBusy).toBeDisabled();
    expect(stillBusy).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("button", { name: /try again now/i })).not.toBeInTheDocument();
  });
});
