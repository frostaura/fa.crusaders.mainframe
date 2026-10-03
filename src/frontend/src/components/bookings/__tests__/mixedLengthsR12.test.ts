import { describe, expect, it } from "vitest";
import { BOOK_SPLIT, confirmPlayersSentence } from "@/lib/playersCopy";
import { addPlayer, EMPTY_DRAFT } from "../playersDraft";
import { confirmLines } from "../usePlayersStep";
import type { SplitPreview } from "@/lib/playersApi";

/**
 * R12 J12-2 — a multi-slot booking of mixed lengths (a 30 and a 15) with a partner: the Split
 * headings read "Each 15 minutes booking", and Confirm said "On each booking you pay 15 minutes
 * now…" then "On each booking you pay 30 minutes now…" — two sentences that contradict. Each
 * sentence now names the length it is about, and a heading is an adjective ("15-minute").
 */
const SAM = { kind: "member", userId: "sam", name: "Sam Petersen", photoUrl: null } as const;

const preview = (price: number, mine: number, sams: number): SplitPreview =>
  ({ price_minutes: price, shares: [{ seat: 1, share_minutes: mine }, { seat: 2, share_minutes: sams }] }) as unknown as SplitPreview;

describe("R12 J12-2 — mixed lengths", () => {
  it("the Split heading is an adjective", () => {
    expect(BOOK_SPLIT.perPrice(15)).toBe("Each 15-minute booking");
    expect(BOOK_SPLIT.perPrice(60)).toBe("Each 1-hour booking");
    expect(BOOK_SPLIT.perPrice(90)).toBe("Each booking of 1 hour 30 minutes");
  });

  it("one sentence per length, each naming its length — never two 'on each booking' figures", () => {
    const draft = addPlayer(EMPTY_DRAFT, SAM, 2);
    const lines = confirmLines(draft, [30, 15], { status: "ready", previews: [preview(15, 8, 7), preview(30, 15, 15)] }, true)!;
    expect(lines.map((l) => l.sentence)).toEqual([
      "On the 15-minute booking you pay 15 minutes now; Sam is asked for 7 minutes.",
      "On the 30-minute booking you pay 30 minutes now; Sam is asked for 15 minutes.",
    ]);
  });

  it("two bookings of one length among others are counted", () => {
    const draft = addPlayer(EMPTY_DRAFT, SAM, 2);
    const lines = confirmLines(draft, [15, 30, 15], { status: "ready", previews: [preview(15, 8, 7), preview(30, 15, 15)] }, true)!;
    expect(lines[0].sentence).toBe("On each of the 2 15-minute bookings you pay 15 minutes now; Sam is asked for 7 minutes.");
  });

  it("one length in a batch still says 'On each booking'", () => {
    const draft = addPlayer(EMPTY_DRAFT, SAM, 2);
    const lines = confirmLines(draft, [30, 30], { status: "ready", previews: [preview(30, 15, 15)] }, true)!;
    expect(lines[0].sentence).toBe("On each booking you pay 30 minutes now; Sam is asked for 15 minutes.");
    expect(confirmPlayersSentence(30, [{ kind: "member", name: "Sam", share: 15 }])).toBe("You pay 30 minutes now; Sam is asked for 15 minutes.");
  });
});
