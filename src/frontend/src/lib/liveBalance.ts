import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, endpoints, STREAM_SILENCE_MS, tokenStore } from "./api";

/**
 * Item 8 — the live balance, as a POLICY that knows nothing about the transport.
 *
 * <p>
 * <b>What was already here, and is kept whole.</b> `BalanceProvider` was the strongest thing
 * in the member frontend: a one-minute stream ticket minted <em>inside</em> `connect` rather
 * than captured once (the previous version leaked a fifteen-minute access JWT into nginx's
 * access log <em>and</em> froze the chip for the life of the tab after one blip), a named
 * `ping` keep-alive with a silence detector because a stream can stop delivering WITHOUT
 * failing, `visibilitychange` as well as `focus`, and a 403 treated as policy rather than as a
 * blip. Measured at ≤ 100 ms to update after a booking and after a cancel. None of it is
 * replaced.
 * </p>
 *
 * <p>
 * <b>What it lacked, and this adds.</b> Jitter, an idle close, and an honest degraded state.
 * </p>
 *
 * <ul>
 *   <li><b>Jitter is a real fix, not polish.</b> The backoff was `backoffMs * 2` with none.
 *       When the API container restarts, <em>every</em> open tab reconnects on an identical
 *       schedule — 1 s, 2 s, 4 s, 8 s — and hits the freshly-started server in lockstep, on an
 *       endpoint that mints a ticket through the auth rate-limit bucket shared with login.
 *       ±20 % costs one line and removes a self-inflicted thundering herd.</li>
 *   <li><b>The idle close.</b> The stream was held open while the tab was hidden. A phone in a
 *       pocket keeps a connection through the club's Cloudflare tunnel for an hour and pays
 *       for it in battery, for a screen nobody is looking at.</li>
 *   <li><b>`degraded` is the fourth state, and its absence was a defect.</b> A stream that has
 *       silently died left the chip showing a confident stale number with nothing to say so —
 *       the same class of failure the silence detector was added to fix on the server side.
 *       Loading, live, degraded and failed are four different things and this audience cannot
 *       be asked to infer any of them.</li>
 * </ul>
 *
 * <p>
 * <b>SSE, settled.</b> The programme's ruling is that the existing `/api/v1/wallet/stream`
 * pattern is extended — no WebSocket, no SignalR. The transport is still a seam, because the
 * poll fallback has to be able to stand in for it and because a test cannot open a real
 * `EventSource`; there is simply one implementation of it.
 * </p>
 */

export type LiveState = "loading" | "live" | "degraded" | "unavailable";

/** Who caused the movement. Only `"club"` raises a toast — see the note on {@link BalanceDelta}. */
export type BalanceDeltaSource = "self" | "club";

/**
 * The most recent movement.
 *
 * <p>
 * <b>`source` is what stops the product announcing one action twice.</b> A member who just
 * pressed <em>Book</em> already has a toast; raising a second one from the chip would be
 * `Toast.tsx:62-74`'s defect in a new costume. `"self"` is a movement this tab caused — a
 * booking, a cancel, a top-up returning — and `"club"` is one that arrived unbidden, which is
 * the case GOAL 8 is really about.
 * </p>
 */
export type BalanceDelta = {
  amount: number;
  at: number;
  source: BalanceDeltaSource;
  /** The server's closed-vocabulary reason, where it sends one. Absent on an older API. */
  reason?: string;
};

/** One frame off the wire. Every field but the balance is optional — an older API sends none. */
export type BalanceFrame = {
  balance_credits: number;
  delta_credits?: number;
  reason?: string;
};

export type BalanceTransport = {
  /**
   * Connect. Resolves with a closer once the stream is open, or rejects.
   *
   * A rejection with `stop: true` is policy, not a blip: nothing retries it.
   */
  open(args: {
    onFrame: (frame: BalanceFrame) => void;
    /** Nothing has arrived for the silence window. The stream is open and is not delivering. */
    onSilence: () => void;
    onError: () => void;
  }): Promise<{ close: () => void }>;
};

/** A refusal nothing should retry. The forced-password-change gate answers 403 by policy. */
export class TransportRefused extends Error {}

