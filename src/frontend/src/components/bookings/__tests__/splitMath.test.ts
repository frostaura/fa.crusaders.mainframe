import { describe, expect, it } from "vitest";
import { confirmPlayersSentence } from "@/lib/playersCopy";
import { partnersTotal, splitShares, type MathSeat } from "../splitMath";
import {
  EMPTY_DRAFT, addPlayer, hasPaying, localSplit, amountProblem, parseAmount, parseWeight, playersPayload, previewBody,
  removeSeat, sentenceSeats, updateSeat, withMode, type PlayersDraft,
} from "../playersDraft";
import type { SplitMode } from "@/lib/playersApi";

/**
 * The phone's mirror of the backend's `SplitCalculator` (D11 §2), the Confirm sentence and the
 * request bodies. The server's preview stays the displayed truth; these pin that the mirror
 * agrees with it — the table cases are the spec's, the property run is the backend's own
 * "sums to P exactly, always" held over thousands of generated splits.
 */

const SAM = { kind: "member", userId: "sam", name: "Sam Petersen", photoUrl: null } as const;
const ALEX = { kind: "member", userId: "alex", name: "Alex Naidoo", photoUrl: null } as const;
const JO = { kind: "guest", name: "Jo" } as const;
const LINK = { kind: "link" } as const;

const cents = (n: number) => Math.round(n * 100);

describe("splitShares — the spec's table", () => {
  it("equal: partners floor to whole credits, the organiser takes the odd credit", () => {
    const r = splitShares(100, "equal", 1, [{ seat: 2, isGuest: false }, { seat: 3, isGuest: false }]);
    expect(r).toEqual({ ok: true, shares: [{ seat: 1, share: 34, weight: 1 }, { seat: 2, share: 33, weight: 1 }, { seat: 3, share: 33, weight: 1 }] });
  });

  it("equal: a fractional price leaves the fraction with the organiser", () => {
    const r = splitShares(50.5, "equal", 1, [{ seat: 2, isGuest: false }]);
    expect(r.ok && r.shares.map((s) => s.share)).toEqual([25.5, 25]);
  });

  it("guests carry 0 and are not a head", () => {
    const r = splitShares(100, "equal", 1, [{ seat: 2, isGuest: false }, { seat: 3, isGuest: true }]);
    expect(r.ok && r.shares.map((s) => [s.seat, s.share])).toEqual([[1, 50], [2, 50], [3, 0]]);
  });

  it("ratio: ⌊P × w / Σw⌋, the organiser's weight counted", () => {
    const r = splitShares(100, "ratio", 2, [{ seat: 2, isGuest: false, weight: 1 }, { seat: 4, isGuest: false, weight: 1 }]);
    expect(r.ok && r.shares.map((s) => s.share)).toEqual([50, 25, 25]);
  });

  it("ratio: weights outside 0–100 or all zero are refused", () => {
    expect(splitShares(100, "ratio", 101, [{ seat: 2, isGuest: false, weight: 1 }])).toEqual({ ok: false, error: "split_weight_invalid" });
    expect(splitShares(100, "ratio", 0, [{ seat: 2, isGuest: false, weight: 0 }])).toEqual({ ok: false, error: "split_weight_invalid" });
    expect(splitShares(100, "ratio", 1, [{ seat: 2, isGuest: false, weight: 1.5 }])).toEqual({ ok: false, error: "split_weight_invalid" });
  });

  it("amount: the figures as given, the organiser the rest; more than the price is refused", () => {
    const r = splitShares(100, "amount", 0, [{ seat: 2, isGuest: false, amount: 30.25 }, { seat: 3, isGuest: false, amount: 20 }]);
    expect(r.ok && r.shares.map((s) => s.share)).toEqual([49.75, 30.25, 20]);
    expect(splitShares(100, "amount", 0, [{ seat: 2, isGuest: false, amount: 60 }, { seat: 3, isGuest: false, amount: 40.01 }]))
      .toEqual({ ok: false, error: "split_exceeds_price" });
    expect(splitShares(100, "amount", 0, [{ seat: 2, isGuest: false, amount: 1.234 }])).toEqual({ ok: false, error: "split_amount_invalid" });
    expect(splitShares(100, "amount", 0, [{ seat: 2, isGuest: false, amount: -1 }])).toEqual({ ok: false, error: "split_amount_invalid" });
  });

  it("amount: exactly the price is allowed — the organiser pays nothing back to themselves", () => {
    const r = splitShares(100, "amount", 0, [{ seat: 2, isGuest: false, amount: 100 }]);
    expect(r.ok && r.shares[0].share).toBe(0);
  });
});

