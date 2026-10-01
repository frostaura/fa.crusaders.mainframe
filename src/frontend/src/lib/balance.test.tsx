import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { STREAM_SILENCE_MS, tokenStore } from "./api";
import { AuthProvider } from "./auth";
import { BalanceProvider } from "./balance";
import { stubFetch, type FetchStub } from "../test/harness";

/**
 * The live balance, when the stream stops carrying anything.
 *
 * <p>
 * Three finders reported the same thing independently: a member's balance updates for the
 * first few seconds of a page's life and then freezes until they reload. The server half of
 * that is fixed where it belongs (see <code>WalletStreamPumpTests</code>), but the client
 * half is its own defect — the only liveness signal it had was <code>onerror</code>, and the
 * failure it needed to survive produced no error at all. The socket stayed open, the
 * keep-alives kept coming, and the pushes simply stopped; there was nothing for the
 * reconnect to react to, so a stale figure sat on screen for the life of the tab.
 * </p>
 *
 * <p>
 * The keep-alive is a named <code>ping</code> event now rather than an SSE comment, which is
 * what makes silence observable from the browser at all. These tests drive the clock rather
 * than the network: what matters is what the provider does when nothing arrives.
 * </p>
 */

/** An EventSource jsdom does not have, controllable from the test. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onopen: ((e: Event) => void) | null = null;
  closed = false;
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor(public url: string) { FakeEventSource.instances.push(this); }

  addEventListener(type: string, fn: () => void) {
    const set = this.listeners.get(type) ?? new Set<() => void>();
    set.add(fn);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, fn: () => void) { this.listeners.get(type)?.delete(fn); }

  close() { this.closed = true; }

  /** The server's keep-alive: proves the stream is alive, carries no balance. */
  ping() { for (const fn of this.listeners.get("ping") ?? []) fn(); }

  /** A balance push. */
  push(balanceCredits: number) {
    this.onmessage?.({ data: JSON.stringify({ balance_minutes: balanceCredits }) } as MessageEvent);
  }
}

const WHOAMI = {
  tenant_slug: "crusaders", tenant_id: "00000000-0000-0000-0000-0000000000cc",
  user_id: "44444444-4444-4444-4444-444444444444", is_authenticated: true, is_admin: false,
};

const WALLET = { balance_minutes: 450, entries: [], total_entries: 0, offset: 0, limit: 100 };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  tokenStore.clear();
  FakeEventSource.instances = [];
});

function renderBalance() {
  return render(
    <MemoryRouter>
      <AuthProvider><BalanceProvider><span data-testid="ok" /></BalanceProvider></AuthProvider>
    </MemoryRouter>,
  );
}

/** Lets mount, whoami, the first wallet read and the ticket POST all settle. */
async function settle(ms = 50) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

function walletReads(stub: FetchStub) {
  return stub.calls.filter((c) => c.method === "GET" && c.path.startsWith("/api/v1/wallet")).length;
}

function ticketCalls(stub: FetchStub) {
  return stub.calls.filter((c) => c.path === "/api/v1/wallet/stream-ticket").length;
}

