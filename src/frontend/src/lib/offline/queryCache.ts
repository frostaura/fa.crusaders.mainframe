import { readAllFor, readOne, removeRead, wipeStore, writeRead } from "./memberStore";

/**
 * The member's reads, held for the life of the tab and on the phone (R4 wave B, "offline &
 * instant"): a stale-while-revalidate cache keyed by WHO the read was for.
 *
 * <ul>
 *   <li><b>Instant revisits.</b> A page opened a second time draws what it read last time at once
 *   and refreshes it behind the member's back (`useCachedRead`).</li>
 *   <li><b>Instant warm starts and offline reads.</b> What the club last said is also kept in
 *   `memberStore` (IndexedDB) and read back into memory at boot, so a cold start draws from the
 *   phone before the network has answered — or when it never will.</li>
 *   <li><b>One read, however many ask.</b> A read already in flight for a key is joined, so a
 *   nav-link prefetch and the page it opens are one request.</li>
 * </ul>
 *
 * <p>
 * <b>Privacy is the design, not a feature of it.</b> Memory is keyed by member; switching member
 * empties it; {@link wipeMemberData} empties it and deletes the store. A read that answers after a
 * wipe or a switch is DROPPED (the generation moved), and nothing is written to the phone unless
 * the persist guard — `lib/auth`: the token and the confirmed identity on this phone still name
 * the same member — says so at the moment of writing. Without a guard registered nothing is kept
 * on the phone at all.
 * </p>
 */

export type CacheEntry = {
  value: unknown;
  /** When the club said it (ms). For a stored entry, when it was stored — the "as of". */
  at: number;
  /** `club`: read in this tab. `stored`: read back from the phone and not yet confirmed. */
  source: "club" | "stored";
};

let owner: string | null = null;
let generation = 0;
const memory = new Map<string, CacheEntry>();
const inflight = new Map<string, { generation: number; promise: Promise<unknown> }>();
const listeners = new Map<string, Set<() => void>>();
const ownerListeners = new Set<() => void>();
let persistGuard: (who: string) => boolean = () => false;
/** Kept reads already looked for on the phone this generation, by slot: one IndexedDB read each. */
const looked = new Map<string, Promise<CacheEntry | undefined>>();
let pruneTimer: ReturnType<typeof setTimeout> | null = null;

const slot = (who: string, key: string) => `${who}\u0000${key}`;

function notify(id: string) {
  for (const fn of listeners.get(id) ?? []) fn();
}

function notifyEverything() {
  for (const set of listeners.values()) for (const fn of set) fn();
  for (const fn of ownerListeners) fn();
}

/** The member whose reads may be kept on this phone (set by `lib/auth`), or null. */
export function getDataOwner(): string | null {
  return owner;
}

export function subscribeDataOwner(fn: () => void): () => void {
  ownerListeners.add(fn);
  return () => { ownerListeners.delete(fn); };
}

/** `lib/auth` says, at the moment of every write, whether `who` is still the member on this phone. */
export function setPersistGuard(guard: (who: string) => boolean): void {
  persistGuard = guard;
}

/**
 * The member this phone now belongs to. A DIFFERENT member empties memory and drops every read in
 * flight; their own stored reads are then read back from the phone.
 */
export function setDataOwner(next: string | null): void {
  if (next === owner) return;
  owner = next;
  generation += 1;
  memory.clear();
  inflight.clear();
  looked.clear();
  notifyEverything();
  if (next) schedulePrune(next);
}

/**
 * Sign-out, "sign out everywhere", a lapse, a different member: nothing of the last member stays
 * in this tab or on the phone. Resolves once the store is deleted.
 */
export function wipeMemberData(): Promise<void> {
  owner = null;
  generation += 1;
  memory.clear();
  inflight.clear();
  looked.clear();
  notifyEverything();
  return wipeStore();
}

/** A kept day grid from before yesterday (UTC): nothing a member could open, offline or not. */
export function pastDay(key: string): boolean {
  const day = /^schedule:(\d{4}-\d{2}-\d{2})$/.exec(key)?.[1];
  return day !== undefined && Date.parse(`${day}T00:00:00Z`) < Date.now() - 2 * 86_400_000;
}

/**
 * The phone's copy of ONE read, into memory — never over a read this tab has made. On demand, key
 * by key, rather than the whole store at boot: reading every kept day grid back at start-up cost a
 * cold My Code ~110 ms of structured-clone on the main thread (4x CPU, measured A/B), for reads My
 * Code never shows. The first subscriber to a key asks; everyone after shares the answer.
 */
