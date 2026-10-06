import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { UnsureOutcome } from "@/lib/bookingOutcome";
import { INVITE_UNSURE, INVITES_COPY, PLAYERS_UNSURE, playersRefusal } from "@/lib/playersCopy";
import { inviteRefusal } from "../invites/inviteFacts";
import { linkUnsure } from "../detail/shareLink";

/**
 * R17 X17-1 / L17-5 (FE17s's ask) — a `503 conflict_retry` is someone else changing the same thing
 * at the same moment: re-read, then said as that clash, "try again now" — never "the club didn't
 * answer" and never "in a moment".
 */

const clash = () => new ApiError(503, { error: "conflict_retry" });
const lost = () => new ApiError(502, { error: "bad_gateway" });

describe("conflict_retry on the players surfaces (R17 X17-1)", () => {
  it("the refusal itself: present tense, 'try again now'", () => {
    expect(playersRefusal(clash())).toBe("Someone else was changing this booking at the same moment. The page has the latest — try again now.");
  });

  it("invite accept: the conflict pair, checked and unchecked", () => {
    expect(inviteRefusal(new UnsureOutcome(clash(), true))).toBe(INVITE_UNSURE.conflict.checked);
    expect(inviteRefusal(new UnsureOutcome(clash(), false))).toBe(INVITE_UNSURE.conflict.unchecked);
    expect(INVITE_UNSURE.conflict.checked).toMatch(/^Someone else was changing this game at the same moment.*Try again now\.$/);
    // A lost reply keeps its own words.
    expect(inviteRefusal(new UnsureOutcome(lost(), true))).toBe(INVITE_UNSURE.checked);
  });

  it("invite decline: its conflict pair, from unsureWords", () => {
    const said = inviteRefusal(new UnsureOutcome(clash(), true), INVITES_COPY.declineAction);
    expect(said).toBe(PLAYERS_UNSURE.decline.conflict?.checked);
    expect(said).not.toMatch(/didn't answer/);
  });

  it("a new share link: the clash leads, never 'the club didn't answer'", () => {
    expect(linkUnsure(new UnsureOutcome(clash(), false))).toMatch(/^Someone else was changing this booking at the same moment, so we can't tell/);
    expect(linkUnsure(new UnsureOutcome(lost(), false))).toBe(PLAYERS_UNSURE.link);
  });
});
