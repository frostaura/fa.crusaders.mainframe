import { StrictMode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { REQUEST_TIMEOUT_MS, tokenStore } from "./lib/api";

describe("App", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify({ tenant_slug: "crusaders", tenant_id: "00000000-0000-0000-0000-000000000000", user_id: null, is_authenticated: false, is_admin: false })),
        } as unknown as Response)
      )
    );
    localStorage.clear();
  });

  /**
   * The heading is the CLUB's name, not the software's. An anonymous visitor at / is a squash
   * player looking for their club; "Crusaders Mainframe" is what FrostAura calls the product
   * they happen to be using, and it was the largest text on the page.
   */
  it("renders the club name as the heading for an anonymous visitor", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: /Crusaders Squash/i, level: 1 })).toBeInTheDocument();
  });
});

/**
 * What is on screen while the club is not answering.
 *
 * <p>
 * Two things sat in front of the outage screen and neither said anything. The bootstrap
 * state was the literal word <code>Loading…</code> at 14px in the top-left corner, and
 * against a backend that accepts the socket and never replies it stayed exactly that for
 * the whole 20-second request budget: no spinner, no explanation, nothing clickable.
 * And the outage screen's <b>Try again now</b> — the only control it offers — had no
 * pending state at all, so pressing it produced one unchanging button for 25 seconds.
 * </p>
 *
 * <p>
 * The 20s ceiling itself is deliberate and stays. The defect is the silence, so these
 * tests are about what the screen says, not about how long it waits.
 * </p>
 *
 * <p>
 * <b>Rendered inside <code>StrictMode</code>, as <code>src/main.tsx</code> renders it.</b> That is
 * not decoration. The first fix for the retry button guarded its <code>setRetrying(false)</code>
 * behind a <code>useRef(true)</code> flipped by a cleanup-only effect — the mounted-ref idiom —
 * and under StrictMode's mount → cleanup → mount that ref is <code>false</code> from the very
 * first mount, so the button read <code>Trying…</code>, disabled, for the life of the tab.
 * Measured dead at +120s on a dev server. This file rendered a bare <code>&lt;App /&gt;</code>
 * and could not see any of it. A component-lifecycle defect is invisible to a test that does not
 * reproduce the lifecycle the product runs, so these render the tree the way the entry point does.
 * </p>
 */
describe("App — while the club does not answer", () => {
  /** As `src/main.tsx` mounts it: double-invoked effects and all. */
  const renderApp = () => render(<StrictMode><App /></StrictMode>);

  /** Accepts the connection and never replies, honouring `signal` as the real fetch does. */
  function stallingFetch() {
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })));
  }

  async function tick(ms: number) {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    tokenStore.set("member.jwt.value");
    stallingFetch();
    window.history.pushState({}, "", "/wallet");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    tokenStore.clear();
    window.history.pushState({}, "", "/");
  });

  it("narrates the wait instead of showing one static word", async () => {
    renderApp();
    await tick(2_000);

    // Announced, so a screen reader is told there is a wait at all.
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByText("Connecting to the club…")).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();

    // …and it says more once the wait stops being ordinary.
    await tick(5_000);
    expect(screen.getByText(/taking longer than usual/)).toBeInTheDocument();
  });

  it("shows the retry working, rather than looking ignored for twenty seconds", async () => {
    renderApp();

    // Past the request budget: the outage screen, which is the good half of round 1.
    // Everything here is driven by explicit ticks — `waitFor` and `findBy*` poll on the
    // real clock, which under fake timers never advances and simply times the test out.
    await tick(REQUEST_TIMEOUT_MS + 1_000);
    expect(screen.getByText("Can't reach the club right now")).toBeInTheDocument();

    const button = screen.getByRole("button", { name: "Try again now" });
    expect(button).toHaveAttribute("aria-busy", "false");

    fireEvent.click(button);
    await tick(1_500);

    // The measured failure was one unchanging button state for 25.3s: same label, enabled,
    // no aria-busy. All three have to move, and stay moved while the probe is in flight.
    const busy = screen.getByRole("button", { name: /Trying…/ });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("button", { name: "Try again now" })).not.toBeInTheDocument();

    // And it comes back when the attempt is over, so it can be pressed again. This is the
    // assertion the StrictMode wrapper above exists for: a mounted-ref guard round the
    // `setRetrying(false)` passes every line before this one and then never reaches this one,
    // because StrictMode's extra unmount has already flipped the ref.
    await tick(REQUEST_TIMEOUT_MS + 1_000);
    const settled = screen.getByRole("button", { name: "Try again now" });
    expect(settled).not.toBeDisabled();
    expect(settled).toHaveAttribute("aria-busy", "false");
  });
});
