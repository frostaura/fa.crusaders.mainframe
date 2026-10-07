import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, endpoints, noteWalletMoved, setMoneyRequestListener, STREAM_SILENCE_MS, tokenStore, type MoneyWrite } from "./api";
import { heldPartsOf, type HeldPart } from "./bookingsApi";

/** The chip reads a balance, not a ledger: one row is the smallest page the wallet serves. */
const CHIP_WALLET_ROWS = 1;

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

let lastStamp = 0;
/**
 * A movement's time, strictly later than the one before it. Two frames in one millisecond shared a
 * `Date.now()`, and the chip reads an unchanged `at` as "the same movement" — it dropped the second
 * frame of a split cancel's burst (the share frame) and called the partners' minutes "freed".
 */
const stamp = (): number => (lastStamp = Math.max(Date.now(), lastStamp + 1));

/**
 * The most recent movement.
 *
 * <p>
 * <b>`source` is what stops the product announcing one action twice.</b> A member who just
 * pressed <em>Book</em> already has a toast; raising a second one from the chip would be
 * `Toast.tsx:62-74`'s defect in a new costume. `"self"` is a movement this tab caused — a
 * booking, a cancel, a purchase returning — and `"club"` is one that arrived unbidden, which is
 * the case GOAL 8 is really about.
 * </p>
 */
export type BalanceDelta = {
  amount: number;
  at: number;
  source: BalanceDeltaSource;
  /** The server's closed-vocabulary reason, where it sends one. Absent on an older API. */
  reason?: string;
  /** R10 E10-1 — the ledger rows behind the movement (a refund AND a penalty), where the frame carries them. */
  parts?: BalancePart[];
  /** R11 E11-1 — why a share moved (`share_cause`), as the server sent it; an unknown value reaches the copy as-is. */
  shareCause?: string;
  /** R11 E11-1 — with a `no_show` cause: the partner's part of the penalty that did not come back. */
  shareKeptMinutes?: number;
  /** R12 X12-1 (contract C1) — on a cancellation: who cancelled it. "club" = an admin or the system. */
  cancelledBy?: "club" | "member";
  /** R12 E12-2 (contract C2) — on a reversal: the member whose scan reversed it; absent when it was this member. */
  checkedInBy?: string;
  /** R13 C13-7 — the booking the frame's rows name (court + start), for a member who can no longer read it. */
  place?: { courtName: string | null; startsAt: string };
  /**
   * R14 (BE14b contract §2) — on a share frame: the player whose act moved it (the organiser who
   * took this member off, changed the split or cancelled; the partner who withdrew or paid). Absent
   * when it was this member, the club or an admin — the club is never named by its admin.
   */
  actorName?: string;
  /** R17 E17-9 (BE17b) — the frame's `checked_in_by_you`: this member's own scan made the movement. */
  checkedInByYou?: boolean;
};

/**
 * R10 E10-1 — one row of a live movement: its ledger type's reason and its signed whole minutes.
 * R13 X13-2 — a `share_transfer` row may name the other member on it (`counterparty_name`).
 */
export type BalancePart = { reason: string; delta_minutes: number; counterparty_name?: string | null };

/** The frame's `parts`, kept only where every entry has the documented shape. */
export function balanceParts(raw: unknown): BalancePart[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const ok = raw.every((p) => p && typeof p.reason === "string" && typeof p.delta_minutes === "number");
  return ok && raw.length > 0 ? (raw as BalancePart[]) : undefined;
}

/** R11 E11-1 — the frame's share cause, kept only when well-shaped (a string; a whole, non-negative minute count). */
function shareCauseOf(frame: BalanceFrame | undefined): Pick<BalanceDelta, "shareCause" | "shareKeptMinutes"> {
  const cause = typeof frame?.share_cause === "string" && frame.share_cause ? frame.share_cause : undefined;
  const kept = frame?.share_kept_minutes;
  const keptOk = typeof kept === "number" && Number.isInteger(kept) && kept >= 0;
  return { ...(cause ? { shareCause: cause } : {}), ...(cause && keptOk ? { shareKeptMinutes: kept } : {}) };
}

