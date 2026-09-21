import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clubClock, clubDate, clubDayAndClock, clubInstant, clubRangeInWords, clubRowTime } from "./clubClock";
import { clubZone, clubZoneIsKnown, forgetClubZone, isUsableZone, noteClubZoneFrom, rememberClubZone } from "./clubZone";
import { api } from "./api";
import { stubFetch } from "../test/harness";

/**
 * R3-3 / E2 — every clock face on the doors surface, written in the CLUB's day.
 *
 * <p>
 * <b>The finding.</b> Reviewer E drove the console with `timezoneId=Pacific/Auckland` and read
 * the log header: "Read at 06:09 club time", over rows whose dates were a day out, beside a
 * Door-events block and a CSV — both written by the server — that were correct. The screen was
 * in the reader's zone and said it was in the club's.
 * </p>
 *
 * <p>
 * <b>Why no existing test could see it.</b> There was no test for these formatters at all, and
 * every test of every call site runs with `TZ=Africa/Johannesburg` pinned in `vite.config.ts`
 * — which is the club's own zone. Passing the club's zone and passing nothing produce the same
 * string under that runner, so the one defect this module can have is exactly the one the whole
 * suite is blind to. That is the real finding here: a fixture whose value happens to equal the
 * default it is meant to override cannot test anything.
 * </p>
 *
 * <p>
 * <b>So the runner's zone is the fixture.</b> Every case below runs three times — in the club's
 * zone, 10 hours ahead of it, and 9 hours behind — by setting `process.env.TZ`, which Node
 * honours for `Date` and `Intl` from the next call onwards. The whole suite can be run in
 * another zone too (`VITEST_TZ=Pacific/Auckland npx vitest run`, see `vite.config.ts`), and
 * these cases hold under that as well: nothing here asserts the runner's own clock.
 * </p>
 */

/** Two of these are deliberately not the club's, and one is a day ahead of it. */
const RUNNER_ZONES = ["Africa/Johannesburg", "Pacific/Auckland", "America/Los_Angeles"] as const;

const CLUB = "Africa/Johannesburg";

/** 2026-09-19 21:25 in Johannesburg — 07:25 the NEXT day in Auckland, 12:25 the same day in LA. */
const EVENING = "2026-09-19T19:25:00.000Z";

/** 2026-09-19 01:30 in Johannesburg — still the 18th in Los Angeles. */
const SMALL_HOURS = "2026-09-18T23:30:00.000Z";

const realTz = process.env.TZ;
afterAll(() => { process.env.TZ = realTz; });