export function loadKept(who: string | null, key: string): Promise<CacheEntry | undefined> {
  if (!who) return Promise.resolve(undefined);
  const id = slot(who, key);
  const held = memory.get(id);
  if (held) return Promise.resolve(held);
  const asked = looked.get(id);
  if (asked) return asked;
  const at = generation;
  const promise = readOne(who, key).then((record) => {
    if (!record || at !== generation || owner !== who) return memory.get(id);
    if (!memory.has(id)) {
      memory.set(id, { value: record.value, at: record.at, source: "stored" });
      notify(id);
    }
    return memory.get(id);
  });
  looked.set(id, promise);
  return promise;
}

/** Once the app has settled, delete what the phone keeps that nobody could open (see `pastDay`). */
function schedulePrune(who: string) {
  if (pruneTimer !== null || typeof window === "undefined") return;
  pruneTimer = setTimeout(() => {
    pruneTimer = null;
    const run = () => { if (owner === who) void readAllFor(who, Date.now(), pastDay); };
    if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(run, { timeout: 10_000 });
    else run();
  }, 15_000);
}

export function peekQuery(who: string | null, key: string): CacheEntry | undefined {
  return who ? memory.get(slot(who, key)) : undefined;
}

export function subscribeQuery(who: string | null, key: string, fn: () => void): () => void {
  if (!who) return () => undefined;
  const id = slot(who, key);
  let set = listeners.get(id);
  if (!set) { set = new Set(); listeners.set(id, set); }
  set.add(fn);
  // The first look at a key this generation reads the phone's copy of it.
  if (!memory.has(id) && !looked.has(id)) void loadKept(who, key);
  return () => {
    set.delete(fn);
    if (set.size === 0) listeners.delete(id);
  };
}

function keep(who: string, key: string, entry: CacheEntry, persist: boolean) {
  memory.set(slot(who, key), entry);
  notify(slot(who, key));
  if (persist && who === owner && persistGuard(who)) void writeRead({ owner: who, key, at: entry.at, value: entry.value });
}

export type FetchOptions = {
  /** Keep the answer on the phone too (default true). */
  persist?: boolean;
  /** An answer read in this tab within this many ms is reused instead of asking again. */
  reuseWithinMs?: number;
};

/**
 * Asks the club for `key` — joining a read already in flight for it — and keeps the answer for
 * `who`. A read that lands after a wipe or a change of member is handed back to its caller (who
 * asked for it) but kept nowhere.
 */
export function fetchQuery<T>(who: string | null, key: string, load: () => Promise<T>, options: FetchOptions = {}): Promise<T> {
  if (!who) return load();
  const { persist = true, reuseWithinMs = 0 } = options;
  const id = slot(who, key);
  const held = memory.get(id);
  if (reuseWithinMs > 0 && held?.source === "club" && Date.now() - held.at < reuseWithinMs) return Promise.resolve(held.value as T);
  const running = inflight.get(id);
  if (running && running.generation === generation) return running.promise as Promise<T>;
  const at = generation;
  const promise = load().then((value) => {
    if (at === generation) keep(who, key, { value, at: Date.now(), source: "club" }, persist);
    return value;
  });
  inflight.set(id, { generation: at, promise });
  const done = () => { if (inflight.get(id)?.promise === promise) inflight.delete(id); };
  promise.then(done, done);
  return promise;
}

/** A hint: start the read now (route intent, a deep link); failures are the page's to say. */
export function prefetchQuery<T>(who: string | null, key: string, load: () => Promise<T>, freshMs = 5_000): void {
  if (!who) return;
  fetchQuery(who, key, load, { reuseWithinMs: freshMs }).catch(() => undefined);
}

/** A write's answer applied to what is held (and kept on the phone), keeping its "as of". */
export function updateQuery<T>(who: string | null, key: string, update: (current: T) => T): void {
  if (!who) return;
  const held = memory.get(slot(who, key));
  if (!held) return;
  keep(who, key, { ...held, value: update(held.value as T) }, true);
}

/** A write's answer IS the read (a profile saved): held as read from the club, now. */
export function primeQuery<T>(who: string | null, key: string, value: T): void {
  if (!who) return;
  keep(who, key, { value, at: Date.now(), source: "club" }, true);
}

/** Forget one read — here and on the phone (a booking this member is no longer on). */
export function dropQuery(who: string | null, key: string): void {
  if (!who) return;
  const id = slot(who, key);
  if (memory.delete(id)) notify(id);
  if (who === owner) void removeRead(who, key);
}

/** Tests only: nothing held and no owner, so no test is answered by the one before it. */
export function resetQueryCacheForTests(): void {
  owner = null;
  generation += 1;
  memory.clear();
  inflight.clear();
  looked.clear();
}