/** R12 contracts C1 / C2 — who cancelled, and who checked in, kept only when well-shaped. */
function whoOf(frame: BalanceFrame | undefined): Pick<BalanceDelta, "cancelledBy" | "checkedInBy" | "actorName" | "checkedInByYou"> {
  const by = frame?.cancelled_by;
  const name = typeof frame?.checked_in_by_name === "string" ? frame.checked_in_by_name.trim() : "";
  const actor = typeof frame?.actor_name === "string" ? frame.actor_name.trim() : "";
  return {
    ...(by === "club" || by === "member" ? { cancelledBy: by } : {}), ...(name ? { checkedInBy: name } : {}), ...(actor ? { actorName: actor } : {}),
    ...(frame?.checked_in_by_you === true ? { checkedInByYou: true } : {}),
  };
}

/** R13 C13-7 — the frame's own booking (`court_name`, `booking_starts_at`), kept only when the start is a string. */
function placeOf(frame: BalanceFrame | undefined): Pick<BalanceDelta, "place"> {
  const starts = frame?.booking_starts_at;
  if (typeof starts !== "string" || !starts) return {};
  const court = typeof frame?.court_name === "string" && frame.court_name.trim() ? frame.court_name.trim() : null;
  return { place: { courtName: court, startsAt: starts } };
}

/** R14 (BE14b §5) — the frame's reason for a club cancel that refunded nothing (the lights had been on). */
export const CANCELLED_NO_REFUND = "cancelled_no_refund";

/**
 * R16 J16-7 (BE16b) — the PARTNER's frame for the same cancel: nothing moved, their share stands.
 * Like the booker's, a balance-neutral frame that is still said.
 */
export const CANCELLED_SHARE_STANDS = "cancelled_share_stands";

/** One frame off the wire. Every field but the balance is optional — an older API sends none. */
export type BalanceFrame = {
  balance_minutes: number;
  delta_minutes?: number;
  reason?: string;
  /** R10 E10-1 — each ledger row behind `delta_minutes`; absent from an older API. */
  parts?: unknown;
  /** R11 E11-1 — non-null exactly when a share_transfer row moved; absent from an older API. */
  share_cause?: string | null;
  /** R11 E11-1 — with `share_cause: "no_show"` only: the partner's kept part of the penalty. */
  share_kept_minutes?: number | null;
  /** R12 C1 — on a cancellation frame: "club" (an admin or the system), "member", or null. */
  cancelled_by?: "club" | "member" | null;
  /** R12 C2 — on a no-show / outage reversal (and its share frames): who scanned; null when it was this member. */
  checked_in_by_name?: string | null;
  /** R13 C13-7 — the court of the booking the frame's rows name; null when they name none. */
  court_name?: string | null;
  /** R13 C13-7 — that booking's start (ISO); null when the rows name none. */
  booking_starts_at?: string | null;
  /** R14 (BE14b §2) — on a share frame: the player whose act moved it, when not this member, the club or an admin. */
  actor_name?: string | null;
  /** R17 E17-9 (BE17b) — on every balance frame: this member's own scan made the movement. Absent from an older API. */
  checked_in_by_you?: boolean;
  /**
   * D11 (§3a): shares an organiser received, HELD for their partners' possible returns until
   * `held_until` (the earliest share deadline among them). Part of the balance, not spendable.
   * Every spend decision reads `spendable_minutes`. Absent from an API that predates P11.
   */
  held_minutes?: number;
  spendable_minutes?: number;
  held_until?: string | null;
  /** C4 — the held minutes per share deadline, soonest first; sums to `held_minutes`. */
  held_parts?: { minutes: number; until: string }[];
  /**
   * P11 — minutes the organiser OWES BACK to partners whose return is waiting because the
   * organiser's balance could not cover it. No release date: incoming minutes pay it first.
   * `spendable_minutes` is balance − held − owed back, so it can be negative. Absent before P11.
   */
  owed_back_minutes?: number;
};

/**
 * What of a balance is held (D11, §3a) or owed back to partners (P11), as the chip, the wallet
 * and every "balance after" figure need it. `held`/`owedBack` are 0 and `until` null when
 * nothing is held — including against an API that predates the fields, where the balance IS
 * the spendable figure. `spendable` may be NEGATIVE when more is owed back than the balance.
 */
