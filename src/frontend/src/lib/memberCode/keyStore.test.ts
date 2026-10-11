import { afterEach, describe, expect, it, vi } from "vitest";

import { fromHex, hmac, importHmacKey, isSoftHmacKey, toHex } from "./hotp";
import { loadMemberCode, saveMemberCode, wipeMemberCode, type MemberCodeRecord } from "./keyStore";

/**
 * The key store on a page with no WebCrypto (plain http to the club's LAN server): the record
 * holds a `SoftHmacKey`, and it must come back out of IndexedDB as one — `isRecord` accepting it —
 * or every cold start on that page enrols again and the club's box sees a new generation each time.
 */

/**
 * An IndexedDB that does what the real one does to a value: STRUCTURED-CLONES it on the way in
 * and out. So what `loadMemberCode` sees is a copy — a frozen object comes back unfrozen and a new
 * `Uint8Array` — and never the object `saveMemberCode` was handed.
 */
function fakeIndexedDb() {
  const rows = new Map<string, unknown>();
  const later = (fn: () => void) => setTimeout(fn, 0);
  const store = {
    get: (id: string) => ({ result: rows.has(id) ? structuredClone(rows.get(id)) : undefined }),
    put: (value: unknown, id: string) => { rows.set(id, structuredClone(value)); return { result: id }; },
    delete: (id: string) => { rows.delete(id); return { result: undefined }; },
  };
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => store,
    transaction: () => {
      const tx: { oncomplete?: () => void; onerror?: () => void; onabort?: () => void; objectStore: () => typeof store } = {
        objectStore: () => store,
      };
      later(() => tx.oncomplete?.());
      return tx;
    },
    close: () => undefined,
  };
  const factory = {
    open: () => {
      const req: { result: typeof db; onsuccess?: () => void; onupgradeneeded?: () => void; onerror?: () => void; onblocked?: () => void } = { result: db };
      later(() => req.onsuccess?.());
      return req;
    },
  };
  return { factory, rows };
}

const SECRET = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const ascii = (s: string) => new TextEncoder().encode(s);

function withoutSubtle() {
  vi.stubGlobal("crypto", { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });
}

async function softRecord(): Promise<MemberCodeRecord> {
  withoutSubtle();
  const key = await importHmacKey(fromHex(SECRET));
  expect(isSoftHmacKey(key)).toBe(true);
  return { key, ref: "AB12", generation: 3, tz: "Africa/Johannesburg", offsetMs: -120, userId: "u-1", enrolledAt: 7 };
}

describe("the key store holding a SoftHmacKey (no WebCrypto)", () => {
  afterEach(async () => {
    await wipeMemberCode();
    vi.unstubAllGlobals();
  });

  it("round-trips through IndexedDB: the cloned record is accepted and still signs the same", async () => {
    const { factory, rows } = fakeIndexedDb();
    vi.stubGlobal("indexedDB", factory);
    const record = await softRecord();
    await saveMemberCode(record);
    expect(rows.size).toBe(1);

    const loaded = await loadMemberCode();
    // A copy out of the store, not the in-memory fallback: `isRecord` accepted the clone.
    expect(loaded).not.toBe(record);
    expect(loaded).toMatchObject({ ref: "AB12", generation: 3, tz: "Africa/Johannesburg", offsetMs: -120, userId: "u-1" });
    expect(isSoftHmacKey(loaded!.key)).toBe(true);
    expect(toHex(await hmac(loaded!.key, ascii("step")))).toBe(toHex(await hmac(record.key, ascii("step"))));
  });

  it("refuses a stored record whose key is not a key, and falls back to this page's own copy", async () => {
    const { factory, rows } = fakeIndexedDb();
    vi.stubGlobal("indexedDB", factory);
    const record = await softRecord();
    await saveMemberCode(record);
    // Bytes without the kind tag, as a hand-edited or older record would hold them.
    rows.set("current", { ...record, key: { bytes: fromHex(SECRET) } });
    expect(await loadMemberCode()).toBe(record);
  });

  it("keeps the soft key in memory for the page's life when there is no IndexedDB", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const record = await softRecord();
    await saveMemberCode(record);
    expect(await loadMemberCode()).toBe(record);
    await wipeMemberCode();
    expect(await loadMemberCode()).toBeNull();
  });
});
