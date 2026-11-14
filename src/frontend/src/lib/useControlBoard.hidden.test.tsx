import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { signIn, stubFetch } from "../test/harness";
import { boardFixture } from "../test/monitoringFixtures";
import { useControlBoard } from "./useControlBoard";

/**
 * BA-14, the console's half: an open stream per hidden tab held one of the browser's six
 * HTTP/1.1 connections to the club, and the console's ordinary reads queued behind them for
 * 12 s. A hidden tab parks its stream; showing it again reconnects.
 */

const opened: { url: string; closed: boolean }[] = [];
class SpyEventSource {
  url: string; onopen: (() => void) | null = null; onerror: (() => void) | null = null;
  private record: { url: string; closed: boolean };
  constructor(url: string) { this.url = url; this.record = { url, closed: false }; opened.push(this.record); }
  addEventListener() { /* frames are not the point here */ }
  removeEventListener() { /* nothing */ }
  close() { this.record.closed = true; }
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

afterEach(() => { setVisibility("visible"); vi.unstubAllGlobals(); opened.length = 0; });

describe("the control board's stream and a hidden tab", () => {
  it("closes the stream while the tab is hidden and opens a fresh one when it is shown", async () => {
    signIn({ isAdmin: true });
    vi.stubGlobal("EventSource", SpyEventSource);
    stubFetch([
      { path: "/api/v1/admin/control-board", body: boardFixture() },
      { method: "POST", path: "/api/v1/admin/control-board/stream-ticket", body: { ticket: "t1" } },
    ]);
    renderHook(() => useControlBoard());
    await waitFor(() => expect(opened).toHaveLength(1));
    expect(opened[0].closed).toBe(false);

    act(() => setVisibility("hidden"));
    await waitFor(() => expect(opened[0].closed).toBe(true));
    expect(opened).toHaveLength(1);

    act(() => setVisibility("visible"));
    await waitFor(() => expect(opened).toHaveLength(2));
    expect(opened[1].closed).toBe(false);
  });
});
