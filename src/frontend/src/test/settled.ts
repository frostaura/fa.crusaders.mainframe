import { act } from "@testing-library/react";
import { vi, type TestAPI } from "vitest";

/**
 * FM-7: a test that ends while the house providers' reads (the session, the wallet, the bell) are
 * still on their way leaves their state updates to land after its last line — outside act, so React
 * warns, and the warning is noise that hides the ordering bugs act() is there to surface. An
 * afterEach cannot catch them (they land between the test's end and its hooks), so the TEST waits:
 * a few turns of the event loop inside act, after its own last assertion.
 */
export async function settle(turns = 4): Promise<void> {
  await act(async () => {
    for (let i = 0; i < turns; i++) {
      // A test still on fake timers would wait for ever on a real setTimeout.
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
      else await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  });
}

type Body = () => unknown;

/**
 * `it`, but every test settles the screen it drew before it ends. A file opts in with
 * `const it = settledIt(vitestIt)`; `.each`, `.skip` and the rest are the original's.
 */
export function settledIt(base: TestAPI): TestAPI {
  const wrapped = (name: string, fn?: Body, timeout?: number) =>
    base(name, fn ? async () => { await fn(); await settle(); } : undefined, timeout);
  // A Proxy, not Object.assign: vitest's `.each` and friends read their own `this`.
  return new Proxy(wrapped, {
    get(_target, key) {
      const value = Reflect.get(base, key, base) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(base) : value;
    },
  }) as unknown as TestAPI;
}
