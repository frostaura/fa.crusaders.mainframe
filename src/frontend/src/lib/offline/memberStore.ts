/**
 * The member's own reads, kept on THIS phone for the member who is signed in on it (R4 wave B,
 * "offline & instant") — IndexedDB, never the service worker's HTTP cache.
 *
 * <p>
 * <b>Why not the worker.</b> `public/sw.js` refuses every `/api/` response and every request
 * carrying a token, and that stays: the Cache API keys on the URL and ignores the token, and
 * CacheStorage belongs to the browser profile — one club-desk tablet is one cache shared by
 * everybody who ever signed in on it, and a refuter once had one member's wallet served to
 * another through it. This store is the app's, so the app decides whose it is:
 * </p>
 * <ul>
 *   <li>every record carries the member it was read for, and a read for anybody else ignores it;</li>
 *   <li>it is DELETED on sign-out, on "sign out everywhere", on a lapse, and the moment a
 *   different member is confirmed on the phone (`lib/auth`, through `queryCache.wipeMemberData`);</li>
 *   <li>a record older than {@link MAX_AGE_MS} is not shown — a phone found in a drawer a month
 *   later says "can't reach the club", not a month-old wallet.</li>
 * </ul>
 *
 * <p>
 * Every call is wrapped and degrades to "nothing stored": private browsing, a locked-down profile
 * and jsdom (no `indexedDB`) all mean the app works exactly as it did before this store existed.
 * </p>
 */

export const MEMBER_DATA_DB = "crusaders-member-data";
const STORE = "reads";
const VERSION = 1;

/** A record this old is never shown (14 days). */
export const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export type StoredRead = { owner: string; key: string; at: number; value: unknown };

type Row = StoredRead & { id: string };

const idOf = (owner: string, key: string) => `${owner}\u0000${key}`;

function factory(): IDBFactory | null {
  try { return typeof indexedDB === "undefined" ? null : indexedDB; } catch { return null; }
}

let opening: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (opening) return opening;
  const idb = factory();
  if (!idb) return Promise.resolve(null);
  const attempt = new Promise<IDBDatabase | null>((resolve) => {
    let request: IDBOpenDBRequest;
    try { request = idb.open(MEMBER_DATA_DB, VERSION); } catch { resolve(null); return; }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    request.onsuccess = () => {
      const db = request.result;
      // Another tab is deleting the store (a sign-out there): let it, at once.
      db.onversionchange = () => { db.close(); if (opening === attempt) opening = null; };
      resolve(db);
    };
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  opening = attempt;
  void attempt.then((db) => { if (!db && opening === attempt) opening = null; });
  return attempt;
}

function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T> | null): Promise<T | null> {
  return open().then((db) => new Promise<T | null>((resolve) => {
    if (!db) { resolve(null); return; }
    try {
      const tx = db.transaction(STORE, mode);
      const request = work(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request ? request.result : null);
      tx.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    } catch { resolve(null); }
  }));
}

/**
 * Everything stored for `owner` that is still worth showing. Never throws. What is not — too old,
 * somebody else's (which a wipe should already have removed), or a day the club has moved past
 * (`stale(key)`) — is deleted on the way, so the store never grows past what a member could open.
 */
export async function readAllFor(owner: string, now = Date.now(), stale: (key: string) => boolean = () => false): Promise<StoredRead[]> {
  const rows = (await run<Row[]>("readonly", (store) => store.getAll())) ?? [];
  const keep = (row: Row) => row && row.owner === owner && typeof row.at === "number" && now - row.at < MAX_AGE_MS && !stale(row.key);
  const gone = rows.filter((row) => !keep(row)).map((row) => row.id);
  if (gone.length > 0) void run("readwrite", (store) => { for (const id of gone) store.delete(id); return null; });
  return rows.filter(keep).map(({ owner: o, key, at, value }) => ({ owner: o, key, at, value }));
}

/** One kept read for `owner`, if it is still young enough to show. Never throws. */
export async function readOne(owner: string, key: string, now = Date.now()): Promise<StoredRead | null> {
  const row = await run<Row | undefined>("readonly", (store) => store.get(idOf(owner, key)));
  if (!row || row.owner !== owner || typeof row.at !== "number" || now - row.at >= MAX_AGE_MS) return null;
  return { owner: row.owner, key: row.key, at: row.at, value: row.value };
}

/** Keeps one read. Never throws; a refusal (quota, private mode) keeps nothing. */
export async function writeRead(record: StoredRead): Promise<void> {
  await run("readwrite", (store) => store.put({ ...record, id: idOf(record.owner, record.key) } satisfies Row));
}

/** Forgets one read (a booking the member is no longer on). */
export async function removeRead(owner: string, key: string): Promise<void> {
  await run("readwrite", (store) => store.delete(idOf(owner, key)));
}

/**
 * Deletes the whole store. Cleared first through the open connection — immediate, never blocked —
 * then the database itself is deleted, so nothing of it is left in the browser profile.
 */
export async function wipeStore(): Promise<void> {
  const idb = factory();
  if (!idb) return;
  await run("readwrite", (store) => store.clear());
  const pending = opening;
  opening = null;
  const db = pending ? await pending : null;
  db?.close();
  await new Promise<void>((resolve) => {
    try {
      const request = idb.deleteDatabase(MEMBER_DATA_DB);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      // Another tab still holds it open: its `onversionchange` closes it and the delete proceeds;
      // the store is already empty either way.
      request.onblocked = () => resolve();
    } catch { resolve(); }
  });
}