export const LIVE_BALANCE_POLICY = {
  /** As today (`balance.tsx:160`). */
  backoffInitialMs: 1_000,
  /** As today (`:169`). */
  backoffMaxMs: 30_000,
  /** New. See the thundering-herd note above. */
  backoffJitterPct: 20,
  /** New. A hidden tab parks its connection; it has not failed. */
  idleCloseMs: 60_000,
  /** New. The degraded cadence. */
  pollMs: 30_000,
  /** New. Consecutive failed connects before the transport is given up on. */
  failToPoll: 3,
  /** How many poll intervals between attempts to get the stream back. */
  transportRetryMultiple: 10,
} as const;

/**
 * The policy as a MUTABLE shape, not `typeof LIVE_BALANCE_POLICY`.
 *
 * The constant is `as const`, so its own type says `backoffInitialMs: 1000` — a literal, not
 * a number. A test that halves an interval to keep a fake clock short would not type-check
 * against it, which is the opposite of what a settings object is for.
 */
export type LiveBalancePolicy = { -readonly [K in keyof typeof LIVE_BALANCE_POLICY]: number };

/**
 * `ms` with up to ±`jitterPct` of itself.
 *
 * Exported so a test can assert the spread rather than the mean — the property that matters is
 * that two tabs do not agree, and a mean is exactly what a lockstep implementation also has.
 */
export function jittered(ms: number, jitterPct: number, random: () => number = Math.random): number {
  const spread = ms * (jitterPct / 100);
  return Math.max(0, Math.round(ms + (random() * 2 - 1) * spread));
}

/** The next backoff, capped. The jitter is applied to the wait, not to the accumulator. */
export function nextBackoff(current: number, policy: LiveBalancePolicy): number {
  return Math.min(current * 2, policy.backoffMaxMs);
}

/**
 * The SSE transport — the existing code, lifted out of `balance.tsx` and otherwise unchanged.
 *
 * <p>
 * It listens for BOTH the unnamed frame and the named `balance` event. The API keeps emitting
 * the unnamed one through the rollout precisely so a client that predates the named one keeps
 * working; a client that listened only for the new name would go quiet against today's server.
 * </p>
 */
export function sseTransport(): BalanceTransport {
  return {
    async open({ onFrame, onSilence, onError }) {
      let ticket: string;
      try {
        ({ ticket } = await endpoints.walletStreamTicket());
      } catch (err) {
        // A 403 is a policy, not a blip — the forced-password-change gate answers every route
        // but its own, and no amount of backing off changes that answer.
        if (err instanceof ApiError && err.status === 403) throw new TransportRefused("password_change_required");
        throw err;
      }

      const es = new EventSource(`/api/v1/wallet/stream?ticket=${encodeURIComponent(ticket)}`);
      let silenceTimer: ReturnType<typeof setTimeout> | null = null;
      const clearSilence = () => { if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; } };
      /** Restarted by every byte the stream delivers; firing means the stream has gone quiet. */
      const heardFrom = () => {
        clearSilence();
        silenceTimer = setTimeout(onSilence, STREAM_SILENCE_MS);
      };

      const take = (raw: string) => {
        heardFrom();
        try {
          const msg = JSON.parse(raw) as BalanceFrame;
          if (typeof msg.balance_credits === "number") onFrame(msg);
        } catch { /* malformed payloads are ignored */ }
      };

      heardFrom();
      es.onopen = heardFrom;
      es.onmessage = (e) => take(e.data);
      es.addEventListener("balance", (e) => take((e as MessageEvent).data));
      // The keep-alive carries no balance; all it proves is that the stream is still ours.
      es.addEventListener("ping", heardFrom);
      es.onerror = onError;

      return { close: () => { clearSilence(); es.close(); } };
    },
  };
}

