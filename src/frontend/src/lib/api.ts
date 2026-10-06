/**
 * Typed API client. Reads/writes the access token from localStorage so refresh-survives-reload.
 */

import { noteClubZoneFrom } from "./clubZone";

/**
 * The one `localStorage` key the session lives under.
 *
 * <p>
 * Exported because `localStorage` is shared by every tab on the origin, and a `storage` event
 * naming this key is how a tab learns that another tab ended the session. A listener that
 * hard-coded the string would drift from the store beside it the first time either moved.
 * </p>
 */
export const TOKEN_KEY = "crusaders.mainframe.token";

export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (t: string) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

export class ApiError extends Error {
  constructor(public status: number, public payload: unknown) {
    super(`HTTP ${status}`);
  }

  /**
   * The API's stable snake_case `error` code, or null when the body carries none.
   *
   * Branching on the STATUS alone is what put "That slot is in the past." on screen
   * for a member whose session had merely lapsed: the schedule mapped every 400 to
   * the past-slot sentence, so `tenant_unresolved` — and `too_far_ahead`, and
   * `invalid_duration` — all came out as the same wrong sentence. Two different
   * refusals sharing a status code is normal and the code is what tells them apart.
   */
  get code(): string | null {
    const payload = this.payload;
    if (payload && typeof payload === "object" && "error" in payload) {
      const value = (payload as { error: unknown }).error;
      if (typeof value === "string") return value;
    }
    return null;
  }

  /** One field off the error body — the figures a sentence needs, e.g. `peak_start`. */
  detail(key: string): string | number | null {
    const payload = this.payload;
    if (payload && typeof payload === "object" && key in payload) {
      const value = (payload as Record<string, unknown>)[key];
      if (typeof value === "string" || typeof value === "number") return value;
    }
    return null;
  }
}

/**
 * The request never produced a response at all — the connection was refused, the network
 * dropped, or the server accepted the socket and never answered.
 *
 * <p>
 * This is a different thing from an {@link ApiError} and every screen has to be able to tell
 * them apart: an `ApiError` carries a decision the club made, a `NetworkError` carries the
 * absence of one. Without the distinction a stalled backend was indistinguishable from a
 * pending request, and the Book button sat on "Working…" with `aria-busy` forever — the
 * member could not tell whether they had been charged for a court.
 * </p>
 */
export class NetworkError extends Error {
  constructor(public kind: "timeout" | "unreachable", options?: { cause?: unknown }) {
    super(kind === "timeout" ? "The request timed out." : "The server could not be reached.", options);
    this.name = "NetworkError";
  }
}

/**
 * A write the phone refused to send because it has no connection at all (`navigator.onLine` is
 * false) — R4 wave B, "offline & instant": writes say "needs a connection" and are never queued.
 *
 * <p>
 * <b>Known not to have happened</b>, unlike a {@link NetworkError}: nothing left the phone, so
 * there is no record to read back (`outcomeUnknown` is false for it) and "nothing changed" is the
 * truth. No money or slot write is ever held for later — a booking sent when the signal returns
 * could charge for a court somebody else took in the meantime.
 * </p>
 */
export class OfflineError extends Error {
  constructor() {
    super("This phone is offline, so nothing was sent.");
    this.name = "OfflineError";
  }
}

/** True when the phone says it has no network at all. A `true` from `onLine` proves nothing. */
export function phoneIsOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/**
 * How long any single API call may take before we give up on it.
 *
 * <p>
 * A stalled upstream — a wedged gateway, a backend hung on a slow query, a phone whose mobile
 * data dropped mid-request — never closes the socket, so `fetch` alone waits indefinitely.
 * The ceiling has to sit above a slow-but-real club connection and well below a member's
 * patience; 20s clears the slowest real response measured against this API by an order of
 * magnitude.
 * </p>
 */
export const REQUEST_TIMEOUT_MS = 20_000;

/** File uploads carry a phone photo over club WiFi, so they get their own, longer budget. */
export const UPLOAD_TIMEOUT_MS = 60_000;

/**
 * How long the wallet's SSE stream may say nothing at all before the client stops believing it.
 *
 * <p>
 * The server writes a keep-alive every 25s, so silence past two of them is not a quiet wallet —
 * it is a connection that is open and no longer carrying anything. That state is invisible from
 * `EventSource.onerror`, which is exactly how three finders watched a member's balance freeze
 * for the life of a tab with no reconnect ever attempted: the socket was healthy, the pushes
 * were not. 70s is two keep-alives plus enough slack that a phone briefly off the network does
 * not churn the connection.
 * </p>
 */
export const STREAM_SILENCE_MS = 70_000;

/**
 * `fetch` with a deadline. Rejects with a {@link NetworkError} rather than a bare
 * `DOMException`/`TypeError`, so callers have one type to catch and one place to ask
 * "was this the club refusing, or the club not answering?".
 */
export async function fetchWithTimeout(
  path: string,
  init: RequestInit,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  apiInFlight += 1;
  apiStarted += 1;
  try {
    return await fetch(path, { ...init, signal: controller.signal });
  } catch (cause) {
    throw new NetworkError(timedOut ? "timeout" : "unreachable", { cause });
  } finally {
    clearTimeout(timer);
    apiInFlight -= 1;
    if (apiInFlight === 0) for (const done of quietWaiters.splice(0)) done();
  }
}

/**
 * R4 (the first-Bookings regression) — the club's reads this tab has in flight, so a page's code
 * that is only a HINT (`routeChunks`: Wallet and Profile before they are opened) waits until the
 * open page's own reads have come back instead of queueing in front of them on a phone's six
 * connections. Streams (EventSource) are not counted; they never finish.
 */
let apiInFlight = 0;
/** Moves on every request, so a settle window that saw one start and finish is not "quiet". */
let apiStarted = 0;
const quietWaiters: (() => void)[] = [];
function nextQuiet(): Promise<void> {
  if (apiInFlight === 0) return Promise.resolve();
  return new Promise((resolve) => { quietWaiters.push(resolve); });
}
/**
 * Resolves once nothing has been in flight for `settleMs` — a page answers one read with the next
 * (the session check, then the page's own reads a render later), so "nothing right now" is not
 * "done". Measured (R4, :8088, slow 4G + 4x CPU): Bookings' code asked for beside the session
 * check made a cold My Code 0.9 s slower (2.65 → 3.55 s); asked for once My Code had settled, it
 * costs My Code nothing.
 */
export async function whenApiQuiet(settleMs = 300): Promise<void> {
  for (;;) {
    await nextQuiet();
    const before = apiStarted;
    await new Promise((resolve) => setTimeout(resolve, settleMs));
    if (apiInFlight === 0 && apiStarted === before) return;
  }
}

// Paths that should not trigger session-expired handling on 401. Login itself returns 401 on bad
// credentials, and the unauthenticated whoami probe is allowed to come back 401.
const UNAUTH_BYPASS = ["/api/v1/auth/login", "/api/v1/auth/webauthn/login", "/api/v1/whoami"];

/** `POST /auth/refresh` — with no bearer, the httpOnly `crusaders_rt` cookie is the credential. */
export const REFRESH_PATH = "/api/v1/auth/refresh";

/**
 * Paths whose 401 is never answered with a refresh (F4.1): the refresh itself — a refresh that
 * refreshed on its own 401 is the loop — and sign-out, whose session is ending on purpose.
 */
const NO_REFRESH = [REFRESH_PATH, "/api/v1/auth/logout"];

/**
 * F4.1 — one cookie exchange at a time, in this tab (the promise) and across tabs (a Web Lock).
 *
 * <p>
 * <b>Why single-flight matters here and not only for tidiness.</b> The refresh cookie ROTATES:
 * spending it issues a successor and marks it used, and the server treats a second spend of a
 * used link as a stolen token and revokes the whole family. Five screens that 401 together after
 * a phone wakes, or two tabs doing the same, would each spend the same cookie and sign the member
 * out everywhere — the outcome the cookie exists to prevent. So concurrent 401s share one
 * exchange, and an exchange that finds the stored token already replaced (by another tab, or by a
 * request that got there first) adopts it without spending anything.
 * </p>
 */
let refreshInFlight: Promise<RefreshOutcome> | null = null;

/**
 * An exchange stands between a member and every screen (it runs at boot, behind `whoami`), so it
 * gets a shorter budget than an ordinary call: a refresh endpoint that is absent answers at once,
 * and one that hangs must not hold the boot splash for the full twenty seconds.
 */
export const REFRESH_TIMEOUT_MS = 8_000;

/**
 * C1 — the session generation: moved by every sign-out, in this tab and (through shared storage)
 * in every other. An exchange records it before it spends the cookie and stores the answer only
 * if it is unchanged when the reply lands.
 *
 * <p>
 * <b>Why.</b> A refresh reply that completed after a sign-out stored its brand-new token and
 * resurrected the session: another tab signed out while this tab's exchange was on the wire, and
 * the member was signed back in on a phone they had just handed on (round 2, IX-H). The server
 * revokes the family on sign-out, but a reply already on its way carries a token minted a moment
 * before. Two halves, because either alone has a gap: an in-memory counter (this tab's sign-outs,
 * and the `storage` event another tab's raises here) and a counter in `localStorage`, read
 * synchronously at reply time, so it holds even when the reply beats that event. A token that
 * DISAPPEARED while the exchange was in flight is read the same way — somebody ended the session.
 * </p>
 */
const SESSION_GEN_KEY = "crusaders.mainframe.session-gen";
let localGeneration = 0;

function storedGeneration(): number {
  try { return Number(localStorage.getItem(SESSION_GEN_KEY) ?? "0") || 0; } catch { return 0; }
}

/** The current generation — opaque; compare for equality only. */
export function sessionGeneration(): string {
  return `${localGeneration}:${storedGeneration()}`;
}

/**
 * A sign-out here (`shared: true` also moves the stored half every other tab reads) or one learned
 * from another tab's `storage` event (`shared: false`). Any exchange in flight now discards its reply.
 */
export function endSessionGeneration(shared: boolean): void {
  localGeneration += 1;
  if (!shared) return;
  try { localStorage.setItem(SESSION_GEN_KEY, String(storedGeneration() + 1)); } catch { /* private mode */ }
}

/**
 * How an exchange ended (C2). Only `ended` — the server refused the cookie (a 401, or another
 * definite 4xx) — ends a session. `transient` is a 5xx, a 429, a timeout or no answer at all: the
 * token and cookie are kept, the request that needed the exchange fails with `error` (the club
 * could not be reached), and the next request — or the tab coming back into view — tries again
 * after a backoff.
 */
export type RefreshOutcome = { kind: "ok" } | { kind: "ended" } | { kind: "transient"; error: Error };

/** C2 backoff after transient exchange failures: 1 s, 2 s, 4 s … 30 s; any answer resets it. */
let transientFailures = 0;
let retryNotBefore = 0;
/** What the last transient exchange failed with — repeated inside the backoff (B-10: a 429 stays a 429). */
let lastTransient: Error | null = null;

/** Whether the last exchange failed transiently and nothing has answered since. */
export function refreshIsOwed(): boolean {
  return transientFailures > 0;
}

/** Test seam — forget the backoff between cases. */
export function resetRefreshBackoff(): void {
  transientFailures = 0;
  retryNotBefore = 0;
  lastTransient = null;
}

function noteOutcome(outcome: RefreshOutcome): RefreshOutcome {
  if (outcome.kind === "transient") {
    lastTransient = outcome.error;
    transientFailures += 1;
    retryNotBefore = Date.now() + Math.min(1000 * 2 ** (transientFailures - 1), 30_000);
  } else {
    resetRefreshBackoff();
  }
  return outcome;
}

/**
 * Trade the refresh cookie for a new access token. Never throws.
 *
 * @param staleToken the access token the caller sent and was refused on — how an exchange tells
 * "somebody already refreshed" from "nobody has".
 * @param options.now skip the backoff: the tab came back into view.
 */
export function refreshSession(staleToken: string | null, options?: { now?: boolean }): Promise<RefreshOutcome> {
  if (refreshInFlight) return refreshInFlight;
  if (!options?.now && transientFailures > 0 && Date.now() < retryNotBefore) {
    // Inside the backoff: a club that is restarting is not hammered by every screen at once.
    return Promise.resolve({ kind: "transient", error: lastTransient ?? new NetworkError("unreachable") });
  }
  refreshInFlight = withRefreshLock(() => exchangeCookie(staleToken))
    .then(noteOutcome)
    .finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new NetworkError("unreachable");
}

function withRefreshLock(run: () => Promise<RefreshOutcome>): Promise<RefreshOutcome> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks?.request) return run();
  // `request` resolves with the callback's own resolved value; the DOM typing nests the promise.
  return Promise.resolve(locks.request("crusaders.mainframe.refresh", run)).then(
    (outcome) => outcome as RefreshOutcome,
    (error: unknown): RefreshOutcome => ({ kind: "transient", error: asError(error) }),
  );
}

function replacedSince(staleToken: string | null): boolean {
  const current = tokenStore.get();
  return !!current && current !== staleToken;
}

const OK: RefreshOutcome = { kind: "ok" };
const ENDED: RefreshOutcome = { kind: "ended" };

async function exchangeCookie(staleToken: string | null): Promise<RefreshOutcome> {
  // Another tab (or an earlier exchange here) already did it: its token is in shared storage.
  if (replacedSince(staleToken)) return OK;
  // C1 — the session was ended while this waited for the lock: nothing to refresh.
  if (staleToken && !tokenStore.get()) return ENDED;
  const first = await postRefreshCookie(sessionGeneration());
  if (first !== "superseded") return first;
  // A concurrent spend from another tab won the race; the browser now holds its successor.
  if (replacedSince(staleToken)) return OK;
  const second = await postRefreshCookie(sessionGeneration());
  return second === "superseded" ? ENDED : second;
}

async function postRefreshCookie(generation: string): Promise<RefreshOutcome | "superseded"> {
  let res: Response;
  try {
    // No bearer on purpose (contract §1): the cookie is the credential, and an expired bearer
    // beside it is noise the server would have to reason about.
    res = await fetchWithTimeout(
      REFRESH_PATH, { method: "POST", credentials: "include", headers: { "content-type": "application/json" } }, REFRESH_TIMEOUT_MS,
    );
  } catch (error) {
    return { kind: "transient", error: asError(error) };
  }
  const payload = parseFailureBody(await res.text());
  if (!res.ok) return refusalOutcome(res.status, payload);
  const token = (payload as { access_token?: unknown } | null)?.access_token;
  if (typeof token !== "string" || !token) return ENDED;
  // C1 — signed out (here or in another tab) while the reply was on the wire: discard it.
  if (generation !== sessionGeneration() || !tokenStore.get()) return ENDED;
  tokenStore.set(token);
  return OK;
}

/**
 * C2 — which refusals end a session. A 401 does (`refresh_superseded` is another tab's win, not a
 * refusal). A 5xx, 429 or 408 is the club struggling, not the club saying no. Any other 4xx is a
 * definite answer and ends it, as before — and so is a 501: "there is no such endpoint" will
 * not change on a retry, and a gateway with no refresh route must not hold the boot forever.
 */
function refusalOutcome(status: number, payload: unknown): RefreshOutcome | "superseded" {
  if (status === 401 && bodyErrorCode(payload) === "refresh_superseded") return "superseded";
  if ((status >= 500 && status !== 501) || status === 429 || status === 408) return { kind: "transient", error: new ApiError(status, payload) };
  return ENDED;
}

/**
 * Whether a refused request may be retried after a refresh: a 401, on a request that carried a
 * token, not already a retry, on a path that is not itself the refresh (F4.1). A token-less
 * request never refreshes — a browser signed out while offline still holds a live cookie the
 * server never heard about, and a refused anonymous request must not quietly resurrect it.
 */
function mayRefresh(status: number, sentToken: string | null, path: string, retried: boolean): boolean {
  return status === 401 && !!sentToken && !retried && !NO_REFRESH.some((p) => path.startsWith(p));
}

let unauthorizedHandler: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null) { unauthorizedHandler = fn; }

/**
 * Told whenever the API refuses a call with <code>403 password_change_required</code>.
 *
 * <p>
 * L-F4. An admin pressing "Reset password" flips the flag on the server, and
 * <code>PasswordChangeGate</code> then refuses that member's session everywhere but the
 * change-password route. The client only ever learned about the flag from <code>whoami</code>
 * at boot, so an SPA route change after the flip rendered the new page against a stale
 * context and the 403s landed in each screen's own <code>catch</code>. A finder watched
 * Reports fill with em-dashes — <code>TOP-UPS — · SPENT — · TIME ON COURT —</code> — beside a
 * stale "-40.00 cr" in the header and a Download wallet CSV button, with no banner, no toast
 * and nothing in <code>[role=status],[role=alert]</code> at any sample. Only a full page load
 * re-read <code>whoami</code> and did the right thing.
 * </p>
 *
 * <p>
 * A single handler, wired once by <code>AuthProvider</code>, is the same shape as
 * {@link setUnauthorizedHandler} above and for the same reason: every screen makes requests,
 * and none of them should have to know about this rule.
 * </p>
 */
let passwordChangeRequiredHandler: (() => void) | null = null;
export function setPasswordChangeRequiredHandler(fn: (() => void) | null) { passwordChangeRequiredHandler = fn; }

/** The stable snake_case `error` token in a failure body, or null. */
function bodyErrorCode(payload: unknown): string | null {
  if (payload && typeof payload === "object" && "error" in payload) {
    const value = (payload as { error: unknown }).error;
    if (typeof value === "string") return value;
  }
  return null;
}

