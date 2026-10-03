import { afterEach, describe, expect, it, vi } from "vitest";
import { stubFetch } from "./harness";

/**
 * `StubRoute.sequence` answers the nth call (the last repeating). A route carrying only a
 * `sequence` was refused as "has neither body nor respond" (R10, reported by FB10), so its
 * documented use — 402 then 200 — needed a `respond` workaround.
 */
afterEach(() => { vi.unstubAllGlobals(); });

describe("stubFetch — a route answered by sequence alone", () => {
  it("serves each entry in turn, then repeats the last", async () => {
    stubFetch([{ path: "/api/v1/x", sequence: [{ n: 1 }, { n: 2 }] }]);
    const read = async () => (await fetch("/api/v1/x")).json();
    expect(await read()).toEqual({ n: 1 });
    expect(await read()).toEqual({ n: 2 });
    expect(await read()).toEqual({ n: 2 });
  });
});