describe("a stream that goes quiet without failing", () => {
  it("is dropped, re-read over HTTP and reopened", async () => {
    vi.useFakeTimers();
    tokenStore.set("member.jwt.value");
    vi.stubGlobal("EventSource", FakeEventSource);
    const stub = stubFetch([
      { method: "GET", path: "/api/v1/whoami", body: WHOAMI },
      { method: "GET", path: "/api/v1/wallet", body: WALLET },
      {
        method: "POST", path: "/api/v1/wallet/stream-ticket", body: null,
        sequence: [
          { ticket: "ticket-one", expires_in_seconds: 60 },
          { ticket: "ticket-two", expires_in_seconds: 60 },
        ],
      },
    ]);

    renderBalance();
    await settle();
    expect(FakeEventSource.instances).toHaveLength(1);
    const first = FakeEventSource.instances[0];
    const readsBefore = walletReads(stub);

    // Nothing at all arrives — no push, no keep-alive — for longer than two keep-alives.
    await settle(STREAM_SILENCE_MS + 2_000);

    expect(first.closed).toBe(true);
    expect(walletReads(stub)).toBeGreaterThan(readsBefore);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1].url).toContain("ticket=ticket-two");
  });

  it("stays open as long as keep-alives keep arriving", async () => {
    vi.useFakeTimers();
    tokenStore.set("member.jwt.value");
    vi.stubGlobal("EventSource", FakeEventSource);
    stubFetch([
      { method: "GET", path: "/api/v1/whoami", body: WHOAMI },
      { method: "GET", path: "/api/v1/wallet", body: WALLET },
      { method: "POST", path: "/api/v1/wallet/stream-ticket", body: { ticket: "ticket-one", expires_in_seconds: 60 } },
    ]);

    renderBalance();
    await settle();
    const first = FakeEventSource.instances[0];

    // Two stretches of quiet, each under the ceiling, with a keep-alive between them. Their
    // sum is well over it, so a watchdog that ignored the ping would have reconnected.
    await settle(STREAM_SILENCE_MS - 10_000);
    act(() => first.ping());
    await settle(STREAM_SILENCE_MS - 10_000);

    expect(first.closed).toBe(false);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("counts a balance push as proof of life too", async () => {
    vi.useFakeTimers();
    tokenStore.set("member.jwt.value");
    vi.stubGlobal("EventSource", FakeEventSource);
    stubFetch([
      { method: "GET", path: "/api/v1/whoami", body: WHOAMI },
      { method: "GET", path: "/api/v1/wallet", body: WALLET },
      { method: "POST", path: "/api/v1/wallet/stream-ticket", body: { ticket: "ticket-one", expires_in_seconds: 60 } },
    ]);

    renderBalance();
    await settle();
    const first = FakeEventSource.instances[0];

    await settle(STREAM_SILENCE_MS - 10_000);
    act(() => first.push(451));
    await settle(STREAM_SILENCE_MS - 10_000);

    expect(first.closed).toBe(false);
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});

describe("the forced-password-change gate", () => {
  it("opens no stream and asks for no ticket while the gate is armed", async () => {
    vi.useFakeTimers();
    tokenStore.set("member.jwt.value");
    vi.stubGlobal("EventSource", FakeEventSource);
    const stub = stubFetch([
      { method: "GET", path: "/api/v1/whoami", body: { ...WHOAMI, must_change_password: true } },
    ]);

    renderBalance();
    await settle();
    // Long enough that several rounds of the old 1s/2s/4s… backoff would have gone out.
    for (let round = 0; round < 6; round++) await settle(30_000);

    expect(ticketCalls(stub)).toBe(0);
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(walletReads(stub)).toBe(0);
  });

  it("stops after one attempt when the API refuses the ticket 403", async () => {
    vi.useFakeTimers();
    tokenStore.set("member.jwt.value");
    vi.stubGlobal("EventSource", FakeEventSource);
    const stub = stubFetch([
      { method: "GET", path: "/api/v1/whoami", body: WHOAMI },
      { method: "GET", path: "/api/v1/wallet", body: WALLET },
      {
        method: "POST", path: "/api/v1/wallet/stream-ticket", status: 403,
        body: { error: "password_change_required" },
      },
    ]);

    renderBalance();
    await settle();
    expect(ticketCalls(stub)).toBe(1);

    // Six rounds of the 1s/2s/4s/8s/16s/30s backoff, each advanced separately: a timer
    // scheduled from inside one `advanceTimersByTimeAsync` is not run by that same call.
    for (let round = 0; round < 6; round++) await settle(30_000);

    // The refusal is permanent by policy, so asking again is a loop against an answer that
    // cannot change — and each attempt printed a console error on a screen where the member
    // can do nothing about it.
    expect(ticketCalls(stub)).toBe(1);
    expect(FakeEventSource.instances).toHaveLength(0);
  });
});
