/**
 * Where the member secret lives on the phone: ONE record in IndexedDB, holding the
 * non-extractable `CryptoKey` itself (a structured-clonable handle — the raw bytes are not in
 * it and cannot be got out of it) beside the REF, the generation, the club's zone and the
 * measured clock offset (`docs/specs/member-code.md` §10).
 *
 * <p>
 * <b>Never `localStorage`.</b> `localStorage` holds strings, so the only way to put a secret
 * there is to put its BYTES there, readable by any script on the origin and by anybody with the
 * phone's browser profile. IndexedDB holds the key handle, which is the whole point.
 * </p>
 *
 * <p>
 * <b>No dependency.</b> `idb` and friends are a promise wrapper over the same four calls this
 * file makes; one object store and one record do not justify one. When IndexedDB is missing or
 * refuses to open (an old private-browsing mode, an embedded webview, jsdom) the record lives
 * in memory for the life of the page: the code still works while the page is open, and the
 * next cold start simply enrols again — which needs signal, and the page says so.
 * </p>
 */

export type MemberCodeRecord = {
  /** The member secret S, imported non-extractable with usage `sign` only. */
  key: CryptoKey;
  ref: string;
  generation: number;
  tz: string;
  /** `server − local` in ms, measured at the last successful exchange with the club. */
  offsetMs: number;
  /** The member this key belongs to — a shared club phone must never show one member another's code. */
  userId: string;
  /** Local wall clock, ms, of the enrolment — for nothing but diagnosis. */
  enrolledAt: number;
};

const DB_NAME = "crusaders-member-code";
const STORE = "keys";
const RECORD_ID = "current";

let memory: MemberCodeRecord | null = null;

function idb(): IDBFactory | null {
  try { return globalThis.indexedDB ?? null; } catch { return null; }
}

function open(): Promise<IDBDatabase | null> {
  const factory = idb();
  if (!factory) return Promise.resolve(null);
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try { req = factory.open(DB_NAME, 1); } catch { resolve(null); return; }
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

/** One request in its own transaction, resolved when the TRANSACTION commits, not the request. */
function run<T>(db: IDBDatabase, mode: IDBTransactionMode, act: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = act(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error ?? req.error);
    tx.onabort = () => reject(tx.error ?? new Error("aborted"));
  });
}

async function withDb<T>(fallback: () => T, act: (db: IDBDatabase) => Promise<T>): Promise<T> {
  const db = await open();
  if (!db) return fallback();
  try {
    return await act(db);
  } catch {
    return fallback();
  } finally {
    db.close();
  }
}

function isRecord(value: unknown): value is MemberCodeRecord {
  const r = value as Partial<MemberCodeRecord> | null;
  return !!r && typeof r === "object"
    && typeof r.ref === "string" && typeof r.generation === "number" && typeof r.tz === "string"
    && typeof r.offsetMs === "number" && typeof r.userId === "string"
    && typeof CryptoKey !== "undefined" && r.key instanceof CryptoKey;
}

/** The stored record, or null. Never throws. */
export function loadMemberCode(): Promise<MemberCodeRecord | null> {
  return withDb(
    () => memory,
    async (db) => {
      const value = await run(db, "readonly", (s) => s.get(RECORD_ID));
      // The in-memory copy covers a write IndexedDB refused (a full or read-only store): the
      // key still works for the life of this page.
      return isRecord(value) ? value : memory;
    },
  );
}

/** Replaces the record. Never throws; the in-memory copy is kept either way. */
export async function saveMemberCode(record: MemberCodeRecord): Promise<void> {
  memory = record;
  await withDb(() => undefined, async (db) => { await run(db, "readwrite", (s) => s.put(record, RECORD_ID)); });
}

/**
 * Forgets the member's key on this phone — sign-out, a different member signing in, a club
 * that has barred the member. It does not rotate the secret (the server does that); it makes
 * sure the NEXT person holding this phone cannot show the last one's code.
 */
export async function wipeMemberCode(): Promise<void> {
  memory = null;
  await withDb(() => undefined, async (db) => { await run(db, "readwrite", (s) => s.delete(RECORD_ID)); });
}
