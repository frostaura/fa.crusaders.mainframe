import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { INVITE_REFUSAL, INVITES_COPY } from "@/lib/playersCopy";
import { notRecordableLine, playRefusal } from "@/lib/playCopy";
import { inviteRefusal } from "../invites/inviteFacts";

/**
 * R18 BE18a's contract (scratchpad ask) — two answers the member screens must word.
 * J18-5: an accept on a cancelled game is `409 booking_not_open` (it was `invite_closed`).
 * J18-1: a result on a cancelled game is `not_recordable_reason: "cancelled"` / `409 result_not_recordable`.
 */

describe("accept on a cancelled game (R18 J18-5)", () => {
  it("the accept sheet and the invite pages say the game was cancelled and nothing was taken", () => {
    const said = inviteRefusal(new ApiError(409, { error: "booking_not_open", booking_id: "b1" }));
    expect(said).toBe(INVITE_REFUSAL.booking_not_open);
    expect(said).toMatch(/cancelled/);
    expect(said).toMatch(/nothing was taken/);
  });

  it("a decline on it says the game is cancelled — no answer is needed", () => {
    const said = inviteRefusal(new ApiError(409, { error: "booking_not_open" }), INVITES_COPY.declineAction);
    expect(said).toMatch(/cancelled/);
  });
});

describe("a result on a cancelled game (R18 J18-1)", () => {
  it("the card's line and the refusal both say why", () => {
    expect(notRecordableLine("cancelled")).toMatch(/cancelled/);
    expect(playRefusal(new ApiError(409, { error: "result_not_recordable", reason: "cancelled" }))).toBe(notRecordableLine("cancelled"));
  });
});
