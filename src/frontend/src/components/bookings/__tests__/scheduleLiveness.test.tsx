import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { OWN_WRITE_MS, STALE_MS, useScheduleLiveness } from "../useScheduleLiveness";

/**
 * R4 M4-3 — a partner's Bookings page stayed stale after the organiser cancelled: it re-read only
 * after its own writes. It now re-reads when the wallet stream moves and when it comes back into
 * view with an old read — and not on the echo of its own write.
 */
const wallet = vi.hoisted(() => ({ balance: null as number | null, unreadCount: null as number | null }));
vi.mock("@/lib/balance", () => ({ useBalance: () => wallet }));

let visibility: DocumentVisibilityState = "visible";
Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });

afterEach(() => { wallet.balance = null; wallet.unreadCount = null; visibility = "visible"; vi.useRealTimers(); });

function Probe({ readAt, reread, onWrote }: { readAt: number | null; reread: () => void; onWrote?: (w: () => void) => void }) {
  const { wrote } = useScheduleLiveness(readAt, reread);
  onWrote?.(wrote);
  return null;
}

function mount(readAt: number | null) {
  const reread = vi.fn();
  let wrote: () => void = () => undefined;
  const view = render(<Probe readAt={readAt} reread={reread} onWrote={(w) => { wrote = w; }} />);
  const again = (at: number | null = readAt) => view.rerender(<Probe readAt={at} reread={reread} onWrote={(w) => { wrote = w; }} />);
  return { reread, again, wrote: () => wrote() };
}

describe("useScheduleLiveness — the wallet stream", () => {
  it("ignores the wallet's first figures, and re-reads when the inbox or the balance moves", () => {
    const { reread, again } = mount(Date.now());
    wallet.balance = 500; wallet.unreadCount = 0; again();
    expect(reread).not.toHaveBeenCalled();
    // The organiser cancelled: a notice reaches this member.
    wallet.unreadCount = 1; again();
    expect(reread).toHaveBeenCalledTimes(1);
    wallet.balance = 525; again();
    expect(reread).toHaveBeenCalledTimes(2);
  });

  it("does not re-read the echo of the page's own write", () => {
    const { reread, again, wrote } = mount(Date.now());
    wallet.balance = 500; again();
    wrote();
    wallet.balance = 450; again();
    expect(reread).not.toHaveBeenCalled();
    expect(OWN_WRITE_MS).toBeGreaterThan(0);
  });
});

describe("useScheduleLiveness — back into view", () => {
  function flip(state: DocumentVisibilityState) {
    act(() => { visibility = state; document.dispatchEvent(new Event("visibilitychange")); });
  }

  it("re-reads a stale page when it comes back, and leaves a fresh one alone", () => {
    const old = mount(Date.now() - STALE_MS - 1_000);
    flip("hidden"); flip("visible");
    expect(old.reread).toHaveBeenCalledTimes(1);
  });

  it("leaves a fresh read alone", () => {
    const fresh = mount(Date.now());
    flip("hidden"); flip("visible");
    expect(fresh.reread).not.toHaveBeenCalled();
  });
});
