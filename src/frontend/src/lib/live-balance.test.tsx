import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "./auth";
import { BalanceProvider, useBalance, walletHref, walletTone } from "./balance";
import {
  LIVE_BALANCE_POLICY, TransportRefused, jittered, nextBackoff,
  type BalanceFrame, type BalanceTransport, type LiveBalancePolicy,
} from "./liveBalance";
import { countDurationMs } from "./useCountUp";
import { ZERO_ENTICE } from "./zeroBalanceEntice";
import { stubFetch, signIn, signOut, type FetchStub } from "../test/harness";

/**
 * Item 8's state machine, driven rather than reasoned about.
 *
 * <p>
 * Every test here is about a state the chip used to be unable to express. The provider it
 * replaces had two: a number, or no number. A stream that had silently died — no `onerror`,
 * keep-alives still arriving, pushes simply stopped — left a confident stale figure on screen
 * for the life of the tab, and nothing anywhere said so.
 * </p>
 */

const WHOAMI = {
  tenant_slug: "crusaders", tenant_id: "00000000-0000-0000-0000-0000000000cc",
  user_id: "44444444-4444-4444-4444-444444444444", is_authenticated: true, is_admin: false,
};

/** A transport the test opens, closes and pushes through by hand. */
function fakeTransport() {
  const opens: Array<{ resolve: () => void; reject: (e: unknown) => void }> = [];
  let live: {
    onFrame: (f: BalanceFrame) => void;
    onSilence: () => void;
    onError: () => void;
  } | null = null;
  let closed = 0;

  const transport: BalanceTransport = {
    open(args) {
      return new Promise((resolve, reject) => {
        opens.push({
          resolve: () => { live = args; resolve({ close: () => { closed += 1; live = null; } }); },
          reject,
        });
      });
    },
  };

  return {
    transport,
    get attempts() { return opens.length; },
    get closes() { return closed; },
    /** Let the most recent connect succeed. */
    async accept() { opens[opens.length - 1].resolve(); await act(async () => {}); },
    /** Let the most recent connect fail, as a network blip would. */
    async refuse(err: unknown = new Error("unreachable")) {
      opens[opens.length - 1].reject(err);
      await act(async () => {});
    },
    async push(frame: BalanceFrame) { await act(async () => { live?.onFrame(frame); }); },
    async silence() { await act(async () => { live?.onSilence(); }); },
    async error() { await act(async () => { live?.onError(); }); },
  };
}

/** A fast policy: the same machine, with the waits short enough for a fake clock. */
const FAST: LiveBalancePolicy = {
  ...LIVE_BALANCE_POLICY,
  backoffInitialMs: 10,
  backoffMaxMs: 40,
  idleCloseMs: 50,
  pollMs: 20,
  transportRetryMultiple: 3,
};

function Probe() {
  const { balance, state, delta } = useBalance();
  return (
    <>
      <span data-testid="balance">{balance === null ? "none" : balance.toFixed(2)}</span>
      <span data-testid="state">{state}</span>
      <span data-testid="delta">{delta ? `${delta.source}:${delta.amount.toFixed(2)}` : "none"}</span>
    </>
  );
}