export type HeldFigures = {
  held: number; owedBack: number; spendable: number; until: string | null;
  /**
   * C4 / F4-18 — the held minutes per share deadline, soonest first. One release date for the whole
   * amount was wrong whenever shares from two games were held: "60 min held until Fri" when 35
   * of it stays until Sunday. Empty (or absent) when the API predates C4 or nothing is held.
   */
  parts?: HeldPart[];
};

type HeldWire = {
  balance_minutes: number; held_minutes?: number; spendable_minutes?: number; held_until?: string | null; owed_back_minutes?: number;
  held_parts?: unknown;
};

function positive(value: number | undefined): number {
  return typeof value === "number" && value > 0 ? value : 0;
}

/** The held figures a frame (or a wallet read) carries, or the no-hold default. */
export function heldFrom(frame: HeldWire): HeldFigures {
  const held = positive(frame.held_minutes);
  const owedBack = positive(frame.owed_back_minutes);
  const spendable = typeof frame.spendable_minutes === "number" ? frame.spendable_minutes : frame.balance_minutes - held - owedBack;
  const parts = held > 0 ? heldPartsOf(frame) : [];
  return { held, owedBack, spendable, until: held > 0 ? frame.held_until ?? null : null, ...(parts.length > 0 ? { parts } : {}) };
}