describe.each(RUNNER_ZONES)("with the reader's own browser in %s", (runnerZone) => {
  beforeEach(() => {
    process.env.TZ = runnerZone;
    forgetClubZone();
  });

  it("writes the club's clock face, not the reader's", () => {
    expect(clubClock(EVENING, CLUB)).toBe("21:25");
  });

  it("writes the club's DATE, not the reader's", () => {
    // The mutation this kills: dropping `timeZone` from the date half while keeping it on the
    // clock half. In Auckland the instant above is the 20th; in Los Angeles it is the 19th but
    // at lunchtime. Only the club's own calendar day gives the 19th.
    //
    // "Sept", not "Sep": CLDR 42 changed the en-GB abbreviation for September, and this is
    // what the engine the app runs in actually writes. Asserted literally rather than derived
    // from `Intl`, which would be the implementation testing itself — if a runtime upgrade
    // changes it, that is a visible change to every doors row and worth one red test.
    expect(clubDayAndClock(EVENING, CLUB)).toBe("Sat 19 Sept, 21:25");
    expect(clubInstant(EVENING, CLUB)).toBe("19 September 2026, 21:25");
    expect(clubDate(EVENING, CLUB)).toBe("19 September 2026");
  });

  it("decides 'is this row today' in the club's calendar day", () => {
    // 04:00 club time on the 19th, reading a row stamped 01:30 club time on the 19th. Same club
    // day, so the row prints a bare clock face. In Los Angeles "now" is the 18th and the row is
    // the 18th too — which would also be "today" — so the case that actually separates the two
    // implementations is the one below.
    const nowSameClubDay = Date.parse("2026-09-19T02:00:00.000Z");
    expect(clubRowTime(SMALL_HOURS, nowSameClubDay, CLUB)).toBe("01:30");

    // 21:25 club time on the 19th read at 00:30 club time on the 20th: a different club day, so
    // the date comes with it. In Auckland both instants fall on the 20th — a browser-zone
    // comparison would drop the date exactly when an admin most needs it.
    const nowNextClubDay = Date.parse("2026-09-19T22:30:00.000Z");
    expect(clubRowTime(EVENING, nowNextClubDay, CLUB)).toBe("Sat 19 Sept, 21:25");
  });

  it("writes the resolved range in the club's day, and says so", () => {
    expect(clubRangeInWords({ from: SMALL_HOURS, to: EVENING }, CLUB))
      .toBe("Scans from Sat 19 Sept, 01:30 to Sat 19 Sept, 21:25, club time.");
  });

  it("falls back to the club's remembered zone when the payload did not carry one", () => {
    // The defect that survives a required argument: the call site passes `payload.timezone`
    // faithfully and the payload has no such field. Before R3-3 that rendered the reader's own
    // clock under a heading reading "club time".
    rememberClubZone(CLUB);
    expect(clubClock(EVENING, undefined)).toBe("21:25");
    expect(clubDayAndClock(EVENING, undefined)).toBe("Sat 19 Sept, 21:25");
    expect(clubRowTime(EVENING, Date.parse("2026-09-19T22:30:00.000Z"), undefined)).toBe("Sat 19 Sept, 21:25");
  });

  it("a caller that DOES pass the zone teaches it to the ones that do not", () => {
    // One screen, two payloads: the log carries `timezone`, the fleet receipt beside it does
    // not. They may not print two different midnights.
    expect(clubZoneIsKnown()).toBe(false);
    clubDayAndClock(EVENING, CLUB);
    expect(clubZone()).toBe(CLUB);
    expect(clubClock(EVENING)).toBe("21:25");
  });

  it("uses the reader's own clock while the club has said nothing — and never guesses", () => {
    // The honest arm. Nothing here may invent a zone: a volunteer standing in the club is in
    // the club's zone, and a caller may not write the words "club time" over this one.
    expect(clubZoneIsKnown()).toBe(false);
    const own = new Date(EVENING).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
    expect(clubClock(EVENING)).toBe(own);
  });

  it("survives a zone this engine has never heard of instead of throwing", () => {
    // `toLocaleTimeString` throws a RangeError on an unknown `timeZone`, and the value comes
    // from a settings column somebody typed. A blank console is a worse answer to a typo than
    // a clock in the reader's own zone.
    rememberClubZone(CLUB);
    expect(() => clubClock(EVENING, "Africa/Johanesburg")).not.toThrow();
    expect(clubClock(EVENING, "Africa/Johanesburg")).toBe("21:25");
    // And a bad zone never replaces a good remembered one.
    rememberClubZone("Mars/Olympus_Mons");
    expect(clubZone()).toBe(CLUB);
  });
});

