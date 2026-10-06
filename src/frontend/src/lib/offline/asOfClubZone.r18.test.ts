import { afterEach, describe, expect, it } from "vitest";
import { forgetClubZone, rememberClubZone } from "../clubZone";
import { OFFLINE_COPY, asOfLabel } from "./offlineCopy";

/**
 * R18 X18-3 — "showing what we had at HH:MM" was written in the PHONE's zone and day while every
 * kept row beside it is in the club's (R17 X17-5): a phone in New York read "22:31" over bookings
 * at 13:15 club time. The label uses the club's kept zone — the clock, and whether it is today.
 */

afterEach(() => forgetClubZone());

/** A zone far from wherever the suite runs, so the two clocks cannot agree by accident. */
function farZone(): string {
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return here === "Pacific/Kiritimati" ? "Pacific/Pago_Pago" : "Pacific/Kiritimati";
}

const clock = (at: number, timeZone?: string) =>
  new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone }).format(at);

describe("X18-3 — the stale line's time is the club's", () => {
  it("today: the club's clock face, not the phone's", () => {
    const zone = farZone();
    rememberClubZone(zone);
    const at = Date.parse("2026-10-06T08:31:00Z");
    const now = at + 5 * 60_000;
    expect(asOfLabel(at, now)).toBe(clock(at, zone));
    expect(asOfLabel(at, now)).not.toBe(clock(at));
    expect(OFFLINE_COPY.staleLine(at)).toContain(clock(at, zone));
  });

  it("earlier than the club's today: day and clock in the club's calendar", () => {
    const zone = farZone();
    rememberClubZone(zone);
    const at = Date.parse("2026-10-04T08:31:00Z");
    const now = Date.parse("2026-10-06T08:31:00Z");
    const label = asOfLabel(at, now);
    expect(label).toMatch(/^\w{3} \d{1,2} \w{3}, \d{2}:\d{2}$/);
    expect(label.endsWith(clock(at, zone))).toBe(true);
  });

  it("whether it is today follows the club's day: the same instant can be 'today' there and not here", () => {
    rememberClubZone("Pacific/Kiritimati"); // UTC+14
    // 09:00Z on the 5th is 23:00 on the 5th in Kiritimati; "now" 10:30Z is 00:30 on the 6th there.
    const at = Date.parse("2026-10-05T09:00:00Z");
    const now = Date.parse("2026-10-05T10:30:00Z");
    expect(asOfLabel(at, now)).toMatch(/^Mon 5 Oct, 23:00$/);
  });
});
