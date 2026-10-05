import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { URL_TEXT_DELAY_MS, useUrlText } from "./useUrlText";

/**
 * R15 L15-2 — a URL-bound text field keeps what was typed and writes the URL once typing pauses.
 * The browser race it closes is `e2e/url-search-r15.spec.ts` (keys at 30/80 ms under a phone's CPU);
 * these hold the hook's own rules.
 */
describe("useUrlText (R15 L15-2)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function field(initial: string) {
    const writes: string[] = [];
    const hook = renderHook(({ url }) => useUrlText(url, (next) => writes.push(next)), { initialProps: { url: initial } });
    return { hook, writes, type: (text: string) => act(() => { hook.result.current[1](text); }) };
  }

  it("takes every key at once and writes the URL once, after the pause", () => {
    const { hook, writes, type } = field("");
    for (let i = 1; i <= "bartholomew".length; i++) {
      type("bartholomew".slice(0, i));
      act(() => { vi.advanceTimersByTime(80); });
    }
    expect(hook.result.current[0]).toBe("bartholomew");
    expect(writes).toEqual([]);
    act(() => { vi.advanceTimersByTime(URL_TEXT_DELAY_MS); });
    expect(writes).toEqual(["bartholomew"]);
  });

  it("does not take its own echo back over keys typed since the write", () => {
    const { hook, writes, type } = field("");
    type("bart");
    act(() => { vi.advanceTimersByTime(URL_TEXT_DELAY_MS); });
    expect(writes).toEqual(["bart"]);
    type("barth");
    hook.rerender({ url: "bart" }); // the router commits the write a key late
    expect(hook.result.current[0]).toBe("barth");
    act(() => { vi.advanceTimersByTime(URL_TEXT_DELAY_MS); });
    expect(writes).toEqual(["bart", "barth"]);
  });

  it("adopts a URL moved by anything else, and drops the write that would undo it", () => {
    const { hook, writes, type } = field("owen");
    type("owe");
    hook.rerender({ url: "" }); // "Clear filters", or Back
    expect(hook.result.current[0]).toBe("");
    act(() => { vi.advanceTimersByTime(URL_TEXT_DELAY_MS * 2); });
    expect(writes).toEqual([]);
  });

  it("writes nothing when the text is typed back to what the URL already says", () => {
    const { writes, type } = field("mia");
    type("mi");
    type("mia");
    act(() => { vi.advanceTimersByTime(URL_TEXT_DELAY_MS); });
    expect(writes).toEqual([]);
  });

  it("writes nothing after it has gone", () => {
    const { hook, writes, type } = field("");
    type("b");
    hook.unmount();
    act(() => { vi.advanceTimersByTime(URL_TEXT_DELAY_MS); });
    expect(writes).toEqual([]);
  });
});
