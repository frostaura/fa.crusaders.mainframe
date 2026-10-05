import { describe, expect, it } from "vitest";
import { shareMovementPlain, shareRowSentence } from "@/lib/shareMovementCopy";

/**
 * R16 J16-2 — a share that moved because a player was ADDED (an equal split went down) was said
 * as "Share refunded … came back from Mia", recorded by nobody. BE16b now sends
 * `share_cause: "player_added"` with `actor_name` the organiser who added (null: the club did —
 * on a member's own wallet an admin may also read "The club").
 */

const COURT = { courtName: "Court 1", startsAt: "2026-10-08T06:00:00Z" };
const AT = "Court 1 · Thu 8 Oct";

describe("R16 J16-2 — a player added, so the split went down", () => {
  it("the partner, the organiser added: names them", () => {
    expect(shareMovementPlain(5, "player_added", undefined, undefined, { place: COURT, actor: "Owen Organiser", other: "Owen Organiser" }))
      .toBe(`5 minutes of your share of ${AT} came back — Owen added a player, so the split went down.`);
  });

  it("the partner, the club added (no actor, or 'The club')", () => {
    const said = `5 minutes of your share of ${AT} came back — the club added a player, so the split went down.`;
    expect(shareMovementPlain(5, "player_added", undefined, undefined, { place: COURT, actor: undefined, other: "Owen Organiser" })).toBe(said);
    expect(shareMovementPlain(5, "player_added", undefined, undefined, { place: COURT, actor: "The club", other: "Owen Organiser" })).toBe(said);
  });

  it("the organiser who added: their own act, to whom the minutes went", () => {
    expect(shareMovementPlain(-5, "player_added", undefined, undefined, { place: COURT, actor: "Owen Organiser", others: ["Mia Partner"] }))
      .toBe(`You added a player to ${AT}, so the split went down — 5 minutes went back to Mia.`);
  });

  it("the organiser, the club added: the club's act; two partners named", () => {
    expect(shareMovementPlain(-10, "player_added", undefined, undefined, { place: COURT, actor: "The club", others: ["Mia Partner", "Sid Second"] }))
      .toBe(`The club added a player to ${AT}, so the split went down — 10 minutes went back to Mia and Sid.`);
  });

  it("the organiser, nobody named on the frame: says what happened, not who", () => {
    expect(shareMovementPlain(-5, "player_added", undefined, undefined, { place: COURT, others: ["Mia Partner"] }))
      .toBe(`A player was added to ${AT}, so the split went down — 5 minutes went back to Mia.`);
  });

  it("the wallet's ledger line says the same", () => {
    expect(shareRowSentence({ side: "partner", signed: 5, place: COURT, other: "Owen Organiser", actor: "Owen Organiser", cause: "player_added", dated: true }))
      .toBe(`5 minutes of your share of ${AT} came back — Owen added a player, so the split went down`);
  });
});