export type BalanceTransport = {
  /**
   * Connect. Resolves with a closer once the stream is open, or rejects.
   *
   * A rejection with `stop: true` is policy, not a blip: nothing retries it.
   */
  open(args: {
    /**
     * R15 X15-6 — `origin: "unnamed"` is the legacy `data:` frame (and every stream's opening
     * snapshot): it carries a balance, never a movement. Absent = a named `balance` event.
     */
    onFrame: (frame: BalanceFrame, origin?: "unnamed") => void;
    /** Nothing has arrived for the silence window. The stream is open and is not delivering. */
    onSilence: () => void;
    onError: () => void;
    /**
     * P11 — the member inbox's named `notification` frame (`{unread_count}`), published after
     * every change to the member's inbox so the bell needs no polling while the stream is live.
     */
    onNotification?: (unreadCount: number) => void;
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
/**
 * How long after this tab's own money-moving request settles a movement is still taken as its
 * own (D4). The frame is published after the commit, so it normally arrives within a few hundred
 * milliseconds of the answer either side; three seconds covers a slow outbox without swallowing
 * a genuinely separate movement for long.
 */
export const SELF_GRACE_MS = 3_000;

/**
 * R18 X18-2 — the frame reasons each kind of this tab's writes makes on its own wallet. A frame is
 * the member's own only when a write in flight (or inside {@link SELF_GRACE_MS} of settling) makes
 * it: an admin adjusting the wallet 0.8 s after the member booked was silenced by a window any
 * money-moving request opened.
 */
const SHARE_MOVES = ["share_transfer", "share_set_aside", "mixed"];
const CANCEL_MOVES = ["cancellation_refund", "penalty", CANCELLED_NO_REFUND, ...SHARE_MOVES];
const OWN_REASONS: [RegExp, string[]][] = [
  [/^\/api\/v1\/admin\/minutes\/.*\/adjust$/, ["admin_adjustment"]],
  [/^\/api\/v1\/admin\/minutes\/.*\/sell$/, ["admin_top_up"]],
  [/^\/api\/v1\/minutes\/purchase/, ["top_up"]],
  [/\/cancel$|\/bulk-cancel$/, CANCEL_MOVES],
  [/\/(players|split)(\/|$)|^\/api\/v1\/invites\//, SHARE_MOVES],
  [/^\/api\/v1\/(admin\/)?bookings/, ["booking_charge"]],
];
/** Every reason a member's own act (not a desk route) can make — what an `expectSelf` flag may cover. */
const MEMBER_REASONS = new Set(["top_up", "booking_charge", ...CANCEL_MOVES]);

/** Nobody else acted in this frame: no other player named, not a club cancel. */
function byThisMember(frame: BalanceFrame): boolean {
  return !frame.actor_name?.trim() && frame.cancelled_by !== "club";
}

/**
 * Does this write make this frame? A member-route write never makes a frame another player or the
 * club acted in; a desk route can (an admin's own wallet, said as "The club"). A frame with no
 * reason (an older API) matches any write, as before.
 */
export function writeMakes(write: MoneyWrite, frame: BalanceFrame): boolean {
  if (!frame.reason) return true;
  const reasons = OWN_REASONS.find(([pattern]) => pattern.test(write.path))?.[1];
  if (!reasons?.includes(frame.reason)) return false;
  return write.path.startsWith("/api/v1/admin/") || byThisMember(frame);
}

function ownable(frame: BalanceFrame): boolean {
  return !frame.reason || (MEMBER_REASONS.has(frame.reason) && byThisMember(frame));
}

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
    async open({ onFrame, onSilence, onError, onNotification }) {
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

      const take = (raw: string, origin?: "unnamed") => {
        heardFrom();
        try {
          const msg = JSON.parse(raw) as BalanceFrame;
          if (typeof msg.balance_minutes === "number") {
            // A read already on its way may predate this movement: never join it (api `readWallet`).
            noteWalletMoved();
            onFrame(msg, origin);
          }
        } catch { /* malformed payloads are ignored */ }
      };

      heardFrom();
      es.onopen = heardFrom;
      // R15 X15-6: the unnamed frame is the opening snapshot or the legacy twin of a named one.
      es.onmessage = (e) => take(e.data, "unnamed");
      es.addEventListener("balance", (e) => take((e as MessageEvent).data));
      // The keep-alive carries no balance; all it proves is that the stream is still ours.
      es.addEventListener("ping", heardFrom);
      // P11: the inbox's unread count, on the same stream — never a balance.
      es.addEventListener("notification", (e) => {
        heardFrom();
        try {
          const msg = JSON.parse((e as MessageEvent).data) as { unread_count?: unknown };
          if (typeof msg.unread_count === "number") onNotification?.(msg.unread_count);
        } catch { /* malformed payloads are ignored */ }
      });
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
  /** D11 §3a — what of the balance is held, and the spendable figure. Null until a figure arrives. */
  heldFigures: HeldFigures | null;
  /**
   * P11 — the inbox's unread count as the stream last pushed it; null until a `notification`
   * frame has arrived (the bell reads its own count until then, and whenever the stream is not
   * live). `noteUnread` lets a screen that has just changed the inbox say so.
   */
  unreadCount: number | null;
  noteUnread: (count: number) => void;
  /** The chip has shown this delta. Clears it so a re-render cannot raise a second toast. */
  clearDelta: () => void;
  /**
   * Re-read the wallet over HTTP.
   *
   * <p>
   * <b>`expectSelf` says whose doing the movement was, and it is not cosmetic.</b> A plain
   * re-read is indistinguishable from an admin adding minutes at the desk, so the chip
   * announces it — which is right for the refresh on focus and on visibility, and wrong on
   * the path where the page has ALREADY told the member what happened. Cancelling a booking
   * is that path: its endpoint answers with `refunded_minutes` and `penalty_minutes` and no
   * balance, so there is no figure to `apply`, and the un-flagged re-read raised "The club
   * added 50 min" over the page's own "50 min back".
   * </p>
   */
  refresh: (options?: { expectSelf?: boolean }) => Promise<void>;
  /**
   * Take a figure the server has just stated, without asking it again — unless a stream frame has
   * arrived since the request that stated it was SENT (R17 J17-2, FE17x): the frame is then at
   * least as new, and the answer is dropped. `sentAt` is {@link frameMark} taken at the send;
   * absent, it is the mark when this tab's latest money-moving request went out.
   */
  apply: (minutes: number, options?: { sentAt?: number }) => void;
  /** How many stream frames have arrived — read it when a request is SENT and hand it to `apply`. */
  frameMark: () => number;
};

export function useLiveBalance({
  enabled,
  identity = null,
  transport,
  policy: given,
  random = Math.random,
}: {
  /** Authenticated, and not held behind the forced-password-change gate. */
  enabled: boolean;
  /**
   * WHO the balance belongs to (D1/D2). A sign-in moves this without moving `enabled`
   * ("authenticated" to "authenticated"), and before it was a dependency the chip went on
   * showing the previous identity's figure — a red zero for a stale token's deleted member
   * — and its stream stayed on the previous member's ticket. A change starts over: no figure,
   * loading, a fresh read and a fresh stream.
   */
  identity?: string | null;
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
  const [heldFigures, setHeldFigures] = useState<HeldFigures | null>(null);
  const [unreadCount, setUnreadCount] = useState<number | null>(null);

  const inflight = useRef(false);
  /** Bumped on every identity change, so a read that answers for the previous one is dropped. */
  const generation = useRef(0);
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
   * is what the focus and visibility reads use and is how a member learns about a purchase that
   * happened while the phone was in a pocket. `record` clears it whatever it decides, so one
   * flagged read cannot silence the movement after it.
   */
  const expectSelf = useRef(false);
  /**
   * D4 — this tab has a money-moving request out, or had one settle a moment ago. The stream's
   * frame for it can overtake the HTTP answer (see `setMoneyRequestListener`), so the whole
   * bracket, plus {@link SELF_GRACE_MS} after it, counts as the member's own doing.
   */
  const writes = useRef(new Map<MoneyWrite, number | null>());
  /** The writes still out, and those settled inside the grace (older ones are forgotten here). */
  const liveWrites = useCallback(() => {
    for (const [w, endedAt] of writes.current) if (endedAt !== null && Date.now() >= endedAt + SELF_GRACE_MS) writes.current.delete(w);
    return [...writes.current.keys()];
  }, []);
  /**
   * R17 J17-2 — how many stream frames have arrived. A wallet read notes it when SENT; an answer
   * that finds a frame has arrived since describes the balance before that frame and is dropped.
   * Applying it put an older figure over a newer one and raised "went up" when it had gone down.
   */
  const framesSeen = useRef(0);
  /**
   * R17 J17-2 (FE17x) — `framesSeen` when this tab's money-moving bracket opened: the mark a write's
   * own answer (`apply` without `sentAt`) is judged by. A request starting while another is out, or
   * inside the grace after one, keeps the EARLIER mark — a dropped answer is safe (the frames are
   * the truth), a stale one put over a frame is the defect.
   */
  const bracketMark = useRef<number | null>(null);
  useEffect(() => {
    setMoneyRequestListener((phase, write) => {
      if (phase === "start" && liveWrites().length === 0) bracketMark.current = framesSeen.current;
      writes.current.set(write, phase === "start" ? null : Date.now());
    });
    return () => setMoneyRequestListener(null);
  }, [liveWrites]);

  const record = useCallback((minutes: number, frame?: BalanceFrame, quiet = false) => {
    const before = previous.current;
    previous.current = minutes;
    setBalance(minutes);
    setLastConfirmedAt(Date.now());
    // R15 X15-6 / E15-2 / J15-3 — an unnamed frame (the stream's opening snapshot, or the legacy
    // twin the server publishes beside every named one, ~1 ms apart in either order) moves the
    // figure and never raises a movement. Its reasonless diff was the second toast. It leaves
    // `expectSelf` alone: that flag belongs to the read or the named frame that follows.
    if (quiet) return;
    const amount = frame?.delta_minutes ?? (before === null ? 0 : minutes - before);
    // A first read is not a movement: `null -> 400` is the first time the member has been
    // told, not money arriving. Neither is a re-read that confirms what we already had.
    // R14 (BE14b §5) — a club cancel of a session that had started moves nothing, yet the member
    // is told: that one balance-neutral frame is still a movement (amount 0) for the toast.
    const neutralNews = before !== null && (frame?.reason === CANCELLED_NO_REFUND || frame?.reason === CANCELLED_SHARE_STANDS);
    if (before === null || (Math.abs(amount) < 0.01 && !neutralNews)) { expectSelf.current = false; return; }
    // R18 X18-2 — a frame is ours only when a write of ours makes it; a read keeps the window.
    const open = liveWrites();
    const own = frame
      ? (expectSelf.current && ownable(frame)) || open.some((w) => writeMakes(w, frame))
      : expectSelf.current || open.length > 0;
    setDelta({
      amount,
      at: stamp(),
      source: own ? "self" : "club",
      reason: frame?.reason,
      parts: balanceParts(frame?.parts),
      ...shareCauseOf(frame),
      ...whoOf(frame),
      ...placeOf(frame),
    });
    expectSelf.current = false;
  }, [liveWrites]);

  const refresh = useCallback(async (options?: { expectSelf?: boolean }) => {
    if (!enabled) return;
    if (inflight.current) return;
    inflight.current = true;
    const asked = generation.current;
    if (options?.expectSelf) expectSelf.current = true;
    const sentAfter = framesSeen.current;
    try {
      // P4-7 / M4-9 (R4): the balance and the held parts are top-level on any page of the wallet,
      // so the chip asks for the smallest page (the server's floor is one row), not a hundred.
      // A first-page read already in flight for more rows (the page's) still answers it.
      const w = await endpoints.wallet(CHIP_WALLET_ROWS);
      if (asked !== generation.current) return;
      // R17 J17-2 — the stream spoke while this read was out: its figure is newer than ours. An
      // `expectSelf` stays for the named frame (an unnamed twin leaves it; `record` clears it).
      if (framesSeen.current !== sentAfter) return;
      setHeldFigures(heldFrom(w));
      record(w.balance_minutes);
      setState((current) => (current === "degraded" ? "degraded" : "live"));
    } catch {
      // Silent: the chip keeps the figure it has. What it must NOT do is claim that figure is
      // live, which is what the degraded state below is for.
      if (asked === generation.current) setState((current) => (current === "loading" ? "unavailable" : current));
    } finally {
      if (asked === generation.current) inflight.current = false;
    }
  }, [enabled, record]);

  const apply = useCallback((minutes: number, options?: { sentAt?: number }) => {
    // R17 J17-2 (FE17x) — a frame arrived after the request was sent: its figure is at least as new
    // as this answer (the server publishes one after every commit, this one's included). Taking the
    // answer put an older figure over it and measured a false movement against it. Nothing is
    // flagged as our own either — a lingering flag would silence the next real movement.
    const sent = options?.sentAt ?? bracketMark.current;
    if (sent !== null && framesSeen.current !== sent) return;
    expectSelf.current = true;
    // A figure a booking answer stated carries no held split; the held and owed-back parts
    // cannot have moved (a booking neither receives nor returns a share), so spendable moves
    // with the balance.
    setHeldFigures((h) => (h ? { ...h, spendable: minutes - h.held - h.owedBack } : h));
    record(minutes);
  }, [record]);

  const noteUnread = useCallback((count: number) => setUnreadCount(Math.max(0, count)), []);

  const clearDelta = useCallback(() => setDelta(null), []);

  const frameMark = useCallback(() => framesSeen.current, []);

  // Initial read, and on the gate coming down. Kept separate from the stream effect: an HTTP
  // read is one round trip and a stream negotiation is several, and the member is looking at
  // the chip now.
  //
  // Every change of identity starts from nothing — the previous member's figure is not this
  // member's, and a figure carried across a sign-in is how a chip showed a red zero that
  // belonged to nobody who was signed in (D1).
  useEffect(() => {
    generation.current += 1;
    inflight.current = false;
    expectSelf.current = false;
    previous.current = null;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clears a stale balance on sign-out or a change of member
    setBalance(null);
    setHeldFigures(null);
    setUnreadCount(null);
    setDelta(null);
    setState("loading");
    if (enabled) void refresh();
  }, [enabled, identity, refresh]);

  // Refresh when the tab comes back — a desk sale in another tab, a phone waking up in a
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
          onFrame: (frame, origin) => {
            framesSeen.current += 1;
            failures = 0;
            backoffMs = policy.backoffInitialMs;
            setState("live");
            // The legacy unnamed twin carries the balance alone: it must not wipe a held part the
            // named frame (or the opening snapshot, which carries them) stated.
            const bare = origin === "unnamed" && frame.held_minutes === undefined;
            setHeldFigures((h) => (bare && h ? { ...h, spendable: frame.balance_minutes - h.held - h.owedBack } : heldFrom(frame)));
            record(frame.balance_minutes, frame, origin === "unnamed");
          },
          onNotification: (count) => setUnreadCount(Math.max(0, count)),
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
  }, [enabled, identity, transport, policy, random, record, refresh]);

  return {
    balance,
    state,
    loading: state === "loading",
    lastConfirmedAt,
    delta,
    heldFigures,
    unreadCount,
    noteUnread,
    clearDelta,
    refresh,
    apply,
    frameMark,
  };
}
