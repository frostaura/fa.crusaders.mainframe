import { readAllFor, removeRead, wipeStore, writeRead } from "./memberStore";

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
let hydration: { owner: string; promise: Promise<void> } | null = null;

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
  hydration = null;
  notifyEverything();
  if (next) void hydrate(next);
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
  hydration = null;
  notifyEverything();
  return wipeStore();
}

/** A kept day grid from before yesterday (UTC): nothing a member could open, offline or not. */
function pastDay(key: string): boolean {
  const day = /^schedule:(\d{4}-\d{2}-\d{2})$/.exec(key)?.[1];
  return day !== undefined && Date.parse(`${day}T00:00:00Z`) < Date.now() - 2 * 86_400_000;
}

/** Reads the phone's copy of `who`'s reads into memory, never over a read this tab has made. */
function hydrate(who: string): Promise<void> {
  if (hydration?.owner === who) return hydration.promise;
  const at = generation;
  const promise = readAllFor(who, Date.now(), pastDay).then((records) => {
    if (at !== generation || owner !== who) return;
    for (const record of records) {
      const id = slot(who, record.key);
      if (memory.has(id)) continue;
      memory.set(id, { value: record.value, at: record.at, source: "stored" });
      notify(id);
    }
  });
  hydration = { owner: who, promise };
  return promise;
}

/** Resolves once the phone's copy for the current member is in memory (or there is none). */
export function whenHydrated(): Promise<void> {
  return hydration?.promise ?? Promise.resolve();
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
  hydration = null;
}
