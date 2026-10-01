import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dropQuery, fetchQuery, getDataOwner, peekQuery, prefetchQuery, primeQuery, resetQueryCacheForTests,
  setDataOwner, setPersistGuard, updateQuery, wipeMemberData,
} from "./queryCache";

/**
 * R4 wave B — the member query cache's rules, without a page: one read however many ask, the
 * answer kept for the member it was read for and nobody else, and nothing kept once the phone is
 * somebody else's (or nobody's).
 */

const ANA = "11111111-1111-1111-1111-111111111111";
const BEN = "22222222-2222-2222-2222-222222222222";

afterEach(() => {
  resetQueryCacheForTests();
  setPersistGuard(() => false);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("one read, however many ask", () => {
  it("joins a read already in flight for the same member and key", async () => {
    setDataOwner(ANA);
    const answer = deferred<string>();
    const load = vi.fn(() => answer.promise);
    const a = fetchQuery(ANA, "wallet:page", load);
    const b = fetchQuery(ANA, "wallet:page", load);
    answer.resolve("ledger");
    await expect(a).resolves.toBe("ledger");
    await expect(b).resolves.toBe("ledger");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("a prefetch that just landed is the page's first read; a reload always asks again", async () => {
    setDataOwner(ANA);
    const load = vi.fn(() => Promise.resolve("day"));
    prefetchQuery(ANA, "schedule:2026-10-01", load);
    await vi.waitFor(() => expect(peekQuery(ANA, "schedule:2026-10-01")?.value).toBe("day"));
    await fetchQuery(ANA, "schedule:2026-10-01", load, { reuseWithinMs: 2_000 });
    expect(load).toHaveBeenCalledTimes(1);
    await fetchQuery(ANA, "schedule:2026-10-01", load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("a failed read keeps nothing and is not reused", async () => {
    setDataOwner(ANA);
    await expect(fetchQuery(ANA, "inbox:first", () => Promise.reject(new Error("503")), { reuseWithinMs: 5_000 })).rejects.toThrow();
    expect(peekQuery(ANA, "inbox:first")).toBeUndefined();
  });
});

describe("whose it is", () => {
  it("holds a read for the member it was read for, never for another", async () => {
    setDataOwner(ANA);
    await fetchQuery(ANA, "me:profile", () => Promise.resolve({ name: "Ana" }));
    expect(peekQuery(ANA, "me:profile")?.value).toEqual({ name: "Ana" });
    expect(peekQuery(BEN, "me:profile")).toBeUndefined();
    expect(peekQuery(null, "me:profile")).toBeUndefined();
  });

  it("a different member on the phone empties memory at once", async () => {
    setDataOwner(ANA);
    await fetchQuery(ANA, "wallet:page", () => Promise.resolve("ana's wallet"));
    setDataOwner(BEN);
    expect(peekQuery(ANA, "wallet:page")).toBeUndefined();
    expect(getDataOwner()).toBe(BEN);
  });

  it("a read that answers after a switch is handed to its caller but kept for nobody", async () => {
    setDataOwner(ANA);
    const late = deferred<string>();
    const asked = fetchQuery(ANA, "wallet:page", () => late.promise);
    setDataOwner(BEN);
    late.resolve("ana's wallet");
    await expect(asked).resolves.toBe("ana's wallet");
    expect(peekQuery(ANA, "wallet:page")).toBeUndefined();
    expect(peekQuery(BEN, "wallet:page")).toBeUndefined();
  });

  it("a wipe (sign-out) empties memory, drops the owner, and drops a read still in flight", async () => {
    setDataOwner(ANA);
    await fetchQuery(ANA, "inbox:first", () => Promise.resolve("notices"));
    const late = deferred<string>();
    const asked = fetchQuery(ANA, "wallet:page", () => late.promise);
    await wipeMemberData();
    late.resolve("ledger");
    await asked;
    expect(getDataOwner()).toBeNull();
    expect(peekQuery(ANA, "inbox:first")).toBeUndefined();
    expect(peekQuery(ANA, "wallet:page")).toBeUndefined();
  });

  it("nobody signed in: the read is made and kept nowhere", async () => {
    const load = vi.fn(() => Promise.resolve("preview"));
    await expect(fetchQuery(null, "booking:b1", load)).resolves.toBe("preview");
    await fetchQuery(null, "booking:b1", load, { reuseWithinMs: 60_000 });
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("a write's answer", () => {
  it("patches what is held, keeping its as-of; a saved profile is held as read now", async () => {
    setDataOwner(ANA);
    await fetchQuery(ANA, "play:me", () => Promise.resolve({ paused: false }));
    const at = peekQuery(ANA, "play:me")?.at;
    updateQuery<{ paused: boolean }>(ANA, "play:me", (g) => ({ ...g, paused: true }));
    expect(peekQuery(ANA, "play:me")).toMatchObject({ value: { paused: true }, at, source: "club" });
    primeQuery(ANA, "me:profile", { name: "Ana B" });
    expect(peekQuery(ANA, "me:profile")?.value).toEqual({ name: "Ana B" });
  });

  it("a booking the member is no longer on is forgotten", async () => {
    setDataOwner(ANA);
    await fetchQuery(ANA, "booking:b1", () => Promise.resolve("detail"));
    dropQuery(ANA, "booking:b1");
    expect(peekQuery(ANA, "booking:b1")).toBeUndefined();
  });
});
