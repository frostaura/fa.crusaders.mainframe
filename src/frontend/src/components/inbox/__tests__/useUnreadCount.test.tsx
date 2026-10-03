import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { playersEndpoints } from "@/lib/playersApi";
import { POLL_MS, readUnread, resetUnread, useUnreadCount, useUnreadCountDriver } from "../useUnreadCount";

/**
 * The shared unread count, driven rather than reasoned about: the stream frame outranks a read,
 * the poll runs only while the stream is NOT live and never in a hidden tab, and a failed read
 * says nothing at all.
 */

const balance = vi.hoisted(() => ({
  unreadCount: null as number | null,
  state: "loading" as "loading" | "live" | "degraded" | "unavailable",
  noteUnread: vi.fn(),
}));
const auth = vi.hoisted(() => ({ status: "authenticated", mustChangePassword: false, userId: "member-a" }));

vi.mock("@/lib/useBalance", () => ({ useBalance: () => balance }));
vi.mock("@/lib/useAuth", () => ({ useAuth: () => auth }));

function Probe({ drive = true }: { drive?: boolean }) {
  return drive ? <Driven /> : <Reader />;
}
function Driven() {
  useUnreadCountDriver();
  return <Reader />;
}
function Reader() {
  const { count, set } = useUnreadCount();
  return (
    <>
      <output data-testid="count">{count === null ? "none" : String(count)}</output>
      <button onClick={() => set(7)}>set</button>
    </>
  );
}

let hidden = false;
function setHidden(value: boolean) {
  hidden = value;
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  hidden = false;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => (hidden ? "hidden" : "visible"));
  Object.assign(balance, { unreadCount: null, state: "loading" });
  balance.noteUnread.mockReset();
  Object.assign(auth, { status: "authenticated", mustChangePassword: false, userId: "member-a" });
  resetUnread();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const count = () => screen.getByTestId("count").textContent;
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("the unread count store", () => {
  it("D2 — re-reads, and forgets the last member's figure, when a sign-in changes who is signed in", async () => {
    const spy = vi.spyOn(playersEndpoints, "unreadCount").mockResolvedValueOnce({ unread_count: 3 });
    const view = render(<Probe />);
    await flush();
    expect(count()).toBe("3");

    const next = deferred<{ unread_count: number }>();
    spy.mockReturnValueOnce(next.promise);
    auth.userId = "member-b";
    view.rerender(<Probe />);
    await flush();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(count()).toBe("none");
    await act(async () => { next.resolve({ unread_count: 9 }); await next.promise; });
    expect(count()).toBe("9");
  });

  it("reads once when a session starts", async () => {
    const spy = vi.spyOn(playersEndpoints, "unreadCount").mockResolvedValue({ unread_count: 3 });
    render(<Probe />);
    await flush();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(count()).toBe("3");
  });

  it("does not read for a signed-out tab", async () => {
    auth.status = "anonymous";
    const spy = vi.spyOn(playersEndpoints, "unreadCount").mockResolvedValue({ unread_count: 3 });
    render(<Probe />);
    await flush();
    expect(spy).not.toHaveBeenCalled();
    expect(count()).toBe("none");
  });

  it("takes the stream's frame, and a read that was already out cannot overwrite it", async () => {
    const out = deferred<{ unread_count: number }>();
    vi.spyOn(playersEndpoints, "unreadCount").mockReturnValue(out.promise);
    const view = render(<Probe />);
    await flush();

    balance.unreadCount = 5;
    view.rerender(<Probe />);
    await flush();
    expect(count()).toBe("5");

    // The older read answers late with an older figure: the frame stands.
    out.resolve({ unread_count: 2 });
    await flush();
    expect(count()).toBe("5");
  });

  it("never polls while the stream is live", async () => {
    balance.state = "live";
    const spy = vi.spyOn(playersEndpoints, "unreadCount").mockResolvedValue({ unread_count: 1 });
    render(<Probe />);
    await flush();
    await act(async () => { vi.advanceTimersByTime(POLL_MS * 5); });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("polls every minute while the stream is degraded, and stops when it comes back", async () => {
    balance.state = "degraded";
    const spy = vi.spyOn(playersEndpoints, "unreadCount").mockResolvedValue({ unread_count: 1 });
    const view = render(<Probe />);
    await flush();
    await act(async () => { vi.advanceTimersByTime(POLL_MS); });
    await act(async () => { vi.advanceTimersByTime(POLL_MS); });
    expect(spy).toHaveBeenCalledTimes(3);

    balance.state = "live";
    view.rerender(<Probe />);
    await act(async () => { vi.advanceTimersByTime(POLL_MS * 3); });
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("polls while unavailable too, but not in a hidden tab — and reads on the way back", async () => {
    balance.state = "unavailable";
    const spy = vi.spyOn(playersEndpoints, "unreadCount").mockResolvedValue({ unread_count: 4 });
    render(<Probe />);
    await flush();
    expect(spy).toHaveBeenCalledTimes(1);

    act(() => setHidden(true));
    await act(async () => { vi.advanceTimersByTime(POLL_MS * 3); });
    expect(spy).toHaveBeenCalledTimes(1);

    act(() => setHidden(false));
    await flush();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("keeps silent on a failed read — no figure, no throw — and the next read still lands", async () => {
    const spy = vi.spyOn(playersEndpoints, "unreadCount").mockRejectedValueOnce(new Error("offline"));
    spy.mockResolvedValueOnce({ unread_count: 6 });
    balance.state = "degraded";
    render(<Probe />);
    await flush();
    expect(count()).toBe("none");
    await act(async () => { vi.advanceTimersByTime(POLL_MS); });
    await flush();
    expect(count()).toBe("6");
  });

  it("keeps the last figure through a failed re-read", async () => {
    const spy = vi.spyOn(playersEndpoints, "unreadCount").mockResolvedValueOnce({ unread_count: 2 });
    spy.mockRejectedValueOnce(new Error("offline"));
    balance.state = "degraded";
    render(<Probe />);
    await flush();
    await act(async () => { vi.advanceTimersByTime(POLL_MS); });
    await flush();
    expect(count()).toBe("2");
  });

  it("shares one request between callers while it is out", async () => {
    const out = deferred<{ unread_count: number }>();
    const spy = vi.spyOn(playersEndpoints, "unreadCount").mockReturnValue(out.promise);
    render(<Probe drive={false} />);
    void readUnread();
    void readUnread();
    expect(spy).toHaveBeenCalledTimes(1);
    out.resolve({ unread_count: 1 });
    await flush();
    expect(count()).toBe("1");
  });

  it("echoes a local figure into the stream's last figure, so the next frame is a change", async () => {
    vi.spyOn(playersEndpoints, "unreadCount").mockResolvedValue({ unread_count: 3 });
    render(<Probe />);
    await flush();
    act(() => screen.getByRole("button", { name: "set" }).click());
    expect(count()).toBe("7");
    expect(balance.noteUnread).toHaveBeenCalledWith(7);
  });
});