/**
 * Does this answer mean the browser is no longer carrying a session?
 *
 * <p>
 * A 401 on a request that DID carry a token is the ordinary case: expired, or revoked by a
 * sign-out. The second case is the one that cost a member a working tab. A token-less request
 * from a screen that believes it is signed in happens whenever another tab signs out — the
 * token lives in `localStorage`, which every tab shares — and the API cannot resolve a tenant
 * from a request with no credential at all, so it answers <b>400 `tenant_unresolved`</b>, not
 * 401. Branching on 401 alone therefore let that tab treat the end of its session as a network
 * fault: "Couldn't load the schedule. Check your connection and press Refresh." — forever,
 * because refreshing sends the same token-less request again.
 * </p>
 *
 * <p>
 * The status alone can never settle this, which is the same lesson as {@link ApiError.code}:
 * 400 covers a dozen refusals and only the stable snake_case token tells them apart.
 * </p>
 */
function isSessionEnded(status: number, hadToken: boolean, payload: unknown): boolean {
  if (status === 401) return true;
  if (hadToken || status !== 400) return false;
  const code = payload && typeof payload === "object" && "error" in payload
    ? (payload as { error: unknown }).error
    : null;
  return code === "tenant_unresolved";
}

/**
 * D4 — this tab's own money-moving requests, announced to whoever listens (the live balance).
 *
 * <p>
 * The wallet stream's frame for a member's own booking can land BEFORE the booking's HTTP answer
 * — the server publishes it straight after the commit — so marking the movement as the member's
 * own once the answer arrives was too late, and the chip raised "The club took 50.00 credits off
 * your wallet" over the page's own confirmation. Bracketing the request itself closes that race
 * for every spend path at once: book, bulk book, a share accepted, a top-up started, a cancel, and
 * an admin crediting their own wallet — rather than each screen remembering to say so.
 * </p>
 *
 * <p>
 * Mutations only, and only on the routes that can move this member's money. The stream ticket, the
 * inbox and preferences are POSTs too, and bracketing them would silence a partner's payment that
 * happened to land while the organiser was marking a notification read.
 * </p>
 */
const MONEY_PATHS = ["/api/v1/bookings", "/api/v1/invites/", "/api/v1/admin/bookings", "/api/v1/admin/minutes/", "/api/v1/minutes/purchase"];
export type MoneyRequestPhase = "start" | "end";
/** R18 X18-2 — which write it was; the SAME object is handed to its "start" and its "end". */
export type MoneyWrite = { method: string; path: string };
let moneyRequestListener: ((phase: MoneyRequestPhase, write: MoneyWrite) => void) | null = null;
export function setMoneyRequestListener(fn: ((phase: MoneyRequestPhase, write: MoneyWrite) => void) | null) { moneyRequestListener = fn; }

function movesMoney(method: string, path: string): boolean {
  return method !== "GET" && MONEY_PATHS.some((p) => path.startsWith(p));
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (!movesMoney(method, path)) return send<T>(method, path, body);
  const listener = moneyRequestListener;
  const write: MoneyWrite = { method, path };
  listener?.("start", write);
  noteWalletMoved();
  try { return await send<T>(method, path, body); } finally { noteWalletMoved(); listener?.("end", write); }
}

/* ─────────────────────────────── one wallet read, shared ─────────────────────────────── */

/**
 * Perf lane (2026-09-30) — the wallet was read twice on arrival: the credits chip's first read
 * and the page's own (`/wallet`, and the My Code checklist's), the same ledger page over the same
 * slow link at the same moment.
 *
 * <p>
 * A first-page read now JOINS a first-page read that is still IN FLIGHT when that one asked for
 * at least as many rows, for the same signed-in token, and nothing can have moved the money since
 * it was sent — no money-moving request of this tab's has started or finished, and no wallet
 * stream frame has landed (`noteWalletMoved`). Its rows are cut to the page asked for. A finished
 * read is never reused: a Refresh, or a read after a movement, always goes to the club.
 * </p>
 */
const WALLET_DEFAULT_LIMIT = 100; // the server's `limit ?? 100`
let walletEpoch = 0;
let walletInFlight: {
  token: string | null; epoch: number; limit: number; shareBookings: boolean; promise: Promise<WalletResponse>;
} | null = null;

/** A shared answer, cut to the page and the parts this reader asked for. */
function cutWallet(w: WalletResponse, want: number, shareBookings: boolean): WalletResponse {
  const cut = w.entries.length > want ? { ...w, entries: w.entries.slice(0, want), limit: want } : { ...w };
  if (!shareBookings) { delete cut.share_bookings; delete cut.share_places; }
  return cut;
}

/** Something may have moved this member's money: no wallet read sent before now may be joined. */
export function noteWalletMoved() {
  walletEpoch += 1;
}

function readWallet(limit?: number, offset?: number, shareBookings = false): Promise<WalletResponse> {
  const want = limit ?? WALLET_DEFAULT_LIMIT;
  const token = tokenStore.get();
  const firstPage = !offset;
  const shared = walletInFlight;
  // A read that brings the share summaries can answer one that does not want them; never the reverse.
  if (firstPage && shared && shared.token === token && shared.epoch === walletEpoch && shared.limit >= want
    && (shared.shareBookings || !shareBookings)) {
    return shared.promise.then((w) => cutWallet(w, want, shareBookings));
  }
  const include = shareBookings ? "share_bookings" : undefined;
  const promise = api.get<WalletResponse>(`/api/v1/wallet${qs({ limit, offset, include })}`);
  if (firstPage) {
    const entry = { token, epoch: walletEpoch, limit: want, shareBookings, promise };
    walletInFlight = entry;
    const done = () => { if (walletInFlight === entry) walletInFlight = null; };
    promise.then(done, done);
  }
  return promise;
}

