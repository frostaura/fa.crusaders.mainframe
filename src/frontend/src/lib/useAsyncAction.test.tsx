import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { useAsyncAction } from "./useAsyncAction";
import { ToastProvider } from "../components/Toast";
import { NetworkError } from "./api";
import { motion } from "./tokens";

const HOLD = Number.parseInt(motion.duration.hold, 10);
const strict = { reactStrictMode: true };

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

afterEach(() => vi.useRealTimers());

describe("useAsyncAction", () => {
  it("is pending while the work runs, then success", async () => {
    const work = deferred<string>();
    const { result } = renderHook(() => useAsyncAction(() => work.promise), strict);
    expect(result.current.status).toBe("idle");

    let outcome!: Promise<unknown>;
    act(() => { outcome = result.current.run(); });
    expect(result.current.pending).toBe(true);
    expect(result.current.status).toBe("pending");

    await act(async () => { work.resolve("booked"); await outcome; });
    expect(result.current.pending).toBe(false);
    expect(result.current.status).toBe("success");
    await expect(outcome).resolves.toEqual({ ok: true, value: "booked" });
  });

  it("ignores a second run while the first is in flight — a double tap books once", async () => {
    const work = deferred<void>();
    const fn = vi.fn(() => work.promise);
    const { result } = renderHook(() => useAsyncAction(fn));

    let first!: Promise<unknown>;
    let second!: Promise<unknown>;
    act(() => { first = result.current.run(); second = result.current.run(); });
    await expect(second).resolves.toEqual({ ok: false, error: undefined, skipped: true });
    await act(async () => { work.resolve(); await first; });
    expect(fn).toHaveBeenCalledOnce();

    // …and it runs again once the first has settled.
    await act(async () => { await result.current.run(); });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("captures an error as an outcome instead of throwing it", async () => {
    const boom = new Error("refused");
    const { result } = renderHook(() => useAsyncAction(async () => { throw boom; }));
    let outcome: unknown;
    await act(async () => { outcome = await result.current.run(); });
    expect(outcome).toEqual({ ok: false, error: boom, skipped: false });
    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe(boom);

    act(() => result.current.reset());
    expect(result.current.status).toBe("idle");
    expect(result.current.error).toBeNull();
  });

  it("treats a synchronous throw the same as a rejection", async () => {
    const { result } = renderHook(() => useAsyncAction((): number => { throw new Error("sync"); }));
    let outcome: { ok: boolean } | undefined;
    await act(async () => { outcome = await result.current.run(); });
    expect(outcome?.ok).toBe(false);
    expect(result.current.status).toBe("error");
  });

  it("applies optimistically before the work and rolls back only on failure", async () => {
    const order: string[] = [];
    const optimistic = {
      apply: (id: number) => order.push(`apply ${id}`),
      rollback: (id: number) => order.push(`rollback ${id}`),
    };
    let fail = true;
    const { result } = renderHook(() => useAsyncAction(async (id: number) => {
      order.push(`work ${id}`);
      if (fail) throw new Error("no");
      return id;
    }, { optimistic }));

    await act(async () => { await result.current.run(7); });
    expect(order).toEqual(["apply 7", "work 7", "rollback 7"]);

    order.length = 0;
    fail = false;
    await act(async () => { await result.current.run(8); });
    expect(order).toEqual(["apply 8", "work 8"]);
  });

  it("calls success and failure callbacks with the outcome and the arguments", async () => {
    const success = vi.fn();
    const failure = vi.fn();
    const { result } = renderHook(() => useAsyncAction(async (n: number) => {
      if (n < 0) throw new Error("negative");
      return n * 2;
    }, { success, failure }));
    await act(async () => { await result.current.run(3); });
    expect(success).toHaveBeenCalledWith(6, 3);
    await act(async () => { await result.current.run(-1); });
    expect(failure).toHaveBeenCalledWith(expect.any(Error), -1);
  });

  it("does not let a throwing callback turn a success into a thrown error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result } = renderHook(() => useAsyncAction(async () => 1, { success: () => { throw new Error("bad callback"); } }));
    let outcome: unknown;
    await act(async () => { outcome = await result.current.run(); });
    expect(outcome).toEqual({ ok: true, value: 1 });
    expect(result.current.status).toBe("success");
    spy.mockRestore();
  });

  it("holds success for motion.duration.hold, then returns to idle", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useAsyncAction(async () => "ok"), strict);
    await act(async () => { await result.current.run(); });
    expect(result.current.status).toBe("success");

    act(() => { vi.advanceTimersByTime(HOLD - 1); });
    expect(result.current.status, "reading time, not motion").toBe("success");
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current.status).toBe("idle");
  });

  it("keeps an error until the next run or a reset — the sentence must not vanish mid-read", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useAsyncAction(async () => { throw new Error("x"); }));
    await act(async () => { await result.current.run(); });
    act(() => { vi.advanceTimersByTime(HOLD * 3); });
    expect(result.current.status).toBe("error");
  });

  it("toasts a failure through the existing Toast system, in the product's own sentence", async () => {
    const wrapper = ({ children }: { children: ReactNode }) => <ToastProvider>{children}</ToastProvider>;
    const { result } = renderHook(() => useAsyncAction(async () => { throw new NetworkError("unreachable"); }, {
      toast: { action: "book the court", unchanged: true },
    }), { wrapper });
    await act(async () => { await result.current.run(); });
    const toast = screen.getByRole("status");
    expect(toast).toHaveTextContent(/Couldn't book the court/);
    expect(toast).toHaveTextContent("Nothing changed.");
  });

  it("toasts a success only when given the words", async () => {
    const wrapper = ({ children }: { children: ReactNode }) => <ToastProvider>{children}</ToastProvider>;
    const { result } = renderHook(() => useAsyncAction(async () => 3, {
      toast: { success: (n) => `Booked ${n} slots.` },
    }), { wrapper });
    await act(async () => { await result.current.run(); });
    expect(screen.getByRole("status")).toHaveTextContent("Booked 3 slots.");
  });

  it("works without a ToastProvider when no toast is asked for", async () => {
    const { result } = renderHook(() => useAsyncAction(async () => 1, { toast: { success: "Saved." } }));
    await act(async () => { await result.current.run(); });
    expect(result.current.status).toBe("success");
  });
});