/** A small deterministic generator, so a failure names its seed. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("splitShares — sums to the price exactly, always (5 000 generated splits)", () => {
  it("holds the backend's invariants over random prices, modes and seats", () => {
    const next = rng(20260928);
    const modes: SplitMode[] = ["equal", "ratio", "amount"];
    for (let i = 0; i < 5000; i++) {
      const price = Math.round(next() * 50000) / 100; // 0.00 – 500.00, two places
      const mode = modes[Math.floor(next() * 3)];
      const count = 1 + Math.floor(next() * 3);
      const partners: MathSeat[] = Array.from({ length: count }, (_, k) => ({
        seat: k + 2,
        isGuest: next() < 0.25,
        weight: Math.floor(next() * 101),
        amount: Math.round(next() * (price / count) * 100) / 100,
      }));
      const organiserWeight = 1 + Math.floor(next() * 100);
      const r = splitShares(price, mode, organiserWeight, partners);
      if (!r.ok) {
        // The only refusals a generated case may earn, each only when it is TRUE: every weight
        // zero (ratio), or amounts that — rounded to cents — pass the price (amount).
        const asked = partners.filter((p) => !p.isGuest).reduce((n, p) => n + cents(p.amount ?? 0), 0);
        if (r.error === "split_exceeds_price") expect(asked, `case ${i}`).toBeGreaterThan(cents(price));
        else expect(r.error, `case ${i}`).toBe("split_weight_invalid");
        continue;
      }
      const sum = r.shares.reduce((n, s) => n + cents(s.share), 0);
      expect(sum, `case ${i}: ${JSON.stringify({ price, mode, partners })}`).toBe(cents(price));
      expect(r.shares[0].seat).toBe(1);
      expect(r.shares[0].share).toBeGreaterThanOrEqual(0);
      for (const s of r.shares.slice(1)) {
        const seat = partners.find((p) => p.seat === s.seat)!;
        if (seat.isGuest) expect(s.share).toBe(0);
        else if (mode !== "amount") expect(Number.isInteger(s.share), `case ${i}`).toBe(true);
        else expect(s.share).toBe(seat.amount);
      }
    }
  });
});

describe("the draft → request bodies", () => {
  const draft = (): PlayersDraft => addPlayer(addPlayer(addPlayer(EMPTY_DRAFT, SAM, 2), LINK, 3), JO, 4);

  it("seats fill an opponent first (3), then the partner (2), then 4 — unless a seat is asked for", () => {
    // Review round 1, F1.9: singles' one other player is the opponent, never the member's teammate.
    const filled = addPlayer(addPlayer(addPlayer(EMPTY_DRAFT, SAM), LINK), JO);
    expect(filled.seats.map((s) => [s.seat, s.player.kind])).toEqual([[2, "link"], [3, "member"], [4, "guest"]]);
    const d = draft();
    expect(d.seats.map((s) => [s.seat, s.player.kind])).toEqual([[2, "member"], [3, "link"], [4, "guest"]]);
    expect(addPlayer(d, ALEX)).toBe(d);
    expect(removeSeat(d, 3).seats.map((s) => s.seat)).toEqual([2, 4]);
    expect(addPlayer(removeSeat(d, 3), ALEX, 3).seats.map((s) => s.seat)).toEqual([2, 3, 4]);
  });

  it("just me sends no players at all — the old request, byte for byte", () => {
    expect(playersPayload(EMPTY_DRAFT)).toBeNull();
  });

  it("an equal split sends each seat by kind, with its seat and the mode", () => {
    expect(playersPayload(draft())).toEqual({
      players: [{ userId: "sam", seat: 2 }, { link: true, seat: 3 }, { guestName: "Jo", seat: 4 }],
      splitMode: "equal",
    });
  });

  it("a ratio split sends weights and the organiser's weight; guests never carry one", () => {
    let d = withMode(draft(), "ratio", 100);
    d = updateSeat(d, 2, { weight: "3" });
    d = { ...d, organiserWeight: "2" };
    expect(playersPayload(d)).toEqual({
      players: [{ userId: "sam", seat: 2, weight: 3 }, { link: true, seat: 3, weight: 1 }, { guestName: "Jo", seat: 4 }],
      splitMode: "ratio",
      organiserWeight: 2,
    });
  });

  it("switching to Amount starts from the equal split, and sends amounts", () => {
    const d = withMode(draft(), "amount", 100);
    expect(d.seats.map((s) => s.amount)).toEqual(["33.00", "33.00", ""]);
    expect(playersPayload(d)?.players).toEqual([
      { userId: "sam", seat: 2, amount: 33 }, { link: true, seat: 3, amount: 33 }, { guestName: "Jo", seat: 4 },
    ]);
    expect(previewBody(100, d)).toEqual({ priceCredits: 100, splitMode: "amount", players: playersPayload(d)?.players });
  });

  it("guests alone are nothing to split: the mode goes as equal", () => {
    const d = { ...addPlayer(EMPTY_DRAFT, JO), mode: "amount" as const };
    expect(hasPaying(d)).toBe(false);
    expect(playersPayload(d)).toEqual({ players: [{ guestName: "Jo", seat: 3 }], splitMode: "equal" });
  });

  it("parses a figure as typed, and refuses what the server would", () => {
    expect(parseWeight("25")).toBe(25);
    expect(parseWeight("")).toBeNull();
    expect(parseWeight("101")).toBeNull();
    expect(parseWeight("2.5")).toBeNull();
    expect(parseAmount("")).toBe(0);
    expect(parseAmount("12,5")).toBe(12.5);
    expect(parseAmount("12.345")).toBeNull();
    expect(parseAmount("-1")).toBeNull();
  });

  it("reads a share through the product's one amount parser (lib/amount)", () => {
    expect(parseAmount("12,50")).toBe(12.5);
    expect(parseAmount("1e2")).toBeNull();
    expect(parseAmount("1,000")).toBeNull();
    expect(amountProblem("1,000")).toEqual({ kind: "ambiguous" });
    expect(amountProblem("1e2")).toEqual({ kind: "not_a_number" });
    expect(amountProblem("")).toBeNull();
    expect(amountProblem("0")).toBeNull();
  });

  it("the local split says split_exceeds_price the moment the amounts pass the court", () => {
    let d = withMode(addPlayer(addPlayer(EMPTY_DRAFT, SAM, 2), ALEX, 3), "amount", 100);
    d = updateSeat(d, 2, { amount: "60" });
    d = updateSeat(d, 3, { amount: "41" });
    expect(localSplit(100, d)).toEqual({ ok: false, error: "split_exceeds_price" });
  });

  it("partnersTotal is what comes back as they accept", () => {
    expect(partnersTotal([{ seat: 1, share_credits: 25.5 }, { seat: 2, share_credits: 25 }, { seat: 3, share_credits: 0.1 }])).toBe(25.1);
  });
});

describe("the Confirm sentence", () => {
  const shares = (...pairs: [number, number][]) => pairs.map(([seat, share_credits]) => ({ seat, share_credits }));

  it("names members by first name, groups an equal ask, and lets a guest play free", () => {
    const d = addPlayer(addPlayer(addPlayer(EMPTY_DRAFT, SAM, 2), ALEX, 3), JO, 4);
    expect(confirmPlayersSentence(100, sentenceSeats(d, shares([1, 50], [2, 25], [3, 25], [4, 0]))))
      .toBe("You pay 100.00 cr now; Sam and Alex are asked for 25.00 cr each. Jo (guest) plays free.");
  });

  it("says who takes an open seat, and a single partner in the singular", () => {
    const d = addPlayer(EMPTY_DRAFT, LINK, 2);
    expect(confirmPlayersSentence(100, sentenceSeats(d, shares([1, 50], [2, 50]))))
      .toBe("You pay 100.00 cr now; whoever takes your link is asked for 50.00 cr.");
    const two = addPlayer(addPlayer(addPlayer(EMPTY_DRAFT, SAM, 2), LINK, 3), LINK, 4);
    expect(confirmPlayersSentence(100, sentenceSeats(two, shares([1, 34], [2, 33], [3, 33], [4, 33]))))
      .toBe("You pay 100.00 cr now; Sam and the 2 people who take your links are asked for 33.00 cr each.");
  });

  it("lists different asks one by one, and says 'each booking' for a batch", () => {
    const d = addPlayer(addPlayer(EMPTY_DRAFT, SAM, 2), LINK, 3);
    expect(confirmPlayersSentence(100, sentenceSeats(d, shares([1, 50], [2, 30], [3, 20])), true))
      .toBe("On each booking you pay 100.00 cr now; Sam is asked for 30.00 cr and whoever takes your link for 20.00 cr.");
  });

  it("guests only: you pay, they play free", () => {
    const d = addPlayer(addPlayer(EMPTY_DRAFT, JO, 2), { kind: "guest", name: "Lee" }, 3);
    expect(confirmPlayersSentence(50, sentenceSeats(d, []))).toBe("You pay 50.00 cr now. Jo (guest) and Lee (guest) play free.");
  });
});