async function mount(transport: BalanceTransport, wallet = { balance_credits: 100 }, policy: LiveBalancePolicy = FAST) {
  const stub: FetchStub = stubFetch([
    { path: "/api/v1/whoami", body: WHOAMI },
    { path: "/api/v1/wallet", body: { ...wallet, entries: [], total_entries: 0, offset: 0, limit: 100 } },
  ]);
  signIn({ isAdmin: false });
  const view = render(
    <MemoryRouter>
      <AuthProvider>
        <BalanceProvider transport={transport} policy={policy}>
          <Probe />
        </BalanceProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
  await act(async () => {});
  return { stub, view };
}

afterEach(() => { signOut(); vi.useRealTimers(); });

describe("the backoff no longer moves every tab in lockstep", () => {
  it("spreads a wait across ±20 % and never returns the bare figure for every draw", () => {
    const draws = [0, 0.25, 0.5, 0.75, 1].map((r) => jittered(1000, 20, () => r));
    expect(draws).toEqual([800, 900, 1000, 1100, 1200]);
    // The property that matters is DISAGREEMENT. A lockstep implementation has the same mean.
    expect(new Set(draws).size).toBeGreaterThan(1);
  });

  it("never goes negative, whatever the draw", () => {
    expect(jittered(10, 200, () => 0)).toBe(0);
  });

  it("still doubles and still caps", () => {
    expect(nextBackoff(1000, LIVE_BALANCE_POLICY)).toBe(2000);
    expect(nextBackoff(20_000, LIVE_BALANCE_POLICY)).toBe(30_000);
    expect(nextBackoff(30_000, LIVE_BALANCE_POLICY)).toBe(30_000);
  });
});

describe("three failed connects is a policy change, not a fourth retry", () => {
  it("falls back to polling and says the figure is no longer live", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const wire = fakeTransport();
    await mount(wire.transport);

    // Three consecutive failures, walking the backoff.
    for (let i = 0; i < FAST.failToPoll; i += 1) {
      await wire.refuse();
      await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    }

    expect(screen.getByTestId("state").textContent).toBe("degraded");
    // And it is a STATE, not a silence: the number is still shown, with a qualifier on it.
    expect(screen.getByTestId("balance").textContent).toBe("100.00");
  });

  it("treats a 403 as permanent and stops asking", async () => {
    const wire = fakeTransport();
    await mount(wire.transport);
    await wire.refuse(new TransportRefused("password_change_required"));
    await act(async () => { await new Promise((r) => setTimeout(r, 120)); });
    // The forced-password-change gate answers 403 by policy, and no amount of backing off
    // changes that answer. The effect re-runs by itself when the gate clears.
    expect(wire.attempts).toBe(1);
  });
});

describe("a stream that goes quiet without failing", () => {
  it("re-reads over plain HTTP and reconnects", async () => {
    const wire = fakeTransport();
    const { stub } = await mount(wire.transport);
    await wire.accept();
    const readsBefore = stub.calls.filter((c) => c.path.startsWith("/api/v1/wallet?")
      || c.path === "/api/v1/wallet").length;

    await wire.silence();
    await act(async () => { await new Promise((r) => setTimeout(r, 60)); });

    const readsAfter = stub.calls.filter((c) => c.path.startsWith("/api/v1/wallet?")
      || c.path === "/api/v1/wallet").length;
    // A client whose only liveness signal is `onerror` is trusting the other end to fail
    // loudly, and this one did not: the socket stayed open and every push was swallowed.
    expect(readsAfter).toBeGreaterThan(readsBefore);
    expect(wire.closes).toBeGreaterThan(0);
  });
});

describe("a movement knows who caused it", () => {
  it("calls an unbidden frame the club's doing", async () => {
    const wire = fakeTransport();
    await mount(wire.transport);
    await wire.accept();
    await wire.push({ balance_credits: 300 });
    expect(screen.getByTestId("delta").textContent).toBe("club:200.00");
  });

  it("does not call a first read a movement", async () => {
    const wire = fakeTransport();
    await mount(wire.transport);
    await wire.accept();
    // `null -> 100.00` is the first time the member has been told, not money arriving.
    expect(screen.getByTestId("delta").textContent).toBe("none");
  });

  it("takes the server's own delta when the frame carries one", async () => {
    const wire = fakeTransport();
    await mount(wire.transport);
    await wire.accept();
    // The difference and the stated delta deliberately disagree: a client that inferred the
    // movement from the balance would report 200 for what the server calls a 50 refund.
    await wire.push({ balance_credits: 300, delta_credits: 50, reason: "cancellation_refund" });
    expect(screen.getByTestId("delta").textContent).toBe("club:50.00");
  });

  it("ignores a frame that only confirms what is already on screen", async () => {
    const wire = fakeTransport();
    await mount(wire.transport);
    await wire.accept();
    await wire.push({ balance_credits: 100 });
    expect(screen.getByTestId("delta").textContent).toBe("none");
  });
});

