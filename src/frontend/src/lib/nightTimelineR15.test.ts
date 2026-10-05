import { describe, expect, it } from "vitest";
import { buildTimeline, burstOutcomes, readableEvents } from "./nightTimeline";
import type { TraceEvent } from "./adminApi";

/**
 * R15 (BE15b, 469efc5a) — the Night's new booking kinds: the club's seat acts (taken off, settled
 * outside, collected, added) seen from the partner, the organiser and the admin, and the game's
 * no-show and its reversal on a partner's Night. Headlines are the server's (no kind→icon map), so
 * what matters is the reducer: three acts on people in a minute are three rows, never "3 in 1 minute".
 */

const AT = (s: number) => new Date(Date.parse("2026-10-05T16:00:00.000Z") + s * 1000).toISOString();
const COURT = { id: "c1", number: 1, name: "Court 1" };
const act = (kind: string, s: number): TraceEvent =>
  ({ at: AT(s), strand: "booking", kind, headline: `${kind} headline`, court: COURT, actor: { kind: "admin", name: "The club" } } as TraceEvent);

const KINDS = [
  "booking.club_took_player_off",
  "booking.share_settled_outside", "booking.partner_share_settled_outside", "booking.settled_share_outside",
  "booking.share_collected", "booking.partner_share_collected", "booking.collected_share",
  "booking.added_to_game", "booking.club_added_player", "booking.added_player",
  "booking.game_no_show", "booking.game_no_show_reversed",
];

describe("R15 — the club's seat acts and a game's no-show are never folded into a burst", () => {
  it.each(KINDS)("%s: three in a minute are three rows", (kind) => {
    const events = [act(kind, 0), act(kind, 15), act(kind, 30)];
    expect(buildTimeline(readableEvents(events)).map((r) => r.kind)).toEqual(["event", "event", "event"]);
    expect(burstOutcomes(events)).toEqual(events.map((e) => e.headline));
  });

  it("a mix of the club's acts in a minute: each its own row", () => {
    const events = KINDS.slice(0, 4).map((k, i) => act(k, i * 10));
    expect(buildTimeline(readableEvents(events)).map((r) => r.kind)).toEqual(["event", "event", "event", "event"]);
  });
});
