import { describe, expect, it } from "vitest";
import { splitEffects } from "@/components/players/detail/splitEditor";
import { CHANGE_SPLIT } from "@/lib/playersCopy";
import { ALEX_SEAT, SAM_SEAT, detail, seat } from "./detailKit";

/**
 * R17 J17-3 — what saving a split does, seat by seat, read off the seat's own facts: a share the
 * club recorded as paid by hand moves nothing in the app whatever the new figure, and "more" is
 * measured from what the seat actually paid — a seat that paid nothing is asked for the share.
 */

const share = (seat: number, share_minutes: number) => ({ seat, team: seat <= 2 ? "A" : "B", share_minutes, weight: 1 }) as const;

/** Sam paid 25 in the app, then the club recorded it paid by hand: the 25 came back, paid is 0. */
const SAM_SETTLED = { ...SAM_SEAT, settled_outside: true, paid_minutes: 0, target_minutes: 0, unpaid_minutes: 0, returned_minutes: 25 };

describe("split effects for a seat paid by hand (R17 J17-3)", () => {
  it("one partner, paid by hand, share raised: nothing moves for them — never 'asked for more'", () => {
    const d = detail({ players: [seat(), SAM_SETTLED] });
    const lines = splitEffects(d, [share(1, 63), share(2, 37)]);
    expect(lines).toContain(CHANGE_SPLIT.settledByHand("Sam"));
    expect(lines.join(" ")).not.toMatch(/asked for/);
  });

  it("one partner, paid by hand, share lowered: nothing goes back in the app", () => {
    const d = detail({ players: [seat(), SAM_SETTLED] });
    const lines = splitEffects(d, [share(1, 80), share(2, 20)]);
    expect(lines).toContain(CHANGE_SPLIT.settledByHand("Sam"));
    expect(lines.join(" ")).not.toMatch(/goes back|go back/);
  });

  it("paid by hand and unchanged: says nothing about them", () => {
    const d = detail({ players: [seat(), SAM_SETTLED] });
    expect(splitEffects(d, [share(1, 75), share(2, 25)])).toEqual([CHANGE_SPLIT.noChange]);
  });

  it("two partners — one paid by hand, one paid in the app — each told what is true of them", () => {
    const alex = { ...ALEX_SEAT, status: "accepted" as const, consented_minutes: 25, paid_minutes: 25, target_minutes: 25, unpaid_minutes: 0 };
    const d = detail({ players: [seat(), SAM_SETTLED, alex] });
    const lines = splitEffects(d, [share(1, 26), share(2, 37), share(3, 37)]);
    expect(lines).toContain(CHANGE_SPLIT.settledByHand("Sam"));
    expect(lines).toContain(CHANGE_SPLIT.askedMore("Alex", "12 minutes", true));
  });

  it("an accepted seat that has paid nothing yet is asked for the share, not for 'more' than nothing", () => {
    const owing = { ...SAM_SEAT, paid_minutes: 0, unpaid_minutes: 25, consented_minutes: 25 };
    const d = detail({ players: [seat(), owing] });
    const lines = splitEffects(d, [share(1, 63), share(2, 37)]);
    expect(lines).toContain(CHANGE_SPLIT.askedFor("Sam", "37 minutes", true));
    expect(lines.join(" ")).not.toMatch(/more/);
  });
});