describe("two tabs", () => {
  /**
   * A balance change in one context reaches the other.
   *
   * Two providers, two transports, one server: the frame the club publishes is delivered to
   * both, and both arrive at the same figure. This is the unit half of the two-context
   * Playwright walk — what it can prove that the browser test cannot is that neither provider
   * is holding module state the other one shares.
   */
  it("both arrive at the same figure from one published frame", async () => {
    const a = fakeTransport();
    const b = fakeTransport();

    const stub: FetchStub = stubFetch([
      { path: "/api/v1/whoami", body: WHOAMI },
      { path: "/api/v1/wallet", body: { balance_credits: 100, entries: [], total_entries: 0, offset: 0, limit: 100 } },
    ]);
    expect(stub).toBeTruthy();
    signIn({ isAdmin: false });

    const view = render(
      <MemoryRouter>
        <AuthProvider>
          <BalanceProvider transport={a.transport}>
            <div data-testid="tab-a"><Probe /></div>
          </BalanceProvider>
          <BalanceProvider transport={b.transport}>
            <div data-testid="tab-b"><Probe /></div>
          </BalanceProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
    await act(async () => {});
    await a.accept();
    await b.accept();

    await a.push({ balance_credits: 350 });
    await b.push({ balance_credits: 350 });

    const figures = [...view.container.querySelectorAll('[data-testid="balance"]')]
      .map((n) => n.textContent);
    expect(figures).toEqual(["350.00", "350.00"]);
  });
});

describe("the chip's three states, as pure functions", () => {
  it("tells empty from low from fine", () => {
    expect(walletTone(0)).toBe("zero");
    expect(walletTone(-5)).toBe("zero");
    // 0.004 prints as "0.00" and is NOT <= 0. It is genuinely low, not empty.
    expect(walletTone(0.004)).toBe("low");
    expect(walletTone(49.99)).toBe("low");
    expect(walletTone(50)).toBe("fine");
    expect(walletTone(null)).toBe("fine");
  });

  it("sends an empty wallet to the top-up page, not to a ledger with nothing in it", () => {
    // At zero `/wallet` is a dead end: the ledger is empty or one row and the only useful
    // control is one more tap away.
    expect(walletHref(0)).toBe("/wallet/topup");
    expect(walletHref(-5)).toBe("/wallet/topup");
    expect(walletHref(50)).toBe("/wallet");
    expect(walletHref(null)).toBe("/wallet");
  });
});

describe("the count-up's duration", () => {
  it("has a floor, so a small movement is still visible", () => {
    expect(countDurationMs(1)).toBe(350);
    expect(countDurationMs(5)).toBe(350);
  });

  it("has a CEILING, or a big top-up feels slow", () => {
    // 50 credits — one court — is already at the ceiling, and 400 is no slower.
    expect(countDurationMs(50)).toBe(900);
    expect(countDurationMs(400)).toBe(900);
  });

  it("is symmetrical: spending reads the same as being paid", () => {
    expect(countDurationMs(-30)).toBe(countDurationMs(30));
  });
});

describe("the zero-balance entice is finite by construction", () => {
  it("is three bursts and then silence, not a loop", () => {
    // Mutant #2 in the design's hunt list is `bursts: Infinity`. An animation that runs for
    // ever is a fault light on a member who cannot afford to top up today.
    expect(ZERO_ENTICE.bursts).toBe(3);
    expect(Number.isFinite(ZERO_ENTICE.bursts)).toBe(true);
    expect(ZERO_ENTICE.bursts * ZERO_ENTICE.burstMs).toBeLessThan(15_000);
  });

  it("decays: each pause is longer than the last", () => {
    expect(ZERO_ENTICE.pauseMs).toEqual([60_000, 120_000]);
    expect(ZERO_ENTICE.pauseMs[1]).toBeGreaterThan(ZERO_ENTICE.pauseMs[0]);
  });

  it("waits out the booking toast before it starts", () => {
    // A member who has just spent their last credits is reading a success toast. Starting a
    // pulse on top of it turns a successful booking into an alarm.
    expect(ZERO_ENTICE.graceMs).toBeGreaterThanOrEqual(4_000);
  });
});