export type LiveBalance = {
  /** The server's figure. `null` until one has arrived. */
  balance: number | null;
  state: LiveState;
  /** Kept for every existing consumer: `loading` is `state === "loading"`. */
  loading: boolean;
  lastConfirmedAt: number | null;
  delta: BalanceDelta | null;
  /** The chip has shown this delta. Clears it so a re-render cannot raise a second toast. */
  clearDelta: () => void;
  /**
   * Re-read the wallet over HTTP.
   *
   * <p>
   * <b>`expectSelf` says whose doing the movement was, and it is not cosmetic.</b> A plain
   * re-read is indistinguishable from an admin crediting the member at the desk, so the chip
   * announces it — which is right for the refresh on focus and on visibility, and wrong on
   * the path where the page has ALREADY told the member what happened. Cancelling a booking
   * is that path: its endpoint answers with `refunded_credits` and `penalty_credits` and no
   * balance, so there is no figure to `apply`, and the un-flagged re-read raised "The club
   * added 50 credits" over the page's own "50.00 back".
   * </p>
   */
  refresh: (options?: { expectSelf?: boolean }) => Promise<void>;
  /** Take a figure the server has just stated, without asking it again. */
  apply: (credits: number) => void;
};

export function useLiveBalance({
  enabled,
  transport,
  policy: given,
  random = Math.random,
}: {
  /** Authenticated, and not held behind the forced-password-change gate. */
  enabled: boolean;
  transport?: BalanceTransport;
  policy?: LiveBalancePolicy;
  random?: () => number;
}): LiveBalance {
  // Defaulted here rather than in the parameter list so that a caller passing `undefined`
  // — which `BalanceProvider` does on every render in production — gets the SAME object
  // identity each time. A fresh default literal would be a new dependency of the connection
  // effect on every render, which tears the stream down and reopens it, for ever.
  const policy = given ?? LIVE_BALANCE_POLICY;
  const [balance, setBalance] = useState<number | null>(null);
  const [state, setState] = useState<LiveState>("loading");
  const [lastConfirmedAt, setLastConfirmedAt] = useState<number | null>(null);
  const [delta, setDelta] = useState<BalanceDelta | null>(null);

  const inflight = useRef(false);
  /**
   * The figure the last movement was measured from.
   *
   * A ref rather than the `balance` state because the comparison happens inside a callback
   * that closes over whatever `balance` was when the effect ran — and the effect deliberately
   * does not re-run on every balance change, because re-running it tears down the stream.
   */
  const previous = useRef<number | null>(null);
  /**
   * The next movement is this tab's own doing.
   *
   * Set by `apply`, and by `refresh({ expectSelf: true })` — never by a bare `refresh`, which
   * is what the focus and visibility reads use and is how a member learns about a top-up that
   * happened while the phone was in a pocket. `record` clears it whatever it decides, so one
   * flagged read cannot silence the movement after it.
   */
  const expectSelf = useRef(false);

  const record = useCallback((credits: number, frame?: BalanceFrame) => {
    const before = previous.current;
    previous.current = credits;
    setBalance(credits);
    setLastConfirmedAt(Date.now());
    const amount = frame?.delta_credits ?? (before === null ? 0 : credits - before);
    // A first read is not a movement: `null -> 400.00` is the first time the member has been
    // told, not money arriving. Neither is a re-read that confirms what we already had.
    if (before === null || Math.abs(amount) < 0.01) { expectSelf.current = false; return; }
    setDelta({
      amount,
      at: Date.now(),
      source: expectSelf.current ? "self" : "club",
      reason: frame?.reason,
    });
    expectSelf.current = false;
  }, []);

  const refresh = useCallback(async (options?: { expectSelf?: boolean }) => {
    if (!enabled) return;
    if (inflight.current) return;
    inflight.current = true;
    if (options?.expectSelf) expectSelf.current = true;
    try {
      const w = await endpoints.wallet();
      record(w.balance_credits);
      setState((current) => (current === "degraded" ? "degraded" : "live"));
    } catch {
      // Silent: the chip keeps the figure it has. What it must NOT do is claim that figure is
      // live, which is what the degraded state below is for.
      setState((current) => (current === "loading" ? "unavailable" : current));
    } finally {
      inflight.current = false;
    }
  }, [enabled, record]);

  const apply = useCallback((credits: number) => {
    expectSelf.current = true;
    record(credits);
  }, [record]);

  const clearDelta = useCallback(() => setDelta(null), []);

  // Initial read, and on the gate coming down. Kept separate from the stream effect: an HTTP
  // read is one round trip and a stream negotiation is several, and the member is looking at
  // the chip now.
  useEffect(() => {
    if (!enabled) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clears a stale balance on sign-out
      setBalance(null);
      previous.current = null;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- ditto
      setState("loading");
      return;
    }
    void refresh();
  }, [enabled, refresh]);

  // Refresh when the tab comes back — a manual top-up in another tab, a phone waking up in a
  // squash club. `visibilitychange` as well as `focus`, because a backgrounded PWA that is
  // brought forward never fires `focus` and is exactly the session most likely to have missed
  // a push while it was asleep.
  useEffect(() => {
    if (!enabled) return;
    const onFocus = () => { void refresh(); };
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, refresh]);

  /**
   * The connection, its backoff, its idle close and its fallback — one effect, because they
   * are one state machine and splitting them is how two of them end up disagreeing about
   * whether a socket is open.
   */
  useEffect(() => {
    if (!enabled) return;
    if (!tokenStore.get()) return;
    const wire = transport ?? sseTransport();

    let cancelled = false;
    let handle: { close: () => void } | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let retryTransportAt = 0;
    let backoffMs = policy.backoffInitialMs;
    let failures = 0;
    let parked = false;

    const clearReconnect = () => { if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; } };
    const clearIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } };
    const stopPolling = () => { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } };

    const drop = () => { handle?.close(); handle = null; };

    /**
     * Give up on the stream and poll the paired plain GET instead.
     *
     * The chip says so — a hollow dot and a `title` naming the cadence. It never shows the
     * number without the qualifier, which is the whole of the honesty requirement.
     */
    const degrade = () => {
      if (pollTimer) return;
      setState("degraded");
      retryTransportAt = policy.transportRetryMultiple;
      pollTimer = setInterval(() => {
        void refresh();
        retryTransportAt -= 1;
        if (retryTransportAt <= 0) {
          stopPolling();
          failures = 0;
          backoffMs = policy.backoffInitialMs;
          void connect();
        }
      }, policy.pollMs);
    };

    const retryLater = () => {
      if (cancelled || parked) return;
      failures += 1;
      if (failures >= policy.failToPoll) { degrade(); return; }
      reconnectTimer = setTimeout(() => { void connect(); }, jittered(backoffMs, policy.backoffJitterPct, random));
      backoffMs = nextBackoff(backoffMs, policy);
    };

    const connect = async () => {
      if (cancelled || parked) return;
      try {
        const opened = await wire.open({
          onFrame: (frame) => {
            failures = 0;
            backoffMs = policy.backoffInitialMs;
            setState("live");
            record(frame.balance_credits, frame);
          },
          onSilence: () => {
            // A stream can stop delivering WITHOUT failing — no `onerror`, nothing for a
            // backoff to react to, and a member watching a stale figure until they reload.
            void refresh();
            drop();
            retryLater();
          },
          onError: () => { drop(); retryLater(); },
        });
        if (cancelled || parked) { opened.close(); return; }
        handle = opened;
        failures = 0;
        backoffMs = policy.backoffInitialMs;
        setState((current) => (current === "degraded" ? "degraded" : "live"));
      } catch (err) {
        // Policy, not a blip. This effect re-runs by itself the moment the gate clears.
        if (err instanceof TransportRefused) return;
        retryLater();
      }
    };

    /**
     * Hidden → park. Visible → truth first, then reopen.
     *
     * The order matters: the member is looking at the chip NOW. An HTTP read is one round trip;
     * waiting for a stream to negotiate is several. And the state stays whatever it was while
     * parked — we have not failed, we have stopped paying for a connection nobody is watching.
     */
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        clearIdle();
        idleTimer = setTimeout(() => {
          parked = true;
          clearReconnect();
          drop();
        }, policy.idleCloseMs);
        return;
      }
      clearIdle();
      if (!parked) return;
      parked = false;
      backoffMs = policy.backoffInitialMs;
      failures = 0;
      void refresh();
      void connect();
    };

    document.addEventListener("visibilitychange", onVisibility);
    void connect();

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      clearReconnect();
      clearIdle();
      stopPolling();
      drop();
    };
  }, [enabled, transport, policy, random, record, refresh]);

  return {
    balance,
    state,
    loading: state === "loading",
    lastConfirmedAt,
    delta,
    clearDelta,
    refresh,
    apply,
  };
}
