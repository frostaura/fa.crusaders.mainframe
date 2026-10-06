import { describe, expect, it } from "vitest";
import { movementSentence } from "./movementCopy";
import { shareRowSentence } from "./shareMovementCopy";
import { shareToast } from "@/components/shell/shareMovement";
import type { BalanceDelta } from "./liveBalance";

/**
 * R17 E17-9 / X17-6 — one form for the people in a reversal toast, the scanner's own words, and a
 * share toast that ends like a sentence.
 *
 * <ul>
 *   <li>The organiser's reversal read "Pippa Partner checked in …, 6 minutes came back from Pippa":
 *   the same person in two forms. First names throughout.</li>
 *   <li>The partner who scanned read "… taken again — the session was attended" while their inbox
 *   said "you checked in": the frame names nobody when it was this member, so it is "you checked in".</li>
 *   <li>Share toasts had no full stop.</li>
 * </ul>
 */

const PLACE = { courtName: "Court 4", startsAt: "2026-10-06T23:30:00Z" };
const pen = (n: number) => ({ reason: "penalty", delta_minutes: n });
const refund = (n: number) => ({ reason: "cancellation_refund", delta_minutes: n });
const share = (n: number, name: string) => ({ reason: "share_transfer", delta_minutes: n, counterparty_name: name });

describe("reversal toasts in one form (R17 E17-9)", () => {
  it("the organiser's no-show reversal names the scanner as the share rows do — first name", () => {
    const said = movementSentence(-5, "no_show_reversed", [pen(4), refund(-15), share(6, "Pippa Partner")], { checkedInBy: "Pippa Partner" });
    expect(said).toMatch(/^Pippa checked in, so the no-show was reversed/);
    expect(said).toMatch(/came back from Pippa for their share/);
    expect(said).not.toMatch(/Pippa Partner/);
  });

  it("a placed reversal and a started-session cancel use the first name too", () => {
    expect(movementSentence(-5, "no_show_reversed", [pen(4), refund(-15), share(6, "Pippa Partner")], { checkedInBy: "Pippa Partner", place: PLACE }))
      .toMatch(/^Pippa checked in on Court 4 · /);
    expect(movementSentence(0, "cancelled_no_refund", undefined, { checkedInBy: "Petra Partner", place: PLACE }))
      .toMatch(/ — Petra had already checked in, so nothing was refunded\.$/);
  });

  it("the scanner's own share taken again (`checked_in_by_you`): 'you checked in', as the inbox says", () => {
    expect(shareRowSentence({ side: "partner", signed: -6, place: PLACE, other: "Olga Organiser", cause: "attended", byYou: true, dated: true }))
      .toMatch(/ — you checked in, so the session was attended$/);
    // An older frame (no flag, no name) claims nobody.
    expect(shareRowSentence({ side: "partner", signed: -6, place: PLACE, other: "Olga Organiser", cause: "attended" }))
      .toMatch(/ — the session was attended$/);
    expect(shareRowSentence({ side: "partner", signed: -6, place: PLACE, other: "Olga Organiser", cause: "attended", by: "Pippa Partner" }))
      .toMatch(/ — Pippa checked in, so the session was attended$/);
  });
});

describe("a share toast ends like a sentence (R17 X17-6)", () => {
  it("the chip's share toast has its full stop", async () => {
    const delta: BalanceDelta = { amount: -6, at: 1, source: "club", reason: "share_transfer", shareCause: "attended", place: PLACE, checkedInByYou: true };
    // No ledger to read in a unit test: the plain (frame-only) sentence, which must end in a full stop.
    const said = await shareToast(delta, "me");
    expect(said).toMatch(/\.$/);
    expect(said).toMatch(/you checked in, so the session was attended\.$/);
  });
});
