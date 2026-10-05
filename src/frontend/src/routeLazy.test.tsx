import { Suspense, createElement, lazy } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { arrivedChunk, noteChunk, routeChunks, routeLazy } from "./routeChunks";

/**
 * R14 PERF — the first Wallet tap of a session showed the route skeleton for 310–318 ms although the
 * tab bar had already fetched Wallet's code: `lazy(routeChunks.wallet)` re-imported the module,
 * suspended once on that promise, and React holds a fallback it has shown for at least 300 ms.
 * A member tab page whose module has arrived by any path now mounts in the same commit.
 */
const Page = () => <h1>the page</h1>;

function mount(component: ReturnType<typeof lazy>) {
  render(<Suspense fallback={<p>the skeleton</p>}>{createElement(component)}</Suspense>);
}

describe("routeLazy — a prefetched member page never suspends", () => {
  it.each(["wallet", "schedule", "profile", "inbox", "invites", "bookingDetail"] as const)("%s, once a prefetch has brought it", async (name) => {
    const module = { default: Page };
    vi.spyOn(routeChunks, name).mockImplementation(() => noteChunk(name, Promise.resolve(module)));
    await routeChunks[name]();  // the tab bar's idle prefetch
    await Promise.resolve();
    expect(arrivedChunk(name)).toBe(module);

    mount(routeLazy(name));
    // Synchronously — no fallback commit, so React has no shown skeleton to hold.
    expect(screen.getByRole("heading", { name: "the page" })).toBeInTheDocument();
    expect(screen.queryByText("the skeleton")).toBeNull();
    vi.restoreAllMocks();
  });

  it("(the mechanism) a plain lazy of the same arrived module suspends once", async () => {
    const ready = Promise.resolve({ default: Page });
    await ready;
    mount(lazy(() => ready));
    expect(screen.getByText("the skeleton")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "the page" })).toBeInTheDocument();
  });
});
