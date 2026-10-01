import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * P13 — the member's kept reads went from credits to minutes, so the phone's store moved to
 * version 2 and a version-1 store is DROPPED on upgrade, never shown: a wallet kept as
 * `balance_credits` would paint a unit the club no longer has, offline, with nothing to correct it.
 */

type Opened = { name: string; version: number | undefined; actions: string[] };

/** A minimal IndexedDB that opens as an upgrade from `oldVersion` with the old store present. */
function fakeIndexedDb(oldVersion: number, opened: Opened[]) {
  return {
    open(name: string, version?: number) {
      const actions: string[] = [];
      opened.push({ name, version, actions });
      const stores = new Set(oldVersion > 0 ? ["reads"] : []);
      const db = {
        objectStoreNames: { contains: (s: string) => stores.has(s) },
        deleteObjectStore: (s: string) => { actions.push(`delete:${s}`); stores.delete(s); },
        createObjectStore: (s: string) => { actions.push(`create:${s}`); stores.add(s); },
        transaction: () => { throw new Error("no transactions in this fake"); },
        close: () => undefined,
        onversionchange: null as unknown,
      };
      const request = { result: db } as Record<string, unknown>;
      queueMicrotask(() => {
        (request.onupgradeneeded as (e: { oldVersion: number }) => void)?.({ oldVersion });
        (request.onsuccess as () => void)?.();
      });
      return request;
    },
  };
}

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe("the member's kept reads, after P13", () => {
  it("opens at version 2", async () => {
    const opened: Opened[] = [];
    vi.stubGlobal("indexedDB", fakeIndexedDb(0, opened));
    const store = await import("./memberStore");
    expect(store.MEMBER_DATA_VERSION).toBe(2);
    await store.readOne("u-1", "wallet");
    expect(opened[0]).toMatchObject({ name: store.MEMBER_DATA_DB, version: 2 });
  });

  it("drops a version-1 store — credit-shaped reads — before making a fresh one", async () => {
    const opened: Opened[] = [];
    vi.stubGlobal("indexedDB", fakeIndexedDb(1, opened));
    const store = await import("./memberStore");
    expect(await store.readOne("u-1", "wallet")).toBeNull();
    expect(opened[0].actions).toEqual(["delete:reads", "create:reads"]);
  });

  it("creates the store on a phone that never had one, and deletes nothing", async () => {
    const opened: Opened[] = [];
    vi.stubGlobal("indexedDB", fakeIndexedDb(0, opened));
    const store = await import("./memberStore");
    await store.readOne("u-1", "wallet");
    expect(opened[0].actions).toEqual(["create:reads"]);
  });
});