/**
 * A13's rule, held by something other than a reviewer's eye.
 *
 * <p>
 * `utils.formatInstant` writes `toLocaleString(undefined, …)` — the READER's locale and the
 * reader's zone, "9/19/26, 9:25 PM". It is wrong on every doors surface, where a time is a
 * fact about the club's day that an admin quotes in a committee meeting.
 * </p>
 *
 * <p>
 * <b>And it was wrong on the wallet too, which this paragraph used to defend.</b> "A movement
 * is an instant in the reader's own clock" sounds right and is not: one measured member
 * journey carried THREE conventions — the grid's `23:15`, the confirm dialog's and toast's
 * `Mon, Sep 21, 11:15 PM`, and the wallet ledger's `9/21/26, 8:31 PM`. A member reconciling a
 * charge against the booking that caused it has to convert to be sure they are looking at the
 * same hour, and the audience is a South African club whose members the goal note describes as
 * not good with technology. The money surfaces are on this list now.
 * </p>
 *
 * <p>
 * It was found by eye twice — A13 on the feed's `<time title>`, E2 again on the log — so it is
 * held by a test now. The set below is every doors and member-door surface; `lib/clubClock` is
 * what they use instead.
 * </p>
 *
 * <p>
 * <b>What this net does not cover, and why:</b> `pages/AdminDevices.tsx` renders a board's
 * trail — a door's board included — with `formatInstant` on its `<time title>`. It is the same
 * defect and it belongs on this list; the file is owned by another lane in this round, so the
 * one-line change is reported rather than made here. Add it to `SURFACES` in the same commit
 * that fixes it.
 * </p>
 */
describe("no doors surface writes a time in the reader's own locale", () => {
  const SURFACES = [
    "components/doors",
    "components/member-door",
    "pages/AdminDoors.tsx",
    "pages/AdminDoorsCard.tsx",
    "pages/AdminDoorsDetail.tsx",
    "pages/AdminDoorsLog.tsx",
    "pages/MyCode.tsx",
    "lib/doorsCopy.ts",
    "lib/gateCopy.ts",
    "lib/memberDoorCopy.ts",
    "lib/countdown.ts",
    // The member's money surfaces (item 8 / D4 §2.4). `LedgerTable` is shared with the admin
    // ledger, which is the same argument: one club, one clock.
    "components/LedgerTable.tsx",
    "pages/Wallet.tsx",
    "lib/walletCopy.ts",
  ];

  const sourcesUnder = (rel: string): string[] => {
    const full = resolve(__dirname, "..", rel);
    if (!statSync(full).isDirectory()) return [full];
    return readdirSync(full)
      .filter((name) => /\.tsx?$/.test(name) && !name.includes(".test."))
      .map((name) => resolve(full, name));
  };

  it.each(SURFACES)("%s formats through lib/clubClock, never utils.formatInstant", (surface) => {
    for (const file of sourcesUnder(surface)) {
      expect(readFileSync(file, "utf8"), `${file} writes a time in the reader's zone`)
        .not.toMatch(/\bformatInstant\b/);
    }
  });
});

describe("the club's zone, as a fact about the club", () => {
  beforeEach(() => { forgetClubZone(); });

  it("is learned from any payload that mentions it, wherever it came from", async () => {
    stubFetch([{ path: "/api/v1/me/door", body: { timezone: "Pacific/Auckland", doors_shut: "none" } }]);
    await api.get("/api/v1/me/door");
    expect(clubZone()).toBe("Pacific/Auckland");
  });

  it("ignores a payload with no zone rather than clearing what it knows", () => {
    rememberClubZone(CLUB);
    noteClubZoneFrom({ rows: [] });
    noteClubZoneFrom(null);
    noteClubZoneFrom("Africa/Cairo");
    noteClubZoneFrom({ timezone: 42 });
    expect(clubZone()).toBe(CLUB);
  });

  it("knows which strings are zones", () => {
    expect(isUsableZone("Africa/Johannesburg")).toBe(true);
    expect(isUsableZone("UTC")).toBe(true);
    expect(isUsableZone("")).toBe(false);
    expect(isUsableZone(null)).toBe(false);
    expect(isUsableZone("not a zone")).toBe(false);
  });

  it("is forgotten with the session, because the next person may be another club's", () => {
    rememberClubZone(CLUB);
    forgetClubZone();
    expect(clubZoneIsKnown()).toBe(false);
    expect(clubZone()).toBeUndefined();
  });

  afterAll(() => { vi.unstubAllGlobals(); });
});
