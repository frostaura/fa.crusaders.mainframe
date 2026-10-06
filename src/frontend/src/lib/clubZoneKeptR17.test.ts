import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * R17 X17-5 — the club's zone is kept with the member's kept reads. It lived in memory only, so a
 * phone opened offline (a cold start, no `/me/profile` answer) drew its kept bookings in the
 * reader's zone. A fresh module (a restart) now starts from what the club last said; sign-out
 * forgets it; a stored zone this engine cannot format in is ignored.
 */

async function freshModule() {
  vi.resetModules();
  return import("./clubZone");
}

afterEach(() => { window.localStorage.clear(); });

describe("the club's zone survives a restart (R17 X17-5)", () => {
  it("remembered, then a restart: still known, and the club's", async () => {
    (await freshModule()).rememberClubZone("Africa/Johannesburg");
    const restarted = await freshModule();
    expect(restarted.clubZoneIsKnown()).toBe(true);
    expect(restarted.clubZone()).toBe("Africa/Johannesburg");
  });

  it("the club saying another zone replaces the kept one", async () => {
    (await freshModule()).rememberClubZone("Africa/Johannesburg");
    const restarted = await freshModule();
    restarted.rememberClubZone("Europe/London");
    expect((await freshModule()).clubZone()).toBe("Europe/London");
  });

  it("sign-out forgets it across a restart too", async () => {
    const first = await freshModule();
    first.rememberClubZone("Africa/Johannesburg");
    first.forgetClubZone();
    const restarted = await freshModule();
    expect(restarted.clubZoneIsKnown()).toBe(false);
    expect(restarted.clubZone()).toBeUndefined();
  });

  it("a kept zone the engine cannot use is never a guess", async () => {
    window.localStorage.setItem("crusaders.club-zone", "Africa/Johanesburg");
    expect((await freshModule()).clubZone()).toBeUndefined();
  });
});