async function send<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
  // R4 wave B — a write with no network at all is refused here, before anything is sent.
  if (method !== "GET" && phoneIsOffline()) throw new OfflineError();
  const sentToken = tokenStore.get();
  const res = await fetchWithTimeout(path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(sentToken ? { authorization: `Bearer ${sentToken}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const payload = res.ok ? (text ? JSON.parse(text) : null) : parseFailureBody(text);
  // Read the body FIRST: the token-less refusal is only distinguishable by the code inside it.
  if (isSessionEnded(res.status, !!sentToken, payload) && !UNAUTH_BYPASS.some((p) => path.startsWith(p))) {
    // F4.1 — an expired access token is not an ended session while the refresh cookie lives:
    // one exchange, then this request once more. A 401 was refused before the endpoint ran, so
    // repeating a mutation cannot do it twice.
    if (mayRefresh(res.status, sentToken, path, retried)) {
      const outcome = await refreshSession(sentToken);
      if (outcome.kind === "ok") return send<T>(method, path, body, true);
      // C2 — the club did not answer the exchange. The session stands (token and cookie kept);
      // this request fails as the club being unreachable, and the next one tries again.
      if (outcome.kind === "transient") throw outcome.error;
    }
    // Session expired, revoked, or signed out in another tab — drop the token and let the
    // AuthProvider say so and redirect to /login. Unless a NEW session has begun since this
    // request went out (C1): an old session's refusal must not end the next member's.
    if (!replacedSince(sentToken)) {
      tokenStore.clear();
      unauthorizedHandler?.();
    }
  }
  // The forced-password-change gate, which no screen should have to recognise for itself.
  if (res.status === 403 && bodyErrorCode(payload) === "password_change_required") {
    passwordChangeRequiredHandler?.();
  }
  if (!res.ok) throw new ApiError(res.status, payload);
  // R3-3 — the club's zone, learned wherever the club happens to mention it.
  //
  // Every response carrying one of the instants `lib/clubClock` writes carries `timezone` at
  // the top level: /me/door, /me/door/history, /admin/doors, /admin/doors/activity,
  // /admin/settings, the schedule day. One hook here is what makes a screen that forgot to
  // pass the field — or was handed a payload that did not have it — still print the club's
  // day rather than the reader's. It learns; it never guesses. See `lib/clubZone`.
  noteClubZoneFrom(payload);
  return payload as T;
}

/**
 * The body of a response that already failed, as far as it can be read.
 *
 * <p>
 * This used to be the same `JSON.parse` the success path uses, running BEFORE the
 * `ApiError` was constructed — so a failure whose body is not JSON never became an
 * `ApiError` at all. It reached the screen as a bare `SyntaxError`, every `instanceof
 * ApiError` branch missed it, and the member got whichever generic fallback the caller
 * passed. That is not an edge case: an HTML error page is exactly what a wedged gateway,
 * a proxy, a load balancer or a WiFi captive portal answers with, which is precisely when
 * a member most needs to be told the club's system is not answering rather than to refresh
 * the schedule and try again. Found in a browser against a real 502; a stub returning JSON
 * with a 502 status could never have shown it.
 * </p>
 *
 * <p>
 * The success path still parses strictly: a 200 whose body is not the JSON the caller
 * expects is a defect, and swallowing it would hide one.
 * </p>
 */
function parseFailureBody(text: string): unknown {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * Builds the {@link ApiError} for a failed response, with its body PARSED.
 *
 * <p>
 * Three endpoints hand-roll their own fetch because they are not JSON in, JSON out — two
 * multipart uploads and a CSV download — and all three threw
 * <c>new ApiError(res.status, await res.text())</c>. That puts a STRING on
 * <c>ApiError.payload</c>, and <c>errorCode()</c> reads <c>payload.error</c> off an object, so
 * it returned null for every one of them. Every stable error code those endpoints emit was
 * invisible to the screens calling them, which then fell through to their generic sentence.
 * </p>
 *
 * <p>
 * That is exactly how a missing tenant row reached the register screen as "that didn't work"
 * instead of "this club isn't set up yet" — the upload is the first call register makes, and
 * it is one of the three.
 * </p>
 */
async function failureFrom(res: Response): Promise<ApiError> {
  return new ApiError(res.status, parseFailureBody(await res.text()));
}

export const api = {
  get: <T>(p: string) => request<T>("GET", p),
  post: <T>(p: string, b?: unknown) => request<T>("POST", p, b),
  put: <T>(p: string, b?: unknown) => request<T>("PUT", p, b),
  patch: <T>(p: string, b?: unknown) => request<T>("PATCH", p, b),
  del: <T>(p: string, b?: unknown) => request<T>("DELETE", p, b),
};

// ---- Typed endpoints ----

export type WhoAmI = {
  tenant_slug: string; tenant_id: string; user_id: string | null; is_authenticated: boolean; is_admin: boolean;
  /**
   * Set while an admin-issued temporary password is still in force. It is on the bootstrap
   * probe and not only on the login response because the browser reloads: without it a member
   * who refreshes mid-forced-change renders the app and then meets a 403 on every screen
   * instead of the one screen they need.
   */
  must_change_password?: boolean;
};
export type LoginResponse = { access_token: string; user_id: string; is_admin: boolean; must_change_password?: boolean };

/**
 * The stable snake_case code the API puts on a refusal. Never shown to a member — every screen
 * maps it to a sentence — but the mapping has to start somewhere, and reading `err.payload.error`
 * off `unknown` at four call sites is how a screen ends up mapping every 400 to one message.
 */
export function errorCode(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const payload = err.payload as { error?: unknown } | null;
  return typeof payload?.error === "string" ? payload.error : null;
}
/**
 * Every ledger entry type the backend can emit.
 *
 * A real union rather than `string`, so adding a type on the backend without
 * teaching the frontend about it is a compile error here rather than a silent
 * gap in the admin filter. It was `string`, and the filter list below was a
 * hand-maintained array that had no relationship to it — nothing connected the
 * two, so a new type appeared in the ledger and was unfilterable, with no
 * warning anywhere.
 *
 * Keep in step with `LedgerEntryType` in the backend domain. The backend's
 * LedgerEntryTypeCoverageTests pins the member count, so the two cannot drift
 * far without something going red.
 */
export type LedgerEntryType =
  | "TopUp"
  | "BookingCharge"
  | "CancellationRefund"
  | "NoShowPenalty"
  | "LateCancellationPenalty"
  | "AdminAdjustment"
  | "PaymentReversal"
  | "LightsPurchase"
  /** The desk's cash / EFT / card-offline top-up (review round 1 B7): revenue, never an adjustment. */
  | "AdminTopUp"
  /**
   * D11 — a partner's share moving to the organiser: always a pair (one debit, one credit, both
   * naming the booking) that nets to zero club-wide. The trace word is `wallet.share_moved`.
   */
  | "ShareTransfer";

/** The filter list, derived from the union so the two cannot disagree. */
export const LEDGER_ENTRY_TYPES: readonly LedgerEntryType[] = [
  "AdminAdjustment",
  "AdminTopUp",
  "BookingCharge",
  "CancellationRefund",
  "LateCancellationPenalty",
  "LightsPurchase",
  "NoShowPenalty",
  "PaymentReversal",
  "ShareTransfer",
  "TopUp",
];

export type LedgerRow = {
  id: string;
  at: string;
  from: string;
  to: string;
  amountMinutes: number;
  signedAmountMinutes: number;
  type: LedgerEntryType;
  comment: string;
  subjectUserId: string;
  subjectName: string;
  actorUserId: string;
  actorName: string;
  relatedBookingId: string | null;
  /** C5 / R15 E15-9 — on a share transfer with an owned twin: the other member of the pair. Null / absent otherwise. */
  counterparty_name?: string | null;
  /** C5 — that member's user id. Null / absent on every other row. */
  counterparty_user_id?: string | null;
  /**
   * R16 J16-2 (BE16b) — on a share row, why it moved (`player_added`, …), as the live frame says it.
   * Absent from an older API.
   */
  share_cause?: string | null;
  /** R16 E16-7 (BE16b) — who acted, when not the member themself or the club's system. */
  actor_name?: string | null;
};

export type WalletResponse = {
  balance_minutes: number;
  /** D11 §3a — shares received as an organiser, held until `held_until`. Absent before P11. */
  held_minutes?: number;
  /** The balance less what is held: what a booking or a share may spend. */
  spendable_minutes?: number;
  /** The earliest release, or null when nothing is held. */
  held_until?: string | null;
  /**
   * P11 — owed back to partners whose return waits on this balance; paid first from incoming
   * credit, no release date. `spendable_minutes` subtracts it too, so it may be negative.
   * Absent from an older API: read as 0.
   */
  owed_back_minutes?: number;
  entries: LedgerRow[];
  /** Every movement the member has ever had; `entries` is one page of them. */
  total_entries: number;
  offset: number;
  limit: number;
  /**
   * Only with `include=share_bookings` (perf round, 2026-09-30): what each ShareTransfer row's
   * booking needs for its line — the first 20 distinct booking ids on the page. `null` is a booking
   * the member can no longer read (a declined or removed seat: the old 404).
   */
  share_bookings?: Record<string, ShareBookingSummary | null>;
  /**
   * R14 E14-7 — with `include=share_bookings`: the court and start of every booking the share rows
   * name, readable or not (a member taken off a game still sees where their share was). Null without
   * the include; absent from an older API.
   */
  share_places?: Record<string, SharePlaceWire> | null;
};
export type SharePlaceWire = { court_name: string | null; starts_at: string };
export type ShareBookingSummary = {
  booking_id: string;
  court_name: string | null;
  starts_at: string;
  organiser: { user_id: string; name: string | null; photo_url: string | null };
  partners: { user_id: string; name: string | null; paid_minutes: number }[];
};
export type ScheduleSlot = {
  courtId: string; courtNumber: number;
  startsAtUtc: string; endsAtUtc: string;
  status: string;
  ownerUserId: string | null;
  ownerFirstName: string | null;
  ownerPhotoUrl: string | null;
  isMine: boolean;
  bookingId: string | null;
  blockLabel: string | null;
  /** Whether the lights have been on. Null for another member's booking — attendance is not public. */
  checkedIn: boolean | null;
  /** What the booking cost. Null for another member's booking, for the same reason. */
  amountChargedMinutes: number | null;
  /**
   * The viewer's side of a booking that `isMine` (review round 1, B2): `partner` for an accepted
   * seat on somebody else's game — theirs to open, never to cancel. Absent on an older API and
   * null on everybody else's.
   */
  role?: "organiser" | "partner" | "payer" | null;
};
export type ScheduleCourt = {
  id: string; courtNumber: number; name: string;
  /**
   * D2-B34. A court the club has retired still carries bookings, and dropping it from the grid
   * hid them from the members who had paid for them. It is rendered and inert instead. Absent
   * on an older API, which is why it is `!== false` that the grid tests, never `=== true`.
   */
  isActive?: boolean;
};

/**
 * `/schedule`'s `rules` block — this viewer's own booking rules, for THIS club day.
 *
 * <p>
 * D2 §4.4. Every field is optional because the backend that computes them is being built
 * alongside this screen; `lib/gridRules` is the only thing that reads this type, and it treats
 * every absent field as "no rule", never as "refused". Both spellings of every key are
 * accepted there — see that module for why.
 * </p>
 */
export type ScheduleRulesWire = {
  clubDay?: string;
  groups?: { id?: string; name?: string; description?: string | null }[];
  /** The intersection of the viewer's groups' windows with the club's hours, for this weekday. */
  allowedWindows?: { start: string; end: string }[];
  clubHours?: { start: string; end: string } | null;
  maxSlotsPerDay?: number | null;
  maxMinutesPerDay?: number | null;
  bookedSlotsToday?: number | null;
  bookedMinutesToday?: number | null;
  /** `min(slot headroom, floor(minute headroom / sliceMinutes))`, floored at 0. Null for an admin. */
  remainingToday?: number | null;
  advanceBookingDays?: number | null;
  /** True ⇒ no cap and no window applies, and `remainingToday` is null rather than a number. */
  adminExempt?: boolean;
  /** D2 §4.3 — the member's groups have no overlapping window at all on this weekday. */
  emptyWindowReason?: { groups: string[]; day: string } | null;
};

export type ScheduleDay = {
  date: string; timezone: string; sliceMinutes: number;
  /** The club's opening and closing for THIS day, minutes past local midnight — per weekday, not a flat pair. */
  dayStartMinute: number; dayEndMinute: number; advanceBookingDays: number;
  penaltyPct: number; penaltyWindowMinutes: number;
  /**
   * The peak-hours priority rule (A.12, D2: granted by a group with peak priority), as it applies to THIS viewer.
   *
   * <p>
   * Optional because the client must degrade towards showing a slot rather than hiding one: a
   * payload without these fields is an older API, and a grid that greyed cells out on a missing
   * field would refuse bookings the club would happily take. `peakStartMinute` / `peakEndMinute`
   * are minutes past local midnight and are null when `peak_hours` is unset or malformed;
   * `viewerMayBookPeak` is true for an admin and for a member whose groups grant peak priority — the two the rule
   * never refuses.
   * </p>
   */
  peakStartMinute?: number | null; peakEndMinute?: number | null;
  peakAdvanceHoursForRegular?: number; viewerMayBookPeak?: boolean;
  /** Items 3 + 19, in one read. Absent on a server that does not know about groups or slot caps. */
  rules?: ScheduleRulesWire;
  courts: ScheduleCourt[]; slots: ScheduleSlot[]
};

/**
 * One row of a bulk outcome, as it comes off the wire.
 *
 * <p>
 * Deliberately loose: every field is optional and is read by `components/bookings/bookFlow.ts`
 * and `cancelFlow.ts`, which check each key's type and count an unrecognised status as a
 * failure — a cancellation this client cannot describe is not one it should report as done.
 * </p>
 */
export type BulkResultRow = Record<string, unknown>;

export type BulkCancelResponse = {
  requested?: number; succeeded?: number; failed?: number;
  total_refunded_minutes?: number; total_penalty_minutes?: number;
  results?: BulkResultRow[];
} & Record<string, unknown>;

export type BulkBookResponse = {
  requested?: number; succeeded?: number; failed?: number;
  total_charged_minutes?: number;
  payer?: { user_id?: string; name?: string; balance_before_minutes?: number; balance_after_minutes?: number };
  results?: BulkResultRow[];
  /** D2 §5.3 — the batch stopped here because the payer ran out of credit. */
  halted_at?: number; halted_reason?: string;
} & Record<string, unknown>;

/**
 * R19 — what an admin booking would cost its payer and where it leaves them, BEFORE anything is
 * booked (`GET /api/v1/admin/bookings/quote`). `overdraws` is exactly the guard the POST applies
 * (`balance < price`), so it is true precisely when a booking sent without
 * `allowNegativeBalance` would be refused — which is what lets the sheet send the flag
 * deliberately instead of learning about a short wallet from a 402 and trying again.
 * A refusal the booking would meet (slot taken, past time…) comes back as the SAME error the
 * POST would give, so one decoder serves both.
 */
export type AdminBookingQuote = {
  user_id: string;
  court_id: string;
  court_name: string | null;
  starts_at: string;
  ends_at: string | null;
  slices: number;
  price_minutes: number;
  balance_minutes: number;
  balance_after_minutes: number;
  /** P13 §3.11 — `spendable_minutes < price_minutes`, exactly the guard behind 402. */
  overdraws: boolean;
  /** P13 §3.11 — the balance less what is held and owed back. Absent from an older API. */
  spendable_minutes?: number;
  /** D11 §3a — the payer's held minutes. Absent from an older API. */
  held_minutes?: number;
  /** P11 — what the payer owes back to partners, paid from their next credit. Absent: 0. */
  owed_back_minutes?: number;
};

/** One line of a bulk quote. `reason` is a booking refusal code when `bookable` is false. */
export type AdminBulkQuoteItem = {
  index: number;
  court_id: string;
  court_name: string | null;
  starts_at: string;
  slices: number;
  price_minutes: number | null;
  bookable: boolean;
  reason: string | null;
};

/** `POST /api/v1/admin/bookings/bulk/quote` — the batch version of {@link AdminBookingQuote}. */
export type AdminBulkQuote = {
  user_id: string;
  total_minutes: number;
  balance_minutes: number;
  balance_after_minutes: number;
  overdraws: boolean;
  /** As on {@link AdminBookingQuote}: absent from an older API, and read as 0. */
  spendable_minutes?: number;
  held_minutes?: number;
  owed_back_minutes?: number;
  items: AdminBulkQuoteItem[];
};

/** One item of a member bulk booking's answer (D8). `reason` is a refusal code when refused. */
export type MemberBulkResultRow = {
  index: number;
  court_id: string;
  court_name: string | null;
  starts_at: string;
  ends_at: string | null;
  status: "booked" | "refused";
  reason: string | null;
  booking_id: string | null;
  amount_minutes: number | null;
  /** True when this item landed under the same idempotency key on an earlier try. */
  replayed: boolean;
};

/**
 * D8 — `POST /api/v1/bookings/bulk`, the member's multiselect. `total_charged_minutes` counts
 * every booked item including replays; `charged_now_minutes` is what THIS request debited, which
 * is what the balance pair moved by. `halted_reason: "insufficient_balance"` means the member ran
 * out part-way: the rest are `not_attempted`, and a retry under the SAME key books only those.
 */
export type MemberBulkBookResponse = {
  requested: number;
  booked: number;
  refused: number;
  total_charged_minutes: number;
  charged_now_minutes: number;
  balance_before_minutes: number;
  balance_after_minutes: number;
  halted_at: number | null;
  halted_reason: string | null;
  results: MemberBulkResultRow[];
};

/** The item shape both bulk book routes share (camelCase, as every POST body here). */
export type BulkBookItemBody = { courtId: string; startsAt: string; sliceCount: number };

/** What cancelling a booking would cost right now — server-computed, read when the modal opens. */
export type CancellationQuote = {
  bookingId: string;
  amountChargedMinutes: number;
  /** What actually lands back in the wallet: the refund NET of any penalty. */
  refundMinutes: number;
  penaltyMinutes: number;
  penaltyPct: number;
  penaltyWindowMinutes: number;
  insidePenaltyWindow: boolean;
  checkedIn: boolean;
  alreadyStarted: boolean;
};

export type AdminSettings = {
  slice_minutes: number;
  advance_booking_days: number;
  day_start_minute: number;
  day_end_minute: number;
  penalty_pct: number;
  grace_window_minutes: number;
  penalty_window_minutes: number;
  timezone: string;

  /** What each of a court box's eight buttons does, by physical position. */
  button_map: string[];

  /**
   * When the club is open, per weekday: `{"mon": "06:00-22:00", "sat": "07:00-20:00"}`.
   *
   * <p>
   * This is the setting `BookingService` actually enforces. `day_start_minute` /
   * `day_end_minute` above are only the default for a weekday this map does not name — and
   * because the seed names all seven, the flat pair governed nothing at all while it was the
   * only thing the settings screen could edit. Optional here so an older API that does not
   * send it simply shows no weekly table rather than an empty one.
   * </p>
   */
  operating_hours?: Record<string, string>;

  // The nine keys the engine has always read and this API never showed. Until they
  // were surfaced the only way to change one was to hand-edit a JSON column on a
  // live money system.
  member_per_day_max_minutes: number;
  peak_hours: string;
  peak_advance_hours_for_regular: number;
  retention_years: number;
  no_show_lookback_days: number;

  // The six court-box and identification numbers (WI-2). Served by GET /admin/settings
  // since the programme added them, but until now absent from this type, the save
  // mapper and the Settings page — so an admin could see none of them and change none
  // of them. Bounds are the API's (AdminConfigEndpoints.ValidateDeviceNumbers).
  /** 1–90. The relay bank's hard cap is 90; a setting above it sells minutes the lights cannot deliver. */
  walk_up_max_minutes: number;
  /**
   * 15–300. The box clamps its own cadence to this range, so a value outside it is not
   * what the fleet runs — and the Devices page derives "offline" from three missed
   * beats of it (review finding 22).
   */
  heartbeat_seconds: number;
  /** 1–1440. How far ahead of a booking a scan may activate it. */
  activation_forward_window_minutes: number;
  /** 0–1440, and never more than the forward window. */
  activation_cue_window_minutes: number;
  /** 15–3600. How long an ident code (walk-up / pay-for-someone) lives. */
  qr_lifetime_seconds: number;
  /**
   * 5–1440. How far ahead the box's offline roster reaches.
   *
   * <p>
   * It reaches the DOORS as well, which is the half its name does not say: under the default
   * `active_member` policy this plus {@link AdminSettings.activation_cue_window_minutes} is
   * how early a booking's own QR opens a door, capped at four hours. Raising it to give the
   * boxes a longer outage cushion widens every door in the club by the same amount.
   * </p>
   */
  roster_window_minutes: number;

  /**
   * 5–1440. The least time between two "not reporting" emails about the same board.
   *
   * <p>
   * A device number rather than a door one: a court box that goes quiet flaps exactly as a
   * door does, and this bounds both. A gate no admin has named is never alerted on at all,
   * which is a separate rule and not a consequence of this one.
   * </p>
   */
  device_alert_cooldown_minutes: number;

  // The three door-gate numbers. A gate is a second kind of board — one ESP32 on a door,
  // a QR scanner and a lock relay — and none of the six above say anything about it.
  /** 1–30. How long the lock is released per open. The firmware caps it at 30 s whatever this says. */
  gate_unlock_seconds: number;
  /** Who may open a door at all. See {@link GATE_ACCESS_POLICIES}. */
  gate_access_policy: GateAccessPolicy;
  /**
   * 0–240. How long before a booking starts its holder may come in. It is both the early
   * edge of the `booking_window` policy and how far ahead a door's cached roster reaches,
   * so lowering it narrows the offline fallback as well as the online decision.
   */
  gate_early_entry_minutes: number;

  // doors: admin — W1's five new tenant settings (WIRE-W1 §6). Optional, because an older
  // API does not serve them and `deviceNumbersComplaint`'s rule is that an absent key is not
  // a complaint: omitted means unchanged on the way back, so a console talking to an API
  // without them must not refuse to save.
  /** 7–730, default 90. How long a door scan is kept before it is DELETED, receipts and all. */
  door_log_retention_days?: number;
  /** 3–100, default 8. Refusals at one door inside the window below before the tile says so. */
  door_refusal_spike_count?: number;
  /** 5–240, default 20. The window that count is measured over. */
  door_refusal_spike_minutes?: number;
  /** ≤32 chars, may be empty. What a member sees when a door turns them away. */
  club_contact_phone?: string;
  /** ≤254 chars, may be empty. The same, by mail. */
  club_contact_email?: string;

  // ---------------------------------------------------------------------------------------
  // eco — everything this release made configurable (ruling 13, D2 §14).
  //
  // ALL optional, and that is load-bearing rather than cautious: three backend lanes are
  // writing these keys in parallel with the screen that reads them, so an API that does not
  // serve one gets no row for it and no complaint about it. Bounds, labels and the sentences
  // live in `lib/ecoSettings.ts`, which is where a test walks them against D2's table.
  // ---------------------------------------------------------------------------------------

  /** 5–120, default 10. GOAL item 1: how long the box's screen holds a result before it
   *  goes back to "Scan code to get started". Reaches the box on its next heartbeat. */
  lcd_revert_seconds?: number;
  /** 0–60, default 10. GOAL item 18: how long the box stays ready for the next person to
   *  scan, with the time left shown. 0 turns rapid scanning off. */
  rapid_scan_window_seconds?: number;
  /** 0–96, default 4. GOAL item 19, in SLOTS (ruling 3). 0 = no limit; admins are exempt.
   *  Composes with {@link AdminSettings.member_per_day_max_minutes} — most restrictive wins. */
  member_max_slots_per_day?: number;
  /** 1–500, default 100. How many slots one bulk book or cancel may carry. */
  admin_bulk_max_items?: number;
  /** 7–365, default 60. How far ahead a repeating booking is written into the diary. Must
   *  be ≥ `advance_booking_days`, or a member books into a league night that does not exist. */
  schedule_materialisation_days?: number;
  /** 100–20000, default 2000. The refusal that stops one mistyped end date holding the club. */
  schedule_max_rows_per_change?: number;
  /** 7–730, default 90. Resolved faults are deleted after this; open ones are aged out and
   *  KEPT, so the club's own count of open faults stays honest. */
  device_error_retention_days?: number;
  /** 20–2000, default 200. Past this, one board's new faults are counted rather than kept. */
  device_error_max_open_rows?: number;
  /** 5–55, default 25. Under the gateway's 60-second idle close, which is the whole reason
   *  for the upper bound — above it a live connection drops and reconnects for ever. */
  sse_keepalive_seconds?: number;
  /** 1–10, default 3. Consecutive live-connection failures before a screen falls back to
   *  re-reading on a timer — and says on screen that it has. */
  realtime_fallback_after_failures?: number;
  /** 5–120, default 10. The control board's timer, once the live connection is given up on. */
  realtime_poll_seconds_control_board?: number;
  /** 30–3600, default 300. A full re-read, so a wall screen that missed one update is wrong
   *  for at most this long rather than for the rest of the evening. */
  control_board_resync_seconds?: number;
  /** The symbol this club's REAL MONEY figures wear, default `R`. 1–4 letters or currency
   *  signs. It is NOT the credit unit — credits convert at `credits_per_zar_*` and keep a
   *  unit of their own; see `lib/currency.ts`. */
  currency_symbol?: string;
  /** GOAL item 6's kill switch, default true. False makes the trace route answer 404 —
   *  never 403, which would confirm the surface exists and that this member has one. */
  member_trace_enabled?: boolean;
};

/**
 * Who a door opens for.
 *
 * <p>
 * `active_member` is the default: any member the scan resolves opens the door unless their
 * membership is barred. `booking_window` narrows it to a member whose booking is running, or
 * starts within `gate_early_entry_minutes`. A CLUB ADMIN passes that booking check whatever
 * they have booked — the exemption is keyed on `User.IsAdmin`, not on the absence of a
 * membership row, and there is no "operator" role in this product for it to be keyed on.
 * Neither policy waives the barred check: a suspended, pending or rejected membership is
 * turned away, admin or not.
 * </p>
 *
 * <p>
 * Neither policy says anything about which CODE was presented, and a booking's activation
 * code is narrower than both: it opens a door only inside its own booking's window, and never
 * for a booking the club cancelled or blocked. One swept as a no-show or marked completed still
 * counts. A member's own ident code is what the policy names.
 * </p>
 *
 * <p>
 * And neither says anything about the OFFLINE case: a door that cannot reach the API falls
 * back to its cached roster, which holds bookings and nothing else, so offline only a booked
 * member gets in whichever of these is set — and a door nobody has named is sent no roster,
 * so it gets nobody in at all.
 * </p>
 */
export const GATE_ACCESS_POLICIES = ["active_member", "booking_window"] as const;

export type GateAccessPolicy = (typeof GATE_ACCESS_POLICIES)[number];

/**
 * What a settings save may carry. The eight booking fields are required because every
 * form shows them; everything else is optional, and omitting it means unchanged.
 */
/**
 * The settings PUT.
 *
 * <p>
 * `timezone` used to be excluded here, which was this type honestly describing a
 * one-way field: the GET served it, the request record on the API had no member for it,
 * and a club in another zone read its whole booking grid in South African wall-clock time
 * with no correction short of an UPDATE on a JSON column. It is optional like the rest —
 * omitted means unchanged — so a screen that edits only booking settings cannot reset it.
 * </p>
 */
export type AdminSettingsSave =
  Pick<AdminSettings, "slice_minutes" | "advance_booking_days"
    | "day_start_minute" | "day_end_minute" | "penalty_pct" | "grace_window_minutes"
    | "penalty_window_minutes">
  & Partial<AdminSettings>;

/**
 * A court box, as the admin surface sees it.
 *
 * <p>
 * There is no per-device key here any more, and no claim, revoke or rotate. One static
 * API key per tenant authenticates every box, and a box that presents it and a device
 * code the club has never seen registers itself on that first heartbeat. What is left on
 * this row is identity the box reported and configuration an admin owns.
 * </p>
 */
export type AdminDevice = {
  id: string;
  device_code: string;
  name: string;
  /**
   * `"CourtBox"` or `"Gate"`, and NOT editable from here: the row's kind is set by the
   * board's first heartbeat and the API has no member for it on the update. Re-kinding a
   * board means deleting the row and letting it register itself again.
   */
  kind: string;
  hardware: string;
  /**
   * The courts this box drives, in relay order: index 0 is relay A, index 3 is relay D.
   * One box, up to four courts — a court box is not "the box for court N" any more.
   * Always empty for a gate: a door drives no courts, and the API refuses
   * `court_numbers` on a Gate row outright (`court_fields_on_a_gate`).
   */
  court_numbers: number[];
  /**
   * Which door this is — "front-door", "changing-rooms" — or null while nobody has named
   * it. Gates only, at most 64 characters, and the one thing that distinguishes one door
   * from another: there is ONE firmware for every door and nothing per-gate is compiled in.
   */
  gate_key: string | null;
  /** Read-only identity the box reported. Nothing is authenticated against it. */
  mac_address: string | null;
  enabled: boolean;
  last_seen_at: string | null;
  last_ip_address: string | null;
  running_version?: string | null;
  mega_version?: string | null;
  created_at: string;
  /**
   * True until an admin edits this row.
   *
   * <p>
   * A box registers itself on its first heartbeat, which means it arrives named
   * `box-xxxxxx` and driving whatever courts the API defaulted it to — almost certainly
   * the wrong ones. The badge this drives is the only thing standing between that and a
   * league night where button 1 lights the wrong court, so it stays up until somebody
   * has actually looked.
   * </p>
   */
  auto_registered: boolean;
  /**
   * This box's own button map, or null to use the club's. Optional because the field
   * is landing on the API alongside this screen: the per-box editor renders only when
   * the payload actually carries it, so an older API simply shows no override.
   */
  button_map?: string[] | null;
  /**
   * The interval this box is actually running, seconds — the tenant setting after the
   * firmware's own 15-300 clamp. Never read the raw tenant setting as if it were what
   * the box runs: a club that sets 600 has boxes calling in every 300, and the
   * difference is the whole of "the entire fleet reads offline" (review finding 22).
   */
  effective_heartbeat_seconds?: number;
  /**
   * How long since the last beat before this box is offline, seconds. The API's own
   * arithmetic, so the screen and the fleet agree; absent, the screen derives it from
   * the cadence above rather than from a frozen literal.
   */
  offline_after_seconds?: number;
};

/**
 * Is this row a door gate rather than a court box?
 *
 * <p>
 * The wire spelling lives here, once, beside the type that carries it. It was inline as
 * `device.kind !== "Gate"` on the Devices page and nowhere else; the moment a second module
 * had to answer the same question — `deviceCoverage`, which must ignore gates entirely — a
 * second copy of the literal was the obvious next step, and a typo in either one is a gate
 * silently treated as a box.
 * </p>
 */
export function isGate(device: Pick<AdminDevice, "kind">): boolean {
  return device.kind === "Gate";
}

/**
 * A member the server resolved for one activity row.
 *
 * `name` is a display name, never an email or a membership number — the same rule the
 * booking grid is held to. The id is here so a row can be linked to a member later; it is
 * not rendered.
 */
export type DeviceActivityMember = { id: string; name: string };

/**
 * How many activity rows a panel asks for. The API's own default, and its documented
 * maximum is 200 — this page shows one screenful of recent history, not an archive.
 */
export const DEVICE_ACTIVITY_LIMIT = 50;

/**
 * One row of a board's own trail, as `GET /admin/devices/{id}/activity` serves it
 * (B5), newest first.
 *
 * <p>
 * This is a READER over the audit trail, and it is deliberately narrow: the endpoint never
 * returns raw `DetailsJson` and never returns a token. What reaches this type is the
 * decoded subject — a resolved member, or the non-reversible short fingerprint of the code
 * that was presented — and nothing that could be replayed at a door.
 * </p>
 */
export type DeviceActivityEntry = {
  /** When it happened. UTC. */
  at: string;
  /**
   * What happened, as the audit trail spells it: `gate.opened`, `gate.denied_<reason>`,
   * `device.gate_open` (an open the BOARD decided while offline and uploaded later),
   * `device.unknown_scan` (an offline refusal, which names nobody by construction), plus
   * the court box's own `device.activation` / `device.release` / `device.boot`.
   *
   * <p>
   * Left as an open string rather than a union on purpose. The set grows from the firmware
   * side, and a union here would make a new action a type error on a screen whose job is to
   * show it — see `describeActivityAction`, which renders an unrecognised action readably
   * rather than hiding it.
   * </p>
   */
  action: string;
  /** The door's refusal reason where there is one — `too_early`, `no_booking`, … */
  reason: string | null;
  /** True when the BOARD decided this by itself and uploaded the row afterwards. */
  offline: boolean;
  /**
   * When the club was TOLD about an offline row, as opposed to when the scan happened.
   *
   * <p>
   * A4: a reviewer read "Last heard from 21:00" beside scans "decided at the door at 21:25"
   * and could not reconcile them, because an offline row is stamped with the SCAN and
   * arrives whenever the board next calls in. The two are different facts and the row says
   * so. Optional — where the API does not carry it the copy says the club was told when the
   * door next called in, which is true without naming a time it does not have.
   * </p>
   */
  delivered_at?: string | null;
  /**
   * `at` is the SCAN instant; `delivered_at` is when the club was told, and is non-null on
   * offline rows ONLY. Lists are ordered, paged and counted on the DELIVERY axis, so an
   * offline row's `at` may be older than the rows around it — which is not a sorting fault
   * and must not be rendered as one.
   */
  /** The member, when `SubjectUserId` resolved to one. Null on an unknown code and on a boot. */
  member: DeviceActivityMember | null;
  /** First eight hex of the code's SHA-256 (B4) — the only thing that correlates two scans of one unknown code. */
  fingerprint: string | null;
  /**
   * <b>WIRE-R3 §2 — this row's time cannot be trusted to the minute.</b>
   *
   * <p>
   * True when the server clamped the board's own clock, or when `delivered_at` is EARLIER
   * than `at` — which is impossible and is what a reviewer met as "the door told us at 19:22"
   * about a 19:48 scan. A board has no RTC; it reports an offset from its own boot, and a
   * board whose clock has drifted hands the server a scan instant from the future or the
   * past. The server already wrote `device.event_time_clamped` about it and the row said
   * nothing.
   * </p>
   *
   * <p>
   * <b>Absent is not false.</b> An API that does not send it has not said the time is sound;
   * it has said nothing. The screens treat `undefined` as "no reason to doubt this row" —
   * which is the same render as `false` — but never state the row as VERIFIED on the strength
   * of an absent field, and the impossible-order guard below runs from the instants
   * themselves, so a row an older API cannot flag is still not printed in an order that
   * cannot have happened.
   * </p>
   */
  time_uncertain?: boolean;
};

/**
 * Something that happened TO a door, as opposed to a scan AT one.
 *
 * <p>
 * <b>It exists because the two were one list and the screen could not tell them apart.</b>
 * `GET /admin/devices/{id}/activity` returns every audit row carrying the board's
 * `device_id`, so an admin's own edit (`device.updated`) arrived in the same array as a
 * refusal and was rendered as a green "Refused" chip — a door with thirteen edits and no
 * scans reported "13 refused scans". The backend now separates them; this is the second
 * half.
 * </p>
 *
 * <p>
 * <b>Optional on the way in, on purpose.</b> The page must be correct against an API that
 * does not send it yet, so the feed derives its own event rows from `items` when `events` is
 * absent and shows them exactly the same way. A shape that only works against the new
 * backend is a page that is wrong for as long as the two lanes are out of step.
 * </p>
 */
/**
 * WIRE-R2 §2's `change` vocabulary — what an event actually WAS.
 *
 * <p>
 * `kind` could not say. The backend wrote `device.updated` for a rename, a details change, a
 * shut and a reopen alike, so nine identical "details or state were changed" rows sat on one
 * door's page and told an admin nothing (A5). The server now derives `change` from the audit
 * details it writes, and `other` is the honest arm for a row written before it did.
 * </p>
 */
/**
 * <b>Both spellings of the two that were renamed, and neither is dropped.</b>
 *
 * WIRE-R2 §2 wrote `details` and `removed`; WIRE-R3 §6 names the same two facts
 * `details_changed` and `deleted`. A screen that knows only one spelling renders the other as
 * "Unrecognised event" — which is what the honest arm is FOR, and is the wrong answer when
 * the event is one we have copy for under its other name. Rows written under either spelling
 * are inside retention at the same time, so both have to resolve for as long as the older
 * ones survive.
 */
export const DOOR_EVENT_CHANGES = [
  "registered", "renamed", "details", "details_changed", "shut", "reopened", "shut_all",
  "reopened_all", "removed", "deleted", "clock_corrected", "other",
] as const;

export type DoorEventChange = (typeof DOOR_EVENT_CHANGES)[number];

export type DoorEventEntry = {
  at: string;
  /** The raw audit token, carried so an unrecognised event is still reportable upstream. */
  action: string;
  /**
   * `registered` · `edited` · `removed` · `clock_corrected` · `unrecognised`.
   *
   * <p>
   * Kept for compatibility (WIRE-R2 §2) and no longer the field the copy is chosen by:
   * `edited` was ONE kind covering rename, details change, shut and reopen, so the screen
   * could only say "this door's details or state changed" about all four. {@link change} is
   * what a row is rendered from now; `kind` is what an older API still sends.
   * </p>
   */
  kind: string;
  /**
   * What actually changed, where the API is new enough to say (WIRE-R2 §2).
   *
   * Absent on an older API, in which case the page falls back to `kind` and says the broad
   * thing rather than guessing a verb it does not have.
   */
  change?: DoorEventChange | string;
  /**
   * The admin who did it, or null for a board-side event.
   *
   * <p>
   * Admins see admins: this is the club's own admin audit, not member tracking, and P3 is
   * about members. A5's finding was a card reading "You shut this door." to every admin in
   * the club, including the four who did not.
   * </p>
   */
  actor_name?: string | null;
  /**
   * How many identical events this row stands for (WIRE-R3 §6).
   *
   * <p>
   * A-L4: nine "the board's clock was out and was corrected" rows, all inside one minute,
   * filled a door's whole event block and said one thing nine times. The server groups them
   * and sends the count. Absent, or 1, means the row is itself and the copy adds nothing —
   * and a count is never invented on this side from rows that merely look alike.
   * </p>
   */
  count?: number;
};

/**
 * What the per-board activity route answers: the scans, and — where the API is new enough —
 * the non-scan events beside them rather than mixed into them.
 */
export type DeviceActivityPage = {
  items: DeviceActivityEntry[];
  /** Always present for a gate; `[]` for a court box. Optional only for an older API. */
  events?: DoorEventEntry[];
};

/**
 * The club's one device API key.
 *
 * <p>
 * Static, per tenant, and flashed into every box's `secrets.h`. It is not shown once and
 * then derived away — the API can and does hand it back on every GET, because a club
 * that adds a ninth box next season has to be able to read it again. That is the trade
 * this contract makes: a key an admin can always retrieve, in exchange for no claim
 * codes, no discovery listener and no per-device key to lose.
 * </p>
 */
export type DeviceApiKey = {
  api_key: string;
  regenerated_at: string;
};

/**
 * The single rotating member code (D1) — the enrolment answer. `docs/specs/member-code.md` §10.
 *
 * <p>
 * `secret` is the member secret S, 32 bytes as unpadded base64url. It is on the wire exactly
 * once, is imported on arrival as a non-extractable WebCrypto key, and must never be logged,
 * stored as text or passed anywhere else (`lib/memberCode/lifecycle.ts`).
 * </p>
 */
export type MemberCodeEnrolment = {
  v: number;
  ref: string;
  generation: number;
  secret: string;
  tz: string;
  step_seconds: number;
  server_time_ms: number;
};

/**
 * `GET /me/code` — no secret. `generation` moving is the phone's cue to re-enrol; the server
 * time is how it measures its own clock. Everything but those two is read as optional.
 */
export type MemberCodeStatus = {
  v?: number;
  ref?: string;
  generation: number;
  tz?: string;
  server_time_ms: number;
};

export type AdminCourt = {
  id: string;
  court_number: number;
  name: string;
  court_type: string;
  is_active: boolean;
};
export type MyProfile = {
  user_id: string;
  email: string;
  is_admin: boolean;
  tenant_slug: string;
  full_name: string | null;
  membership_number: string | null;
  photo_url: string | null;
  status: string | null;
  must_change_password?: boolean;
  /** D2: the member's active groups. Absent from an API that predates it. */
  groups?: MemberRowGroup[];
  /**
   * P13 §3.8 — the discount the member's groups give on CLUB packages, in basis points: the
   * lowest set among their active groups. Null when no group sets one.
   */
  package_discount_bps?: number | null;
  /** D2: whether their groups give them the peak window at any time. */
  peak_priority?: boolean;
  /** D11 §3a — credits held for partners, and until when (null when nothing is held). */
  held_minutes?: number;
  held_until?: string | null;
  /** P11 — credits owed back to partners, paid from the next credit in. Absent before P11. */
  owed_back_minutes?: number;
  /**
   * The club's IANA zone. Read at every app start, so `lib/clubZone` learns the club's day from
   * boot and no screen — least of all one opened cold from a mail on a phone in another zone —
   * writes a court time in the phone's. Absent from an API that predates it.
   */
  timezone?: string;
  /**
   * The symbol this club's REAL MONEY figures wear — `R`, `R$`, `CHF`.
   *
   * <p>
   * A tenant setting, riding on the payload that already reaches every signed-in screen
   * rather than on a second request for one string. <b>Optional, and its absence is the
   * commonest case</b>: an API that predates the key sends nothing, and
   * <code>readCurrencySymbol</code> answers the default.
   * </p>
   *
   * <p>
   * <b>It is not the credit unit.</b> A member pays R100 and receives
   * <code>credits_per_zar_regular</code> × 100 credits, which ships at 1.6 — so a credit
   * figure wearing this symbol overstates what they have by 60%. See `lib/currency.ts`.
   * </p>
   */
  currency_symbol?: string;

  // The admin notifier's six (R23), snake_case both ways — the API binds no other spelling. The
  // Settings page sends them from its own registry (`draft.wireBody`); bounds live there.
  /** 1–168, default 24. */
  application_reminder_hours?: number;
  /** 2–100, default 5. */
  fault_spike_count?: number;
  /** 5–240, default 15. */
  fault_spike_minutes?: number;
  /** 7–730, default 90. */
  admin_notification_retention_days?: number;
  /** 5–1440, default 30. Top-up failures of one reason inside this window are one email. */
  topup_failure_cooldown_minutes?: number;
  /** 1–240, default 15. One admin overdrawing one member inside this window is one email. */
  overdraft_cooldown_minutes?: number;

  // P12 — play (play.md §6.4), snake_case both ways. Bounds live in `settingsSchema.ts`.
  /** 12–168, default 48. */
  result_autoconfirm_hours?: number;
  /** 1–30, default 7. */
  result_record_days?: number;
  /** 2–12, default 4. */
  streak_rest_every_weeks?: number;
  /** 0–4, default 2. */
  streak_rest_cap?: number;
  /** 0–26, default 8. */
  streak_pause_weeks_per_year?: number;
  /** 0–720, default 420 (07:00). */
  play_early_bird_before_minute?: number;
  /** 720–1439, default 1260 (21:00). */
  play_night_owl_from_minute?: number;
};

/** A group as a member row names it (D2) — the same shape `adminApi.MemberGroupChip` types. */
export type MemberRowGroup = {
  id: string;
  name: string;
  system_key?: string | null;
  /** P13 §3.8 — this group's say on club-package prices, 0–10 000 bps; null = no say. */
  package_discount_bps?: number | null;
  peak_priority?: boolean | null;
};

export type AdminMember = {
  membership_id: string; user_id: string; email: string;
  full_name: string; membership_number: string; photo_url: string | null;
  status: string; created_at: string; rejection_reason: string | null;
  /** D2: the member's ACTIVE groups, in the club's order. Absent from an API that predates it. */
  groups?: MemberRowGroup[];
  /**
   * Whether the applicant ever clicked the link in their verification email. An
   * unverified member cannot sign in with a password no matter what their status says,
   * so the console has to show it — otherwise "the app won't let me in" from an
   * approved, active member has no answer on this screen.
   */
  email_verified?: boolean;
  balance_minutes: number;
};

// Phase 8 — per-member spend drill-down (blueprint C.3).
export type MemberSpendMonth = {
  month: string;
  top_ups_minutes: number;   // credits added to the wallet
  top_ups_zar: number;       // actual rand paid, for reconciliation
  spent_minutes: number;
  refunds_minutes: number;
  penalties_minutes: number;
  adjustments_minutes: number;
  net_minutes: number;
  movement_count: number;
};
export type MemberSpendReport = {
  from: string; to: string;
  member: {
    membership_id: string; user_id: string; full_name: string; membership_number: string;
    groups?: MemberRowGroup[];
  };
  totals: { top_ups_minutes: number; top_ups_zar: number; spent_minutes: number; refunds_minutes: number; penalties_minutes: number; net_minutes: number; movement_count: number };
  monthly: MemberSpendMonth[];
};

export type WebhookEndpointDto = {
  id: string;
  owner_kind: "Tenant" | "User";
  url_template: string;
  event_filter: string;
  enabled: boolean;
  description: string | null;
  failure_count: number;
  last_success_at: string | null;
  last_failure_at: string | null;
  secret: string | null; // only present on create
};

/**
 * A webhook delivery attempt, snake_case like every other admin projection.
 *
 * This type used to be PascalCase, matching nothing the API has ever sent. The endpoint
 * projected with C# shorthand members, which take the serializer's camelCase policy, so
 * the wire carried `createdAt`/`latencyMs` while this read `CreatedAt`/`LatencyMs` — every
 * field was `undefined`, every row rendered "Invalid Date" and "undefinedms", and the row
 * key was `undefined` for all of them. Both ends now agree on snake_case.
 */
export type WebhookDeliveryDto = {
  id: string;
  event_type: string;
  url: string;
  response_status: number | null;
  latency_ms: number;
  attempt: number;
  final_state: "pending" | "delivered" | "failed" | "abandoned";
  created_at: string;
  response_body_excerpt: string | null;
};

export type BiometricTemplateRow = {
  template_id: string;
  finger_label: string | null;
  created_at: string;
};
export type BiometricEnrollmentRow = {
  user_id: string;
  full_name: string;
  email: string;
  photo_url: string | null;
  membership_number: string;
  templates: BiometricTemplateRow[];
};

export type WebAuthnCredentialRow = {
  id: string;
  label: string;
  transports: string | null;
  created_at: string;
  last_used_at: string | null;
};

// ---------------------------------------------------------------------------------------
// P13 — minutes and packages (docs/specs/minutes-and-packages.md §3.4). The member buys a
// PACKAGE of whole minutes for rand; the old amount-and-rate top-up is gone.
// ---------------------------------------------------------------------------------------

/** A group as the shelf names it. */
export type ShelfGroup = { id: string; name: string };

/**
 * One package on a member's shelf (contract §3.4, §4.2). `price_zar` is what this member pays
 * (after their group discount on a club package); `saving_*` is against the shelf's smallest
 * package (§4.3) and null unless there is a real saving.
 */
export type ShelfPackage = {
  id: string;
  name: string;
  /** Whole minutes; a discount never changes them. */
  minutes: number;
  list_price_zar: number;
  /** 0 on a group package and when no discount applies. */
  discount_bps: number;
  price_zar: number;
  saving_zar: number | null;
  saving_pct: number | null;
  source: "club" | "group";
  /** Set on a `source: "group"` package only. */
  group: ShelfGroup | null;
};

/** One of the member's own checkouts still open at PayFast (§3.4, §3.6). */
export type OpenCheckout = {
  id: string;
  package_name: string;
  minutes: number;
  amount_zar: number;
  created_at: string;
  /** `created_at` + 60 min; replaces the old `counts_until`. */
  expires_at: string;
};

/** `GET /api/v1/minutes/packages` — the member's shelf. */
export type MinutesShelf = {
  /** Null when none of the member's active groups sets a discount. Applies to club packages only. */
  discount: { bps: number; group: ShelfGroup } | null;
  packages: ShelfPackage[];
  open_checkouts: OpenCheckout[];
};

/** `GET /api/v1/admin/minutes/{userId}/packages` — the shelf as that member sees it, without checkouts. */
export type MemberShelf = Omit<MinutesShelf, "open_checkouts">;

/**
 * `POST /api/v1/minutes/purchase` 200. `form_fields` IS the payment: the browser POSTs this
 * signed form to `redirect_url` (PayFast has no server-side checkout registration).
 */
export type PurchaseStart = {
  purchase_id: string;
  checkout_id: string;
  redirect_url: string;
  form_fields: PayFastFormField[];
  package: { id: string; name: string; minutes: number };
  /** The locked price — what PayFast is asked for. */
  amount_zar: number;
  /**
   * The demo club: no PayFast — the purchase is ALREADY completed and the minutes are on the
   * ledger. `redirect_url` is then a relative app path (`/wallet/buy/<id>`) and `form_fields` empty.
   */
  simulated?: boolean;
};

/** `GET /api/v1/minutes/purchase/{id}` and its cancel return (§3.4). */
export type PurchaseStatus = {
  id: string;
  status: "Pending" | "Completed" | "Failed" | "Cancelled";
  package_id: string;
  package_name: string;
  minutes: number;
  list_price_zar: number;
  discount_bps: number;
  amount_zar: number;
  /** A stable snake_case code (`cancelled_at_return`, `expired`, …), never an internal string. */
  failure_code: string | null;
  created_at: string;
  expires_at: string;
};

/**
 * One court's row in the utilisation report.
 *
 * `kept_minutes` is what the club KEPT, summed off the ledger rows naming each booking
 * — the settlement model's `Owed`. It used to be the price quoted at booking, so a
 * no-showed 50-credit court counted as 50 of revenue when the club's take was the 15
 * penalty. `sold_minutes` keeps the old figure under a name that says what it is.
 *
 * `booked_minutes` exists because `slices` mixes units: a 60-minute walk-up is one slice,
 * the same as a 15-minute booking.
 */
export type UtilisationRow = {
  court_id: string; court_number: number; court_name: string;
  slices: number;
  booked_minutes: number;
  bookings: number;
  kept_minutes: number;
  /** Σ `AmountChargedMinutes` — what was sold, before refunds (contract §3.15). */
  sold_minutes: number;
};

/** One form field of the signed PayFast checkout, in the order the signature covers. */
export type PayFastFormField = { name: string; value: string };

/**
 * A member's own period summary.
 *
 * Every bucket a movement can land in, because the page has to reconcile: it reported
 * top-ups, spend, refunds and a penalty COUNT and nothing else, so a member with 2,500
 * credits of admin adjustments read "0 in, 950 out, 100 back" beside a header saying
 * 1,635 and no way to see where the gap came from. `net_movement_minutes` is the sum,
 * and over a range covering the whole ledger it is the balance.
 */
export type WalletReport = {
  from: string; to: string;
  top_ups_minutes: number;
  /** R11 J11-4 — the part of top_ups_minutes given at no charge (desk give, R 0.00). Absent from an older API. */
  given_minutes?: number;
  spent_minutes: number;
  refunds_minutes: number;
  /** The penalty TOTAL `reporting.md` asks for, beside the count that was already here. */
  penalties_minutes: number;
  adjustments_minutes: number;
  reversals_minutes: number;
  /** D11 — shares paid to (−) or received from (+) other players. Absent before P11. */
  share_transfers_minutes?: number;
  /** D11 — what court time cost once the players settled up: spend − refunds + penalties − shares. */
  net_court_spend_minutes?: number;
  net_movement_minutes: number;
  penalty_count: number;
  /** Attendance — `CheckedInAt`, the source of truth the settlement model hangs off. */
  attended_bookings: number;
  minutes_on_court: number;
  count: number;
};
/**
 * One club day on the admin report.
 *
 * `reversals_minutes` and `net_movement_minutes` are here because the row has to add up.
 * `PaymentReversal` was in no bucket at all, under a card claiming the buckets were "every
 * ledger movement in the club summed", so a clawed-back payment moved balances while being
 * invisible on the club's own report. `net_movement_minutes` is the day summed WITHOUT
 * looking at the type — the same arithmetic the member's own `net_movement_minutes` uses —
 * so the club screen and the member screen cannot mean different things by "net", and a
 * ledger type nobody bucketed still reaches the total.
 */
export type DailyAdminPoint = { date: string; top_ups_minutes: number; booking_charges_minutes: number; refunds_minutes: number; penalties_minutes: number; adjustments_minutes: number; reversals_minutes: number; share_transfers_minutes?: number; net_movement_minutes: number; bookings: number; no_shows: number;
  /** R14 J14-2 — the part of top_ups_minutes the club GAVE (desk package_free or a R0.00 sale); a subset. Absent from an older API. */
  given_minutes?: number;
};
export type DailyMePoint = {
  date: string; top_ups_minutes: number; given_minutes?: number; spent_minutes: number; refunds_minutes: number; bookings: number; attended: number;
  minutes_on_court: number; balance_minutes: number;
  /** R7 J7-2 — the rest of a day's movement, so its buckets add up to `net_movement_minutes`. */
  penalties_minutes?: number; adjustments_minutes?: number; reversals_minutes?: number;
  share_transfers_minutes?: number; net_movement_minutes?: number;
};
/**
 * Club revenue over a window, in BOTH units, because they are not interchangeable.
 *
 * The `_zar` fields are what members actually paid, from `LedgerEntry.ZarPaid`. The
 * `_credits` fields are what those payments became at each member's class rate. The API
 * used to send credits under the `_zar` names and this page printed them with a rand sign,
 * so R1000 of income was reported as R1600 (Regular) or R2400 (League).
 */
export type RevenueReport = {
  from: string;
  to: string;
  gross_topups_zar: number;
  reversals_zar: number;
  net_zar: number;
  gross_topups_minutes: number;
  reversals_minutes: number;
  net_minutes: number;
  /** P13 §3.15 — `net_zar ÷ net_minutes`, rounded down to 4 dp; null when `net_minutes ≤ 0`. */
  zar_per_minute_sold?: number | null;
  /** R13 J13-2 — minutes the desk gave in free packages (R0): not in the sold figures. Absent on an older server. */
  given_minutes?: number;
};

// --- doors: member ---------------------------------------------------------------
//
// ONE endpoint for the member's whole door picture, and one for their own history.
// Wave-1 wire shapes, verbatim. The reason a single response carries both the standing
// facts and the last decision is honesty rather than economy: a stale standing line
// rendered beside a fresh refusal is a screen arguing with itself — "your court at 19:00
// opens the door from 18:30" above "the door turned you away: no booking" — and with two
// requests that state is reachable on every partial failure. One response, one instant,
// one truth.

/** Which rule this club's doors apply. Fails closed on the API side; the page never guesses. */
export type MemberDoorPolicy = "active_member" | "booking_window";

/**
 * What the club has this member's membership as.
 *
 * <p>
 * Three values, not the five the admin console knows. Suspended, pending and rejected are
 * one state from where the member is standing — the club has to change it and there is
 * nothing to do on the phone — and collapsing them here is what keeps the page from
 * naming a status the response cannot distinguish.
 * </p>
 */
export type MemberDoorMembership = "active" | "not_active" | "none";

/**
 * The club's own recorded status, at the resolution `membership` collapses away.
 *
 * <p>
 * `MembershipStatus`'s own members, lowercased, plus `none` for a user with no membership
 * row at all. The two fields are the SAME fact at two resolutions and both are wanted:
 * `membership` is the three-valued answer to "may this person open a door", and this is
 * what lets the page say WHICH not-active it is — "your application has not been approved
 * yet" and "your membership is suspended" are two different things to do next.
 * </p>
 *
 * <p>
 * Typed as a plain string for the reason {@link MemberDoorDecision.reason} is: the API's
 * own comment foresees a `lapsed` member arriving with the deferred grace-days work, and a
 * value this build has not heard of must reach a sentence rather than a blank. The closed
 * set this build knows is {@link MEMBER_DOOR_MEMBERSHIP_DETAILS}.
 * </p>
 */
export type MemberDoorMembershipDetail = string;

/**
 * The booking that bounds a door window, when there is one. UTC instants.
 *
 * <p>
 * Both edges of the window are non-null: `MeDoorEndpoints.NextBookingAsync` computes them
 * from `BookingCodeWindow` on every booking it returns, so a booking with no window on it
 * is a state the endpoint cannot produce. They were optional here while this page was
 * written against a stub that could.
 * </p>
 */
export type MemberDoorBooking = {
  starts_at: string;
  /** The slot's own end — the club's grace window is NOT on it. See `door_closes_at`. */
  ends_at: string;
  /** Which court, or null for a booking whose court has since been removed. */
  court_number: number | null;
  /** When this booking starts opening a door: `starts_at − H`, the horizon the DOOR applies. */
  door_opens_at: string;
  /** When it stops: the code's own expiry — the booking's end plus the club's grace window. */
  door_closes_at: string;
};

/** Who to call or write to when a door will not open. Either half may be unset at a club. */
export type MemberDoorContact = { phone: string | null; email: string | null };

/**
 * This member's own newest door decision, within the server's 120-second fetch window.
 *
 * <p>
 * `reason` is a string rather than a union for the reason `DeviceActivityEntry.reason`
 * is: a token this build has not heard of must reach a sentence, not a crash. The closed
 * set and its fallback live in `lib/memberDoorCopy.ts`.
 * </p>
 *
 * <p>
 * `door_name` is the club's `gate_key`, or null for a door nobody has named yet. Never a
 * device id, never a MAC, never a fingerprint, never a token.
 * </p>
 */
export type MemberDoorDecision = {
  /** The SCAN's own time, never the upload's. UTC. */
  at: string;
  /**
   * When the door's account of this scan reached the club. UTC, and null unless the door
   * decided it OFFLINE.
   *
   * <p>
   * The two instants are the same event seen from two places, and a member standing at a
   * door has a use for the gap: it is why the club's own screens showed nothing while they
   * were being let in. A null here is not "delivered instantly" — it is a row there was
   * never a delay to state, because the door asked the club at the time. Rendering a
   * delivery time for one would be inventing a journey the row never made.
   * </p>
   */
  delivered_at: string | null;
  /**
   * The club's own name for the door, resolved when the row is READ rather than taken
   * from what the board wrote at the time.
   *
   * <p>
   * <b>WIRE-R2 §4 reverses the wave-1 order, and A12 is why.</b> It was `gate_key` first, so
   * a member's own history showed the raw key `front-door` for the door an admin sees as
   * "Front door" — two names for one door, and the member got the one nobody says out loud.
   * The rule is now: the board's display Name, unless that name is the auto-registration
   * placeholder ("Door gate"), which is not a name anybody chose; else the `gate_key`; else
   * null. A board since deleted keeps whatever the row stored at write time.
   * </p>
   *
   * <p>
   * Null genuinely means unknown, and `UNNAMED_DOOR` is what a member reads for it. Never a
   * device id, never a MAC, never a fingerprint, never a token.
   * </p>
   */
  door_name: string | null;
  released: boolean;
  /**
   * Null for a row that recorded no reason this reader can find.
   *
   * <p>
   * `DoorActivityView.Details` swallows a `JsonException` and answers null, and `Reason`
   * then has neither a `reason` nor an `outcome` to read — so a refusal whose details were
   * written malformed reaches the page with nothing on it. The row is still the evidence;
   * refusing to show it because one field will not parse is the wrong way round.
   * </p>
   */
  reason: string | null;
  /** The board decided this from the list it had already downloaded, having lost the club's network. */
  offline: boolean;
  /**
   * For a `too_early` refusal: when the door WOULD open for the booking behind it.
   *
   * <p>
   * Server-computed through `BookingCodeWindow.DoorHorizonMinutes` and not derivable here:
   * the horizon is `max(gate_early_entry, min(roster + cue, 240))` under one policy and
   * `gate_early_entry` under the other, and none of those three settings is on a member's
   * API surface. Null on every other reason, and null when the booking behind the refusal
   * has since gone.
   * </p>
   */
  opens_at: string | null;
  /**
   * The instant on this row cannot be trusted to the minute. WIRE-R3 §2, R3-17.
   *
   * <p>
   * True when the server clamped the board's own clock, or when `delivered_at` is earlier
   * than `at` — which is impossible and means the door's clock was out. A board has no RTC
   * and takes its time from the club, so a board that has been cut off since boot is
   * guessing; the row is still evidence and is still shown, but no screen may print it as
   * though it were to the minute.
   * </p>
   *
   * <p>
   * Optional because the field is newer than the surfaces that read it, and absent is
   * "nothing said". The page derives the impossible-order half for itself either way — see
   * `timeIsUncertain` in `lib/memberDoorCopy.ts` — so a row that predates the flag still
   * cannot print an order that never happened.
   * </p>
   */
  time_uncertain?: boolean;
};

/**
 * How much of this club's door estate is shut right now. WIRE-R2 §4.
 *
 * <p>
 * <b>Why a third value rather than a boolean.</b> A club with two doors and one of them shut
 * is neither "the doors work" nor "the doors are shut", and the page owes a member standing
 * outside the sentence that is true of the building they are at. Collapsing it either way is
 * how "a live code of yours opens the club door" came to be shown at a club whose only usable
 * door was shut.
 * </p>
 */
export type MemberDoorsShut = "none" | "some" | "all";

/**
 * The same fact as {@link MemberDoorsShut}, plus the answer this page kept getting wrong.
 *
 * <p>
 * <b>R3-4.</b> `doors_shut` is optional on the wire in practice — an API that predates
 * WIRE-R2 §4 sends none, and a partial response can drop it — and every sentence built from
 * it read an absent field as "some of this club's doors are shut". A member at a club that
 * had shut nothing was told, in the present tense, that the club had shut doors; the same
 * response then promised that their code opens one. Unknown is not shut, and it is not
 * "none" either: it is a fourth state in which the page says nothing about shut doors and
 * promises nothing about an open one.
 * </p>
 */
export type MemberDoorsShutKnowledge = MemberDoorsShut | "unknown";

export type MemberDoor = {
  /**
   * Does this club have door scanners AT ALL — any gate row, enabled or not. WIRE-R2 §4.
   *
   * <p>
   * <b>This reverses what the field meant in wave 1</b>, where it was "at least one ENABLED
   * gate". Under that reading a club that had shut every door went silent about doors on the
   * one evening a member most needed to be told something: the history section vanished, the
   * standing line disappeared, and `/my-code` reverted to court-only copy in front of somebody
   * standing at a locked door. Whether a door is shut is {@link MemberDoor.doors_shut}'s
   * answer, and it is a different question from whether the club owns one.
   * </p>
   *
   * <p>
   * False, or absent on an older API, still means the page says NOTHING about doors.
   * </p>
   */
  doors: boolean;
  /**
   * None, some or all of the club's doors are shut. See {@link MemberDoorsShut}.
   *
   * <p>
   * <b>Optional, and R3-4 is why it is typed that way.</b> It is required of the current
   * API, but a response that predates WIRE-R2 §4 — or one a gateway truncated — arrives
   * without it, and the page that read `undefined` as "some" told every member at the club
   * that doors were shut. Typing it optional is what forces every reader through
   * {@link MemberDoorsShutKnowledge}'s fourth state instead of through a `??` default that
   * picks one of the three answers on the member's behalf.
   * </p>
   */
  doors_shut?: MemberDoorsShut;
  /**
   * The club's own names for the doors it has shut. WIRE-R3 §5. May be empty.
   *
   * <p>
   * `doors_shut` says how much of the estate is shut; this says which. A member told "some
   * of its doors" cannot tell which door they are walking up to, and the club knows the
   * answer. Empty — or absent, on an API that predates the field — means the page says what
   * it knows without naming anything, which is the sentence it had before.
   * </p>
   */
  doors_shut_names?: string[];
  /**
   * The club's own IANA zone, so every clock face on this surface is the club's day.
   *
   * <p>
   * O1: the member surfaces formatted their times in the VIEWER's zone and the admin ones in
   * the club's, so a member abroad and the admin reading the same scan in the club's log saw
   * two different times for one event. One formatter, `lib/clubClock`, and this is what it is
   * given.
   * </p>
   */
  timezone: string;
  policy: MemberDoorPolicy;
  membership: MemberDoorMembership;
  /** The same fact as `membership`, at the resolution that says which not-active it is. */
  membership_detail: MemberDoorMembershipDetail;
  /**
   * §5's carve-out: a club admin passes the BOOKING check under `booking_window`.
   *
   * <p>
   * `GateAccess` grants it on `User.IsAdmin` alone, and it is the booking check only — an
   * admin is held to the membership check like everybody, which is the order the standing
   * line has to state it in.
   * </p>
   */
  is_club_admin: boolean;
  /**
   * The member's next upcoming live booking, with NO horizon limit. WIRE-R2 §4.
   *
   * <p>
   * It used to be bounded by the same horizon the door applies, so a member with a court
   * tomorrow was sent a null and told, correctly but uselessly, that nothing of theirs was
   * booked soon enough for a door — with no way to find out when the door WOULD open for the
   * booking they had. A booking days away is still the answer to "when does this let me in",
   * and the page already knows how to name a window it cannot use yet.
   * </p>
   */
  next_booking: MemberDoorBooking | null;
  /**
   * `gate_early_entry_minutes`, clamped server-side to 0..240 — and NULL unless the policy is
   * `booking_window`. WIRE-R2 §4.
   *
   * <p>
   * <b>E-H3: under `active_member` the number is real and means nothing here.</b> A booking
   * code's door window under that policy is `StartsAt −` the roster horizon, not early entry,
   * so a page that printed the early-entry minutes beside an 08:05 derived from something else
   * was offering a member an explanation that does not add up. Null is the honest shape: there
   * is no early-entry window in force, so there is no number to print.
   * </p>
   *
   * <p>
   * Zero, under `booking_window`, is a real setting rather than an absent one, and the sentence
   * that names a window still has to have a wordless arm for it.
   * </p>
   */
  early_entry_minutes: number | null;
  /** How many bookings a cut-off door's cached list holds. The firmware and the API share it. */
  roster_max_entries: number;
  contact: MemberDoorContact;
  /** `door_log_retention_days`, so a page stating the number states the club's own. */
  door_log_retention_days: number;
  last_decision: MemberDoorDecision | null;
};

/** One row of the member's own door history. `offline` — the door decided from its own list. */
export type MemberDoorHistoryRow = {
  /** The SCAN's own instant. See {@link MemberDoorDecision.at}. */
  at: string;
  /**
   * When the club heard. Null unless the door decided this one on its own.
   *
   * <p>
   * <b>The list is ordered and paged on THIS axis, not on `at`.</b> A door that was cut
   * off for an hour delivers an hour of scans at once, so an offline row's `at` can be
   * older than the rows around it — which reads as a record in the wrong order unless the
   * page says why. `historyLine` and `HISTORY_DELIVERY_ORDER` are where it says so.
   * </p>
   */
  delivered_at: string | null;
  door_name: string | null;
  released: boolean;
  /** Null for the same malformed-details row {@link MemberDoorDecision.reason} describes. */
  reason: string | null;
  offline: boolean;
  /** The row's time was clamped, or its delivery predates it. See {@link MemberDoorDecision.time_uncertain}. */
  time_uncertain?: boolean;
};

export type MemberDoorHistory = {
  items: MemberDoorHistoryRow[];
  next_cursor: string | null;
  /** How long the club keeps these, so the page states a number it was given. */
  retention_days: number;
  /** The club's own zone. WIRE-R2 §4 — every clock face in this list is the club's day. */
  timezone: string;
};

// --- end doors: member -----------------------------------------------------------

export async function uploadPhoto(file: File): Promise<{ url: string }> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetchWithTimeout("/api/v1/uploads/photo", { method: "POST", body: fd }, UPLOAD_TIMEOUT_MS);
  if (!res.ok) throw await failureFrom(res);
  return res.json();
}

export const endpoints = {
  whoami: () => api.get<WhoAmI>("/api/v1/whoami"),
  /**
   * Ends the session on the server as well as in this browser.
   *
   * <p>
   * Deleting the stored token is not a sign-out — a JWT is a bearer credential and keeps
   * working wherever else it reached until it expires. This is what makes the credential stop.
   * </p>
   */
  logout: () => api.post<void>("/api/v1/auth/logout"),
  /**
   * A one-minute, stream-only credential for the wallet SSE connection.
   *
   * <p>
   * `EventSource` cannot send an Authorization header, so something has to travel in the URL,
   * where every proxy logs it. The full access token used to; this is the thing that is worth
   * nothing to whoever reads that log ten minutes later.
   * </p>
   */
  walletStreamTicket: () => api.post<{ ticket: string; expires_in_seconds: number }>("/api/v1/wallet/stream-ticket"),
  register: (req: { email: string; password: string; fullName: string; membershipNumber: string; photoUrl?: string }) =>
    api.post<{ user_id: string; status: string }>("/api/v1/auth/register", {
      email: req.email,
      password: req.password,
      fullName: req.fullName,
      membershipNumber: req.membershipNumber,
      photoUrl: req.photoUrl ?? null,
    }),
  verifyEmail: (token: string) => api.post<{ verified: boolean }>(`/api/v1/auth/verify-email/${token}`),
  login: (email: string, password: string) => api.post<LoginResponse>("/api/v1/auth/login", { email, password }),
  refresh: () => api.post<LoginResponse>("/api/v1/auth/refresh"),
  devAdminLogin: () => api.post<LoginResponse>("/api/v1/auth/dev/admin-login"),

  // WebAuthn / passkeys
  webauthnLoginOptions: () => api.post<{ flowId: string; options: unknown }>("/api/v1/auth/webauthn/login/options", {}),
  webauthnLogin: (flowId: string, response: unknown) =>
    api.post<LoginResponse>("/api/v1/auth/webauthn/login", { flowId, response }),
  webauthnList: () => api.get<WebAuthnCredentialRow[]>("/api/v1/me/webauthn/credentials"),
  webauthnRegisterOptions: (label: string) =>
    api.post<{ flowId: string; options: unknown }>("/api/v1/me/webauthn/register/options", { label }),
  webauthnRegister: (flowId: string, response: unknown, transports: string[] | null) =>
    api.post<{ id: string; label: string }>("/api/v1/me/webauthn/register", { flowId, response, transports }),
  webauthnDelete: (id: string) => api.del<void>(`/api/v1/me/webauthn/credentials/${id}`),
  magicLink: (token: string) => api.post<LoginResponse>(`/api/v1/auth/magic-link/${token}`),
  forgotPassword: (email: string) => api.post<{ ok: boolean }>("/api/v1/auth/forgot-password", { email }),
  resetPassword: (token: string, newPassword: string) => api.post<{ reset: boolean }>("/api/v1/auth/reset-password", { token, newPassword }),
  /**
   * Re-sends the address-confirmation email. Answers 200 whatever the address is, so a caller
   * cannot use it to find out who is registered — which is also why the screen's confirmation
   * says "if that address is registered" rather than claiming a mail was sent.
   */
  resendVerification: (email: string) => api.post<{ ok: boolean }>("/api/v1/auth/resend-verification", { email }),
  /** The signed-in member replacing their own password — and, in doing so, retiring a temporary one. */
  changePassword: (currentPassword: string, newPassword: string) =>
    api.post<{ changed: boolean; access_token?: string }>("/api/v1/me/password", { currentPassword, newPassword }),
  /**
   * Sign out everywhere (member-code §10): every session the caller has ends — THIS ONE INCLUDED —
   * and their code rotates, so the token that sent this is dead once it answers. With
   * `revokePasskeys` their passkeys are deleted too; the server's default is to keep them.
   */
  revokeAllSessions: (revokePasskeys: boolean) =>
    api.post<{ signed_out: boolean; passkeys_revoked: boolean; passkeys_removed: number }>(
      "/api/v1/me/sessions/revoke-all", { revoke_passkeys: revokePasskeys }),

  /** The member's ledger page — joined to one already in flight when that is safe (`readWallet`). */
  wallet: (limit?: number, offset?: number) => readWallet(limit, offset),
  /** The same page with each share row's booking summarised (`share_bookings`) — the Wallet page's read. */
  walletWithShareBookings: (limit?: number, offset?: number) => readWallet(limit, offset, true),
  /**
   * `photos=url` (perf round, 2026-09-30): each face on the grid comes back as a public, immutable,
   * year-cached `/api/v1/photos/{userId}/{hash}` URL instead of the same base64 image repeated per
   * slot — 21 kB of a day became 3.7 kB gzipped, and a face is fetched once, not once per read.
   */
  schedule: (date: string) => api.get<ScheduleDay>(`/api/v1/schedule?date=${date}&photos=url`),
  book: (courtId: string, startsAt: string, sliceCount: number) =>
    api.post<{ booking_id: string; balance_after_minutes: number }>("/api/v1/bookings/", { courtId, startsAt, sliceCount }),
  cancelBooking: (bookingId: string) => api.post<{ refunded_minutes: number; penalty_minutes: number }>(`/api/v1/bookings/${bookingId}/cancel`),
  /** Read when the cancellation modal opens, never cached with the schedule — the answer moves with the clock and with a scan at the box. */
  cancellationQuote: (bookingId: string) => api.get<CancellationQuote>(`/api/v1/bookings/${bookingId}/cancellation-quote`),

  /**
   * Admin: book for a member — or, since R19, for themselves (`userId` = the admin). The payer
   * is charged; the admin is the actor on the audit row, and `balance_after_minutes` in the
   * answer is the PAYER's balance.
   *
   * `allowNegativeBalance` is god mode (R19): sent when {@link endpoints.adminBookingQuote} said
   * `overdraws`, after the sheet has shown the admin where it leaves the payer. Never the
   * refuse-then-retry 402 dance — the quote is asked first.
   */
  adminBook: (courtId: string, userId: string, startsAt: string, sliceCount: number, allowNegativeBalance = false) =>
    api.post<{ booking_id: string; balance_after_minutes: number }>(
      "/api/v1/admin/bookings/", { courtId, userId, startsAt, sliceCount, allowNegativeBalance }),
  /** Admin: cancel anyone's booking, optionally waiving the late-cancellation penalty. */
  /**
   * §7 / §8: the penalty is waiveable **with reason**, and the reason travels with the
   * waiver. It used to be a bare boolean on the wire, so a club auditing waived penalties
   * at month end had a tick and no way to tell a club decision from a quiet favour.
   */
  adminCancelBooking: (bookingId: string, waivePenalty: boolean, waiveReason = "") =>
    api.post<{ refunded_minutes: number; penalty_minutes: number }>(
      `/api/v1/admin/bookings/${bookingId}/cancel`, { waivePenalty, waiveReason }),
  /** Admin: hold a court for an event. Takes no money and refuses to sit over a paid booking. */
  adminBlock: (courtId: string, startsAt: string, sliceCount: number, label: string) =>
    api.post<{ booking_id: string }>("/api/v1/admin/blocks/", { courtId, startsAt, sliceCount, label }),
  // R5 A5-1: a lift needs a reason (400 reason_required without one); the query form, as `del` sends no body.
  adminUnblock: (blockId: string, reason?: string) =>
    api.del<void>(`/api/v1/admin/blocks/${blockId}` + (reason === undefined ? "" : "?reason=" + encodeURIComponent(reason))),

  /**
   * Items 5 + 13 — a list of checkboxes answered with a list of outcomes.
   *
   * <p>
   * <b>Both routes answer 200 with per-item results, never all-or-nothing</b> (D2 §5.1). Each
   * booking is its own money movement behind its own payer lock, a collision is normal traffic
   * rather than an error, and the honest answer to a list of ticks is a list of outcomes. A
   * partially-successful batch is a RESULT the admin has to read either way, so it is data and
   * not a status code — which is also why the console renders the returned list rather than a
   * spinner ending in a toast that cannot say "11 cancelled, 1 was already gone".
   * </p>
   *
   * <p>
   * <b>`idempotencyKey` is mandatory on both</b>, because the retry is the point: a bulk book
   * that halts on `insufficient_balance` is retried under the SAME key with the override, and
   * the items that landed answer `duplicate` rather than being booked twice.
   * </p>
   *
   * <p>
   * <b>Request bodies are camelCase</b>, per D2 §13's stated convention and every existing POST
   * in this client; responses are snake_case like every other response, and are read by the
   * booking sheets' flow modules (`components/bookings/bookFlow.ts`, `cancelFlow.ts`).
   * </p>
   */
  adminBulkCancel: (body: {
    idempotencyKey: string; reason: string; waivePenalty: boolean;
    items: { bookingId: string; waivePenalty?: boolean }[];
  }) => api.post<BulkCancelResponse>("/api/v1/admin/bookings/bulk-cancel", body),

  adminBulkBook: (body: {
    idempotencyKey: string;
    /** At least one of the two. Neither ⇒ the admin's own booking, on their own wallet. */
    onBehalf?: { userId?: string; guestName?: string };
    allowNegativeBalance: boolean;
    note?: string;
    items: { courtId: string; startsAt: string; sliceCount: number }[];
  }) => api.post<BulkBookResponse>("/api/v1/admin/bookings/bulk", body),

  /**
   * R19 — the consequence before the booking. `userId` omitted quotes the admin's own wallet.
   * A refusal the booking would meet is thrown as the same `ApiError` the POST would give.
   */
  adminBookingQuote: (q: { userId?: string; courtId: string; startsAt: string; slices: number }) =>
    api.get<AdminBookingQuote>(`/api/v1/admin/bookings/quote${qs({
      userId: q.userId, courtId: q.courtId, startsAt: q.startsAt, slices: q.slices,
    })}`),

  /** R19 — the batch quote. Per-item refusals are `bookable: false` + `reason`, never a failed call. */
  adminBulkBookingQuote: (body: { userId?: string; items: BulkBookItemBody[] }) =>
    api.post<AdminBulkQuote>("/api/v1/admin/bookings/bulk/quote", {
      user_id: body.userId,
      items: body.items.map((i) => ({ court_id: i.courtId, starts_at: i.startsAt, slices: i.sliceCount })),
    }),

  /**
   * D8 — a member books several slots at once under every member rule, never overdrawn. Mint a
   * new `idempotencyKey` per selection; reuse it ONLY to retry that selection, so items that
   * already landed replay instead of charging twice.
   */
  memberBulkBook: (body: { idempotencyKey: string; items: BulkBookItemBody[] }) =>
    api.post<MemberBulkBookResponse>("/api/v1/bookings/bulk", body),

  adminMembers: (status?: string) => api.get<AdminMember[]>(`/api/v1/admin/members/${status ? `?status=${status}` : ""}`),
  /**
   * The four member-lifecycle transitions all answer `member_notified`.
   *
   * The status change commits before the notification email is attempted, so the two can
   * genuinely differ — and they did so silently until an SMTP outage turned a committed
   * approval into an HTTP 500 and the console said "Approval failed." about a member who
   * was already Active. `member_notified: false` means the transition happened and nobody
   * was told; the console has to be able to say that rather than pick one of the two.
   */
  adminApprove: (memberId: string) => api.post<{ approved: boolean; member_notified: boolean }>(`/api/v1/admin/members/${memberId}/approve`),
  adminReject: (memberId: string, reason: string) => api.post<{ rejected: boolean; member_notified: boolean }>(`/api/v1/admin/members/${memberId}/reject`, { reason }),

  /**
   * Suspend / reactivate (spec §8) — the status a club reaches for when dues lapse.
   *
   * A suspension is not a rejection and not a deletion: the member's minutes and
   * their existing bookings are untouched, and reactivating restores access exactly as it
   * was. A reason is required because the member is emailed it.
   */
  adminSuspend: (memberId: string, reason: string) =>
    api.post<{ suspended: boolean; member_notified: boolean }>(`/api/v1/admin/members/${memberId}/suspend`, { reason }),
  adminReactivate: (memberId: string) =>
    api.post<{ reactivated: boolean; member_notified: boolean }>(`/api/v1/admin/members/${memberId}/reactivate`),

  adminResetMemberPassword: (memberId: string) =>
    api.post<{ temp_password: string; email_sent_to: string | null; member_notified: boolean; advice: string }>(`/api/v1/admin/members/${memberId}/reset-password`),
  // D2 deleted `POST /admin/members/{id}/class` with the member class. A member's groups — which
  // now carry the top-up rate and the peak say — are set with `adminEndpoints.memberGroupsSet`.

  // Phase 8 — per-member spend drill-down (blueprint C.3).
  adminMemberSpend: (memberId: string, from?: string, to?: string) =>
    api.get<MemberSpendReport>(`/api/v1/admin/members/${memberId}/spend${qs({ from, to })}`),

  // Phase 8.6 — PIN identification (self-service + admin reset).
  meSetPin: (pin: string) => api.post<{ pin_set: boolean }>("/api/v1/me/pin", { pin }),
  meClearPin: () => api.del<void>("/api/v1/me/pin"),
  adminSetMemberPin: (memberId: string, pin: string) =>
    api.post<{ pin_set: boolean }>(`/api/v1/admin/members/${memberId}/pin`, { pin }),
  courtPinMatch: (courtNumber: number, pin: string) =>
    api.post<{ matched: boolean; user_id: string | null }>(`/api/v1/court/${courtNumber}/pin/match`, { pin }),

  // D1 — the single rotating member code. See MemberCodeEnrolment.
  meCodeEnrol: () => api.post<MemberCodeEnrolment>("/api/v1/me/code/enrol"),
  meCodeStatus: () => api.get<MemberCodeStatus>("/api/v1/me/code"),
  courtQrMatch: (courtNumber: number, token: string) =>
    api.post<{ matched: boolean; user_id?: string; reason?: string }>(`/api/v1/court/${courtNumber}/qr/match`, { token }),

  // P13 — buying minutes (contract §3.4). Every one of these is the member's own.
  /** The member's shelf: their packages at their price, and their checkouts still open. */
  minutesPackages: () => api.get<MinutesShelf>("/api/v1/minutes/packages"),
  /**
   * Registers a purchase and returns the SIGNED FORM the browser must POST to PayFast.
   * `quotedPriceZar` is the shelf `price_zar` the member was shown; a different live price is
   * 409 `package_price_changed` (with the package as it is now), never a silent re-price.
   */
  minutesPurchase: (packageId: string, quotedPriceZar: number) =>
    api.post<PurchaseStart>("/api/v1/minutes/purchase", { packageId, quotedPriceZar }),
  minutesPurchaseStatus: (purchaseId: string) => api.get<PurchaseStatus>(`/api/v1/minutes/purchase/${purchaseId}`),
  /** The cancel return (M4-1 semantics kept): own row only, idempotent, never overwrites a completion. */
  minutesPurchaseCancel: (purchaseId: string) => api.post<PurchaseStatus>(`/api/v1/minutes/purchase/${purchaseId}/cancel`),

  // Webhooks (admin)
  adminWebhooksList: () => api.get<WebhookEndpointDto[]>("/api/v1/admin/webhooks/"),
  adminWebhooksCreate: (req: { urlTemplate: string; eventFilter?: string; description?: string }) =>
    api.post<WebhookEndpointDto>("/api/v1/admin/webhooks/", req),
  adminWebhooksDelete: (id: string) => api.del<void>(`/api/v1/admin/webhooks/${id}`),
  adminWebhookDeliveries: (id: string) => api.get<WebhookDeliveryDto[]>(`/api/v1/admin/webhooks/${id}/deliveries`),

  // Biometric (admin)
  adminBiometricEnroll: (userId: string, fingerLabel?: string) =>
    api.post<{ template_id: string }>("/api/v1/admin/biometric/enroll", { userId, fingerLabel: fingerLabel ?? null, consentReceiptHash: "v1" }),
  adminBiometricEnrollments: () =>
    api.get<BiometricEnrollmentRow[]>("/api/v1/admin/biometric/enrollments"),
  adminBiometricRemoveTemplate: (templateId: string) =>
    api.del<void>(`/api/v1/admin/biometric/templates/${templateId}`),
  courtBiometricMatch: (courtNumber: number) =>
    api.post<{ matched: boolean; user_id: string | null; confidence: number; latency_ms: number }>(`/api/v1/court/${courtNumber}/biometric/match`),

  // Reports
  reportWallet: (from?: string, to?: string) =>
    api.get<WalletReport>(`/api/v1/reports/me/wallet${qs({ from, to })}`),
  walletCsvUrl: (from?: string, to?: string) => `/api/v1/reports/me/wallet.csv${qs({ from, to })}`,
  /**
   * Fetches the wallet CSV **with the session's bearer token** and hands back a blob the
   * page can save.
   *
   * The control was a plain `<a href download>`, so the browser navigated to the endpoint
   * on its own with no Authorization header: the API could not even resolve a tenant and
   * answered `400 tenant_unresolved` as JSON. The download started and cancelled itself —
   * no file, no toast, no console error, the page identical before and after.
   */
  walletCsv: async (from?: string, to?: string): Promise<{ blob: Blob; filename: string }> => {
    const res = await fetchWithTimeout(endpoints.walletCsvUrl(from, to), {
      headers: { ...(tokenStore.get() ? { authorization: `Bearer ${tokenStore.get()}` } : {}) },
    });
    if (!res.ok) throw await failureFrom(res);
    const disposition = res.headers.get("content-disposition") ?? "";
    const match = /filename="?([^"]+)"?/.exec(disposition);
    return { blob: await res.blob(), filename: match?.[1] ?? "wallet.csv" };
  },
  reportRevenue: (from?: string, to?: string) =>
    api.get<RevenueReport>(`/api/v1/admin/reports/revenue${qs({ from, to })}`),
  reportUtilisation: (from?: string, to?: string) =>
    api.get<{ from: string; to: string; by_court: UtilisationRow[] }>(`/api/v1/admin/reports/utilisation${qs({ from, to })}`),
  reportNoShows: (from?: string, to?: string) =>
    api.get<{ from: string; to: string; total: number; no_show: number; no_show_pct: number }>(`/api/v1/admin/reports/no-shows${qs({ from, to })}`),
  reportDailyAdmin: (from?: string, to?: string) =>
    api.get<DailyAdminPoint[]>(`/api/v1/admin/reports/daily${qs({ from, to })}`),
  reportDailyMe: (from?: string, to?: string) =>
    api.get<DailyMePoint[]>(`/api/v1/reports/me/daily${qs({ from, to })}`),

  // Admin: tenant-wide config
  adminSettingsGet: () => api.get<AdminSettings>("/api/v1/admin/settings/"),
  /**
   * Saves settings.
   *
   * Everything past the eight booking fields is optional and OMITTED WHEN UNDEFINED,
   * because the API reads an absent key as "unchanged". That is what lets the booking
   * form, the economics form and the button-map editor be three screens without any
   * of them reverting the others' work on save.
   */
  adminSettingsSave: (req: AdminSettingsSave) => api.put<{ saved: true }>("/api/v1/admin/settings/", {
    sliceMinutes: req.slice_minutes,
    advanceBookingDays: req.advance_booking_days,
    dayStartMinute: req.day_start_minute,
    dayEndMinute: req.day_end_minute,
    penaltyPct: req.penalty_pct,
    graceWindowMinutes: req.grace_window_minutes,
    penaltyWindowMinutes: req.penalty_window_minutes,
    ...(req.timezone !== undefined ? { timezone: req.timezone } : {}),
    // Omitted-means-unchanged applies here too, and an EMPTY map is not the same as an
    // omitted one: it is how a club puts every weekday back on the flat default.
    ...(req.operating_hours !== undefined ? { operatingHours: req.operating_hours } : {}),
    ...(req.button_map !== undefined ? { buttonMap: req.button_map } : {}),
    ...(req.member_per_day_max_minutes !== undefined ? { memberPerDayMaxMinutes: req.member_per_day_max_minutes } : {}),
    ...(req.peak_hours !== undefined ? { peakHours: req.peak_hours } : {}),
    ...(req.peak_advance_hours_for_regular !== undefined ? { peakAdvanceHoursForRegular: req.peak_advance_hours_for_regular } : {}),
    ...(req.retention_years !== undefined ? { retentionYears: req.retention_years } : {}),
    ...(req.no_show_lookback_days !== undefined ? { noShowLookbackDays: req.no_show_lookback_days } : {}),
    ...(req.walk_up_max_minutes !== undefined ? { walkUpMaxMinutes: req.walk_up_max_minutes } : {}),
    ...(req.heartbeat_seconds !== undefined ? { heartbeatSeconds: req.heartbeat_seconds } : {}),
    ...(req.activation_forward_window_minutes !== undefined ? { activationForwardWindowMinutes: req.activation_forward_window_minutes } : {}),
    ...(req.activation_cue_window_minutes !== undefined ? { activationCueWindowMinutes: req.activation_cue_window_minutes } : {}),
    ...(req.qr_lifetime_seconds !== undefined ? { qrLifetimeSeconds: req.qr_lifetime_seconds } : {}),
    ...(req.roster_window_minutes !== undefined ? { rosterWindowMinutes: req.roster_window_minutes } : {}),
    // The API binds camelCase case-insensitively and accepts either spelling for this one;
    // camelCase is what every other number here sends, so it sends camelCase.
    ...(req.device_alert_cooldown_minutes !== undefined ? { deviceAlertCooldownMinutes: req.device_alert_cooldown_minutes } : {}),
    // The three door-gate numbers, on the same omitted-means-unchanged terms as the rest —
    // so the Devices page's button-map save cannot reset a club's door policy, and a club
    // with no gates never sends them at all.
    ...(req.gate_unlock_seconds !== undefined ? { gateUnlockSeconds: req.gate_unlock_seconds } : {}),
    ...(req.gate_access_policy !== undefined ? { gateAccessPolicy: req.gate_access_policy } : {}),
    ...(req.gate_early_entry_minutes !== undefined ? { gateEarlyEntryMinutes: req.gate_early_entry_minutes } : {}),
    // doors: admin — the five W1 door settings, on the same omitted-means-unchanged terms.
    // They are here rather than in a PUT of their own because this page has one Save button
    // and a second request would be a second audit row for one click. The API binds both
    // spellings; camelCase is what every other number on this call sends.
    ...(req.door_log_retention_days !== undefined ? { doorLogRetentionDays: req.door_log_retention_days } : {}),
    ...(req.door_refusal_spike_count !== undefined ? { doorRefusalSpikeCount: req.door_refusal_spike_count } : {}),
    ...(req.door_refusal_spike_minutes !== undefined ? { doorRefusalSpikeMinutes: req.door_refusal_spike_minutes } : {}),
    ...(req.club_contact_phone !== undefined ? { clubContactPhone: req.club_contact_phone } : {}),
    ...(req.club_contact_email !== undefined ? { clubContactEmail: req.club_contact_email } : {}),
    // eco — ruling 13's keys, on the same omitted-means-unchanged terms as everything above,
    // which is what lets one Save button carry them against an API that serves only some.
    // lcd_revert_seconds and the four monitoring keys below it that are spelled snake_case are
    // bound ONLY under that spelling (AdminConfigEndpoints' snake-only block): sent camelCase they
    // were a silent no-op answered `{"saved": true}`.
    ...(req.lcd_revert_seconds !== undefined ? { lcd_revert_seconds: req.lcd_revert_seconds } : {}),
    ...(req.rapid_scan_window_seconds !== undefined ? { rapidScanWindowSeconds: req.rapid_scan_window_seconds } : {}),
    ...(req.member_max_slots_per_day !== undefined ? { memberMaxSlotsPerDay: req.member_max_slots_per_day } : {}),
    ...(req.admin_bulk_max_items !== undefined ? { adminBulkMaxItems: req.admin_bulk_max_items } : {}),
    ...(req.schedule_materialisation_days !== undefined ? { scheduleMaterialisationDays: req.schedule_materialisation_days } : {}),
    ...(req.schedule_max_rows_per_change !== undefined ? { scheduleMaxRowsPerChange: req.schedule_max_rows_per_change } : {}),
    ...(req.device_error_retention_days !== undefined ? { device_error_retention_days: req.device_error_retention_days } : {}),
    ...(req.device_error_max_open_rows !== undefined ? { device_error_max_open_rows: req.device_error_max_open_rows } : {}),
    ...(req.sse_keepalive_seconds !== undefined ? { sseKeepaliveSeconds: req.sse_keepalive_seconds } : {}),
    ...(req.realtime_fallback_after_failures !== undefined ? { realtimeFallbackAfterFailures: req.realtime_fallback_after_failures } : {}),
    ...(req.realtime_poll_seconds_control_board !== undefined ? { realtime_poll_seconds_control_board: req.realtime_poll_seconds_control_board } : {}),
    ...(req.control_board_resync_seconds !== undefined ? { control_board_resync_seconds: req.control_board_resync_seconds } : {}),
    // The club's money symbol, on the same omitted-means-unchanged terms. Sent RAW, not
    // sanitised: the page refuses to save an unacceptable one, and quietly turning a typo
    // into an R here would be the client deciding a money question on the admin's behalf.
    ...(req.currency_symbol !== undefined ? { currencySymbol: req.currency_symbol } : {}),
    ...(req.member_trace_enabled !== undefined ? { memberTraceEnabled: req.member_trace_enabled } : {}),
  }),

  // Admin: devices.
  //
  // `court_numbers` is snake_case on every request that carries it, because the API pins
  // that one property name (the rest bind from camelCase case-insensitively). It is a
  // list in relay order: [court on A, on B, …].
  //
  // Discovery, claim, manual registration, key rotation and revocation are gone: boxes
  // authenticate with the tenant's one static API key and register themselves on their
  // first heartbeat. What is left is the list, the edit and the delete.
  adminDevicesList: () => api.get<AdminDevice[]>("/api/v1/admin/devices/"),
  /**
   * `button_map` is this box's override and the API binds it three-valued
   * (`UpdateDeviceRequest` takes it as a bare JsonElement, pinned snake_case like
   * `court_numbers`): a list sets one, `null` goes back to the club's map, and an ABSENT
   * key leaves it alone. The spread below keeps that contract — a caller that does not
   * mention `button_map` sends no such key, and JSON.stringify drops an `undefined` one.
   *
   * `gate_key` is a GATE row's only editable configuration and binds TWO ways, not three —
   * which is the difference from `button_map` directly above, and the one this comment used
   * to get wrong. `DeviceRegistryService.UpdateAsync` applies it only
   * `if (cmd.GateKey is not null)`, and then `Length == 0` is what stores a null. So a
   * non-empty string names the door (trimmed, at most 64 characters), `""` CLEARS the name,
   * and `null` or an absent key leave it alone — `null` is not a clear, it is an absence.
   * The type says so: there is no way to spell a clear as null, because for two rounds the
   * page did exactly that and cleared nothing while reporting success.
   *
   * It is refused on a court box (`gate_key_not_a_gate`), exactly as `court_numbers` and
   * `button_map` are refused on a gate (`court_fields_on_a_gate`), and refused over 64
   * characters (`gate_key_too_long`). `kind` is on neither this request nor the API's, by
   * design.
   */
  adminDeviceUpdate: (
    id: string,
    req: { name?: string; enabled?: boolean; court_numbers?: number[]; button_map?: string[] | null; gate_key?: string },
  ) => api.patch<AdminDevice>(`/api/v1/admin/devices/${id}`, { ...req }),
  /**
   * Forgets a box. It is not a revocation and does not lock anything out: the box still
   * holds the club's API key, so it registers itself again on its next heartbeat — as a
   * fresh, auto-registered row with default courts. Deleting is for a box that is
   * genuinely gone, or for starting its configuration over.
   */
  adminDeviceDelete: (id: string) => api.del<{ deleted: true }>(`/api/v1/admin/devices/${id}`),

  /**
   * One board's own trail, newest first (B5).
   *
   * <p>
   * The door's audit rows existed from the day the gate shipped and nothing read them, so
   * "why was I turned away at the front door" had a database query as its only answer. The
   * endpoint is tenant-scoped and serves both kinds of board; it never returns raw
   * `DetailsJson` and never returns a token.
   * </p>
   *
   * <p>
   * `limit` defaults to 50 here as well as on the API. Sending it explicitly rather than
   * relying on the server's default keeps the page's promise ("the last 50") true of the
   * request it actually made, rather than of whatever a future default becomes.
   * </p>
   */
  adminDeviceActivity: (id: string, limit = DEVICE_ACTIVITY_LIMIT) =>
    api.get<DeviceActivityPage>(`/api/v1/admin/devices/${id}/activity${qs({ limit })}`),

  // Admin: the club's one device API key.
  adminDeviceApiKey: () => api.get<DeviceApiKey>("/api/v1/admin/devices/api-key"),
  /** The old key stops working immediately, so every board, box or gate, has to be reflashed with this one. */
  adminDeviceApiKeyRegenerate: () => api.post<DeviceApiKey>("/api/v1/admin/devices/api-key/regenerate", {}),

  // Admin: courts
  adminCourtsList: () => api.get<AdminCourt[]>("/api/v1/admin/courts/"),
  adminCourtsCreate: (req: { name: string; courtType?: string }) =>
    api.post<{ id: string; court_number: number }>("/api/v1/admin/courts/", { name: req.name, courtType: req.courtType ?? "Squash" }),
  adminCourtsUpdate: (id: string, req: { name?: string; isActive?: boolean }) =>
    api.patch<{ saved: true }>(`/api/v1/admin/courts/${id}`, req),
  adminCourtsDelete: (id: string) => api.del<{ deactivated: true }>(`/api/v1/admin/courts/${id}`),

  // Profile (authenticated user)
  meProfile: () => api.get<MyProfile>("/api/v1/me/profile"),
  meUpdateProfile: (req: { fullName?: string; photoUrl?: string }) =>
    api.put<{ full_name: string; photo_url: string | null }>("/api/v1/me/profile", req),
  meUploadPhoto: async (file: File): Promise<{ photo_url: string }> => {
    const fd = new FormData();
    fd.append("file", file);
    const tok = tokenStore.get();
    const res = await fetchWithTimeout("/api/v1/me/photo", {
      method: "POST",
      headers: tok ? { Authorization: `Bearer ${tok}` } : undefined,
      body: fd,
    }, UPLOAD_TIMEOUT_MS);
    if (!res.ok) throw await failureFrom(res);
    return res.json();
  },

  // Admin: full ledger
  adminLedger: (params: { from?: string; to?: string; userId?: string; type?: string; limit?: number } = {}) =>
    api.get<LedgerRow[]>(`/api/v1/admin/ledger/${qs({
      from: params.from, to: params.to, userId: params.userId, type: params.type,
      limit: params.limit !== undefined ? String(params.limit) : undefined,
    })}`),

  // --- doors: member -------------------------------------------------------------
  /**
   * Everything this member needs to know about their club's doors, in one read.
   *
   * <p>
   * Polled while the page is visible. `last_decision` is this member's own newest
   * `gate.*` row inside the server's fetch window, tenant- and subject-scoped both —
   * never another member's row and never another club's.
   * </p>
   */
  meDoor: () => api.get<MemberDoor>("/api/v1/me/door"),
  /**
   * The member's own door history, paged by cursor. Own rows only.
   *
   * <p>
   * Never polled: it is read on mount and on Show more, because a member scanning back
   * through their own record should control every fetch.
   * </p>
   */
  meDoorHistory: (params: { cursor?: string; limit?: number } = {}) =>
    api.get<MemberDoorHistory>(`/api/v1/me/door/history${qs({ cursor: params.cursor, limit: params.limit })}`),
  // --- end doors: member ---------------------------------------------------------
};

function qs(o: Record<string, string | number | undefined>) {
  const p = Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
  return p ? `?${p}` : "";
}

// ---------------------------------------------------------------------------------------
// doors: admin
//
// Everything W1's doors surface reads and writes, appended as one block so a sibling lane
// editing this file has one place to merge rather than nine. Shapes are WIRE-W1's, exactly;
// where one of them looked wrong the rule was to say so rather than to invent another.
// ---------------------------------------------------------------------------------------

/**
 * What this door's lock does with no power — admin-entered, and NEVER inferred.
 *
 * <p>
 * An earlier version of this product guessed it from the board's own polarity flags and was
 * wrong. It is a property of the lock and its wiring, which this software cannot see and
 * cannot change; `not_established` is the honest default rather than a placeholder, and the
 * screens say whose job it is to find out.
 * </p>
 */
export const POWER_LOSS_BEHAVIOURS = ["not_established", "released", "locked"] as const;

export type PowerLossBehaviour = (typeof POWER_LOSS_BEHAVIOURS)[number];

/**
 * A gate row with W1.4's door-card fields on it.
 *
 * <p>
 * An intersection rather than three more members on {@link AdminDevice}, because they are
 * meaningful on a Gate alone — the API refuses both on a court box with
 * `door_fields_on_a_court_box` — and because a type that says so is cheaper than a comment
 * saying so. Every field is optional on the way in: the migration lands with the backend
 * lane, and a doors page talking to an API without it must render the "nobody has written
 * this down" arm rather than `undefined`.
 * </p>
 */
export type AdminDoorDevice = AdminDevice & {
  /** At most 200 characters. Where somebody would physically find this board. */
  location_note?: string | null;
  power_loss_behaviour?: PowerLossBehaviour;
  /** When this door was shut, for the standing notice. Null while it is open. */
  out_of_service_since?: string | null;
  /**
   * When a SHUT-ALL shut this door, as opposed to an admin shutting it on its own
   * (WIRE-W1 §5's `shut_by_shut_all_at`). Null on a door shut individually.
   *
   * <p>
   * C1: `reopen-all` reopens only what a shut-all shut, and the UI has to be able to say
   * which doors those are BEFORE the request — the fleet Reopen control is labelled with
   * the count it will actually reopen, and the confirm names the doors that will stay shut.
   * Without this the page can only read the tenant-wide `shut_all_active`, which cannot
   * distinguish a door shut on its own while a shut-all is standing. `undefined` means this
   * API does not carry it yet and the page falls back to the flag.
   * </p>
   */
  shut_by_shut_all_at?: string | null;
  /**
   * WHO shut this door (WIRE-R2 §2), or null where the API does not carry it.
   *
   * <p>
   * A5: the state paragraph read "You shut this door." to every admin who opened the page,
   * which is false for all but one of them and unfalsifiable for the reader. The audit row
   * has always had the actor; the door row now carries the name.
   * </p>
   */
  shut_by_name?: string | null;
  /**
   * <b>WIRE-R3 §1 — when this board was TOLD it is shut. R3-1's whole payload.</b>
   *
   * <p>
   * The first time the server served this board a 403 after the current shut began; cleared
   * on reopen. It is the only evidence there has ever been that a shut arrived: a board that
   * gets a 403 denies the scan outright and commits an empty roster, so a door with a
   * `shut_heard_at` is confirmed shut whatever it has done since.
   * </p>
   *
   * <p>
   * <b>Three values, and the third is the one that was being answered wrongly.</b> An instant
   * is confirmed. `null` is "shut, and it has not called since" — NOT confirmed, and the
   * cached-list caveat applies. <b>`undefined` is an API that cannot say</b>, and until this
   * round the screens said it confidently in whichever direction the door's frozen
   * `last_seen_at` pointed: `ResolveAsync` returned `Forbid()` before it noted contact, so a
   * shut door's age froze, the chip flipped to "Not reporting" after 180 s and the page
   * asserted "nothing can reach it, so it has not been told" about a board that had heard the
   * refusal within one heartbeat and emptied its roster. Unknown is not false; the screens
   * fall back to liveness only where the field is absent, and say so.
   * </p>
   */
  shut_heard_at?: string | null;
  /**
   * How many events this board's ring buffer overwrote before it could upload them
   * (WIRE-R3 §1) — a since-boot TOTAL the heartbeat reports, not a delta.
   *
   * <p>
   * G4c: the board has reported this since the gate shipped and nothing stored or showed it,
   * so a door that dropped records during an outage looked identical to one that dropped
   * none. `0` is a real answer and means none were lost; `undefined` means this API does not
   * carry it and the screens say nothing rather than printing a zero they did not read.
   * </p>
   */
  events_lost?: number;
  /** When that total was last reported. Null where the board has never said. */
  events_lost_reported_at?: string | null;
};

/**
 * A reading of recent events at one door, derived on read — never a row, never an event.
 *
 * <p>
 * <b>It carries no member, no fingerprint and no code, by construction.</b> P3 and P4 forbid
 * a per-member observation on an admin screen as plainly as they forbid a per-member filter,
 * and the derivation for "may not be releasing" is "the same credential three times in sixty
 * seconds" — which at a club of two hundred people IS a member. Keeping the member out of the
 * payload is what makes the rule structural instead of a convention the next round forgets:
 * `describeActivityWho` cannot be reached from a value that has nothing to give it.
 * </p>
 */
export type DoorSignal = {
  kind: "refusal_spike" | "may_not_be_releasing";
  since: string;
  until: string;
  /** A count of SCANS. One person trying four times is four. */
  scans: number;
};

/**
 * Today's two numbers for one door, counted in the CLUB's timezone by the server.
 *
 * <p>
 * Two numbers and never one: a single headline number per door, on a list of doors, is a
 * footfall ranking by accident — which is the shape P3 exists to prevent. And counted at the
 * server because "today" in a browser is a different day from the club's for any admin
 * travelling or with a wrong device clock, and this is the number an admin quotes in a
 * committee meeting.
 * </p>
 */
export type DoorToday = { released: number; refused: number };

export type DoorRow = {
  device: AdminDoorDevice;
  /**
   * Null when the counting failed — NEVER `{released: 0, refused: 0}` for unknown. A zero
   * rendered on a failed read is the `admin-failed-read` defect with a different noun: an
   * admin reads "0 opened" and concludes a working door is dead.
   */
  today: DoorToday | null;
  signals: DoorSignal[];
};

export type DoorsView = {
  /** The club-time day boundary the counts are measured from. Named on screen. */
  day_started_at: string;
  timezone: string;
  /** True while any door is shut by a shut-all — the club-wide banner's whole input (A1.5). */
  shut_all_active: boolean;
  /**
   * The two halves of "shut", NAMED rather than counted (C1).
   *
   * <p>
   * `reopen-all` reopens only what a shut-all shut, so the UI has to be able to say which
   * doors those are BEFORE the request: the fleet Reopen exists only while `shut_together`
   * is non-empty and is labelled with that count, and `shut_individually` is what the
   * confirm and the result name as staying shut. Optional here only so the page is correct
   * against an API that has not landed them yet — it then falls back to the per-door
   * `shut_by_shut_all_at`, and to the tenant-wide flag after that.
   * </p>
   */
  shut_together?: { id: string; name: string; gate_key: string | null }[];
  shut_individually?: { id: string; name: string; gate_key: string | null }[];
  /** Name ascending, stable. There is no sort parameter and no sort control. */
  doors: DoorRow[];
};

/**
 * Which door a log row happened at — <b>every field nullable, including the door itself.</b>
 *
 * <p>
 * <b>A1 / E-C1 / C1, the one critical of this round, and it is a type.</b> `door` was
 * `{id: string; name: string; gate_key: string|null}`, the page read `entry.door.name`, and a
 * reviewer deleting a door turned `/admin/doors/log` into a blank white page for the whole
 * club — reached four ways, one of them "Load older scans" with no link and no warning. The
 * rows outlive the board: deleting a door deletes no scans (WIRE-R2 §1).
 * </p>
 *
 * <p>
 * <b>The wire promises this is never null and the type does not believe it.</b> That promise
 * is exactly what the page trusted. `id` is null for a board that is gone; `name` and
 * `gate_key` are whatever the row stored at write time, and an old row may carry neither. So
 * every field is optional-or-null here and the compiler makes each reader say what it does
 * about that — see {@link import("./doorsCopy").doorRowName}.
 * </p>
 */
export type DoorLogDoor = {
  /** Null once the board has been deleted. There is no page to link to then. */
  id?: string | null;
  /** The display name stored on the row. Null on a row written before names were stored. */
  name?: string | null;
  gate_key?: string | null;
  /** R7 E7-4 — the live board's own code (`gate-44c103`), so an unnamed one is named as everywhere else. */
  device_code?: string | null;
  /** True once the board is gone. Absent on an older API, which means "not known to be". */
  removed?: boolean;
};

export type DoorLogEntry = DeviceActivityEntry & {
  door?: DoorLogDoor | null;
};

/**
 * A door that is GONE but still has rows inside retention (WIRE-R2 §1).
 *
 * `key` is the stored device id as written on the row, which is what `?removed_door=` takes —
 * a deleted board has no `id` to filter by, and A2's ruling is that its history stays
 * reachable rather than becoming a database query.
 */
/** R13 L13-1 — `device_code` is the board's own code, so an unnamed gate is "Unnamed scanner (gate-…)". */
export type RemovedDoor = { key: string; name?: string | null; gate_key?: string | null; device_code?: string | null };

export type DoorLogPage = {
  items: DoorLogEntry[];
  next_cursor: string | null;
  /** The club's own retention setting, so the page states a number it did not guess. */
  retention_days: number;
  /**
   * The COUNT for the filtered range, where the API can give one (WIRE-R2 §3).
   *
   * A6: "50 scans, newest first" reads as a total, and the reviewer's file had 70. Optional,
   * because a page that has no total must say "Showing 50 so far" rather than invent one.
   */
  total?: number;
  /** The club's zone, so every row on this page is written in ONE clock (A7 / O1). */
  timezone?: string;
  /** The range the SERVER resolved, which is the only range the page may state (A4). */
  range?: { from: string; to: string };
  /** Deleted doors with rows still in range, for the picker's "Removed doors" group (A2). */
  removed_doors?: RemovedDoor[];
};

/**
 * What the club log may be narrowed by: DOOR, TIME and OUTCOME. That is the whole list.
 *
 * <p>
 * There is deliberately no `member`, `user`, `subject`, `q` or `search` here, and the API
 * ignores them if they arrive. A member's own door history belongs to the member, on their
 * profile — P3 — and a filter is how a log becomes the attendance report nobody agreed to.
 * </p>
 */
export type DoorLogFilters = {
  /** A device id. */
  door?: string;
  /** A REMOVED door's stored key (WIRE-R2 §1). Never sent together with `door`. */
  removed_door?: string;
  from?: string;
  to?: string;
  /**
   * A club-local period, resolved SERVER-side (WIRE-R2 §3).
   *
   * <p>
   * A4: "Last 24 hours" is a rolling window and the page had no way to ask for yesterday or
   * for one day — a chair exporting "yesterday's" scans was handed half of yesterday and
   * half of today. The club's midnight is the server's to compute: a browser's is a
   * different instant for any admin travelling or with a wrong device clock.
   * </p>
   */
  period?: DoorLogPeriod;
  /** One club-local day, `YYYY-MM-DD`. Never sent together with `period` or from/to. */
  day?: string;
  outcome?: "released" | "refused" | "offline";
  reason?: string;
  cursor?: string;
  limit?: number;
};

/** The five named periods. `day` is the sixth choice and is its own parameter. */
export const DOOR_LOG_PERIODS = ["today", "yesterday", "last_24h", "last_7d", "last_30d"] as const;

export type DoorLogPeriod = (typeof DOOR_LOG_PERIODS)[number];

/** One door's line in a shut-all / reopen-all result, as the server saw it at that instant. */
export type FleetDoorResult = {
  id: string;
  name: string;
  gate_key: string | null;
  enabled: boolean;
  /**
   * The age at the moment the SERVER did the work. The result panel renders this and never
   * recomputes it: a receipt left open for ten minutes must not drift "confirmed 12s ago"
   * into "confirmed 10m ago".
   */
  last_seen_at: string | null;
  offline_after_seconds: number;
  power_loss_behaviour: PowerLossBehaviour;
};

/**
 * A shut-all / reopen-all answer.
 *
 * `left_shut` is C1's ruling made structural: a reopen-all that leaves doors shut says which
 * ones, so a zero-change result can never print "0 doors reopened" with no reason. Optional
 * because the backend lane lands it separately — the page names the doors it already knows
 * about when the field is absent, rather than going silent.
 */
export type FleetResult = {
  doors: FleetDoorResult[];
  left_shut?: { id: string; name: string; gate_key: string | null }[];
};

function doorLogQuery(f: DoorLogFilters): string {
  return qs({
    door: f.door, removed_door: f.removed_door,
    // `period` / `day` / from-to are mutually exclusive: more than one is a 400
    // `range_conflict` at the API (WIRE-R2 §3), so the page sends exactly one and the
    // builder does not quietly merge them.
    period: f.period, day: f.day, from: f.from, to: f.to,
    outcome: f.outcome, reason: f.reason,
    cursor: f.cursor, limit: f.limit !== undefined ? String(f.limit) : undefined,
  });
}

export const doorEndpoints = {
  /** The overview's one read: every gate, its two counts and its signals, in one call. */
  doors: () => api.get<DoorsView>("/api/v1/admin/doors"),

  /** The club log, newest first, cursor-paged. Defaults at the server: last 24 h, 50 rows. */
  doorActivity: (filters: DoorLogFilters = {}) =>
    api.get<DoorLogPage>(`/api/v1/admin/doors/activity${doorLogQuery(filters)}`),

  /** The CSV's URL, exported so a test can prove it is byte-identical to the list's query. */
  doorActivityCsvUrl: (filters: DoorLogFilters = {}) =>
    `/api/v1/admin/doors/activity.csv${doorLogQuery(filters)}`,

  /**
   * The CSV, fetched WITH the session's bearer token and handed back as a blob.
   *
   * <p>
   * A bare `<a download>` navigates with no Authorization header at all, so the API cannot
   * even resolve a tenant and answers `400 tenant_unresolved` as JSON: the download starts,
   * cancels itself, and the page looks identical before and after. That exact defect shipped
   * once already on the wallet CSV, and this is the same fix, not a new one.
   * </p>
   */
  doorActivityCsv: async (
    filters: DoorLogFilters = {},
  ): Promise<{ blob: Blob; filename: string; rows: number | null; truncated: boolean }> => {
    const res = await fetchWithTimeout(doorEndpoints.doorActivityCsvUrl(filters), {
      headers: { ...(tokenStore.get() ? { authorization: `Bearer ${tokenStore.get()}` } : {}) },
    });
    if (!res.ok) throw await failureFrom(res);
    const disposition = res.headers.get("content-disposition") ?? "";
    const match = /filename="?([^"]+)"?/.exec(disposition);
    // B3: the real row count, from the server, or NULL. The page announced the length of
    // the list on screen — "50 scans downloaded" over a 165-row file — because that was the
    // only number it had. `null` is the honest answer against an API that does not send the
    // header; the copy then carries no number at all rather than the wrong one.
    const header = res.headers.get("x-crusaders-rows");
    const counted = Number(header);
    const rows = header !== null && Number.isFinite(counted) && counted >= 0 ? counted : null;
    // `X-Crusaders-Truncated` rather than comparing the count to a cap this side holds: the
    // cap is the server's, and a client that decides "this looks like the limit" is wrong
    // the day the server's limit moves.
    const truncated = (res.headers.get("x-crusaders-truncated") ?? "").toLowerCase() === "true";
    return { blob: await res.blob(), filename: match?.[1] ?? "door-log.csv", rows, truncated };
  },

  /**
   * Shut every door, or reopen the ones a shut-all shut.
   *
   * <p>
   * One unit of work and one audit row at the server, which is the only reason the error copy
   * is allowed to say "nothing was shut, every door is exactly as it was". N PATCHes would
   * make that sentence a guess.
   * </p>
   *
   * <p>
   * `reopen-all` reopens only what a shut-all shut, so a door an admin shut on its own stays
   * shut — otherwise the club-wide control would quietly undo an individual decision.
   * </p>
   */
  doorsShutAll: () => api.post<FleetResult>("/api/v1/admin/doors/shut-all", {}),
  doorsReopenAll: () => api.post<FleetResult>("/api/v1/admin/doors/reopen-all", {}),

  /**
   * The door-card fields, on the devices PATCH that already owns a gate row.
   *
   * <p>
   * `location_note` binds two-valued like `gate_key`: `""` clears it, an absent key leaves it
   * alone. There is no way to spell a clear as `null` here, for the same reason
   * {@link endpoints.adminDeviceUpdate} has none — the page did exactly that once and cleared
   * nothing while reporting success.
   * </p>
   */
  doorFieldsSave: (
    id: string,
    req: {
      /**
       * <b>`""` CLEARS the name (WIRE-R3 §3), and that is why it is sent.</b>
       *
       * A2/B2: the editor used to substitute the old name for an empty field, so an admin who
       * cleared it was told the save had worked and the name was exactly as it had been. A
       * cleared name is a real decision — the door falls back to the one unnamed fallback —
       * and either the screen performs it or it refuses; it may not do neither and report the
       * first.
       */
      name?: string;
      gate_key?: string;
      location_note?: string;
      power_loss_behaviour?: PowerLossBehaviour;
    },
  ) => api.patch<DoorPatchResult>(`/api/v1/admin/devices/${id}`, { ...req }),

  /**
   * Shut one door, or reopen it — the same PATCH, typed for the answer it can now give.
   *
   * <p>
   * <b>B10.</b> A tab left open overnight "shut" a door somebody else had already shut and
   * reported success, so the screen taught an admin that their click had done something.
   * WIRE-R2 §2: a PATCH that changes nothing answers 200 `unchanged: true` with the CURRENT
   * `shut_by_name` / `out_of_service_since`, which is the only way the page can say who
   * actually did it and when.
   * </p>
   *
   * <p>
   * It goes through the doors block rather than {@link endpoints.adminDeviceUpdate} because
   * the extra field is a doors contract; the Devices page's own call site is unchanged and
   * still typed as it was.
   * </p>
   */
  /**
   * @param expectedEnabled what this tab last READ the door's state to be (WIRE-R3 §3).
   *
   * <p>
   * <b>B13 / R3-34 — a background tab acts on a state that is hours old.</b> `unchanged: true`
   * catches the case where the door is already where this click would put it; it cannot catch
   * the opposite one, where somebody else shut the door and reopened it since this tab read,
   * or where a tab left open all night arms a control against a screen that has moved on. The
   * expectation goes with the write and the server answers 409 `door_changed` rather than
   * applying it, which is the only way this screen can say "it changed since you looked"
   * instead of quietly winning.
   * </p>
   *
   * <p>
   * Omitted — never sent as null — when the page genuinely has no prior read, because an
   * absent expectation is the API's "apply it" and a null would be an expectation of nothing.
   * </p>
   */
  doorSetEnabled: (id: string, enabled: boolean, expectedEnabled?: boolean) =>
    api.patch<DoorPatchResult>(`/api/v1/admin/devices/${id}`, {
      enabled,
      ...(expectedEnabled === undefined ? {} : { expected_enabled: expectedEnabled }),
    }),
};

/**
 * What a door PATCH answers: the row, plus whether it changed anything (WIRE-R2 §2).
 *
 * <p>
 * <b>Read the VALUE, never the presence.</b> The field is on every DeviceView the API
 * serves — `false` on a list row and on a PATCH that did work, `true` only on a no-op — so
 * `"unchanged" in answer` is true of every door the club has and would report every shut as
 * a shut that had already happened. It stays optional here for an older API that does not
 * send it at all, and an absent field means the same thing a `false` does: the page says
 * what it did rather than claiming the door was already in that state.
 * </p>
 */
export type DoorPatchResult = AdminDoorDevice & { unchanged?: boolean };
