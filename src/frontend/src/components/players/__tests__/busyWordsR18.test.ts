import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { UnsureOutcome } from "@/lib/bookingOutcome";
import { unsureSentence } from "@/lib/lostReply";
import { INVITE_UNSURE, PLAYERS_UNSURE, playersRefusal } from "@/lib/playersCopy";
import { inviteRefusal } from "../invites/inviteFacts";
import { linkUnsure } from "../detail/shareLink";

/**
 * R18 (BE18s `service_busy`, integrator's ask) — `503 { error: "service_busy" }`: every database
 * connection in use, the request turned away before anything was done. The club DID answer, and it
 * is busy for a moment — never "the club didn't answer", never "down or restarting".
 */

const busy = () => new ApiError(503, { error: "service_busy" });
const lost = () => new ApiError(502, { error: "bad_gateway" });
const NOT = /didn't answer|down or restarting/;

describe("service_busy on the players surfaces (R18)", () => {
  it("the refusal itself: busy, try again in a moment", () => {
    const said = playersRefusal(busy(), { action: "remind Sam" });
    expect(said).toMatch(/too busy|very busy/);
    expect(said).not.toMatch(NOT);
  });

  it("every unsureWords pair (remove, add, split, withdraw, decline, admin): checked and unchecked say busy", () => {
    const pairs = [PLAYERS_UNSURE.remove("Sam"), PLAYERS_UNSURE.add("Sam"), PLAYERS_UNSURE.split, PLAYERS_UNSURE.withdraw,
      PLAYERS_UNSURE.decline, PLAYERS_UNSURE.admin("Sam"), PLAYERS_UNSURE.adminAdd];
    for (const words of pairs) {
      for (const checked of [true, false]) {
        const said = unsureSentence(new UnsureOutcome(busy(), checked), words) ?? "";
        expect(said).toMatch(/^The club's system was too busy to take this just now/);
        expect(said).not.toMatch(NOT);
      }
    }
    // A lost reply keeps its own words.
    expect(unsureSentence(new UnsureOutcome(lost(), true), PLAYERS_UNSURE.split)).toBe(PLAYERS_UNSURE.split.checked);
  });

  it("invite accept: its own busy pair", () => {
    expect(inviteRefusal(new UnsureOutcome(busy(), true))).toBe(INVITE_UNSURE.busy.checked);
    expect(inviteRefusal(new UnsureOutcome(busy(), false))).toBe(INVITE_UNSURE.busy.unchecked);
    expect(INVITE_UNSURE.busy.checked).not.toMatch(NOT);
  });

  it("a new share link, the reminder, the star and the privacy switch have busy words", () => {
    expect(linkUnsure(new UnsureOutcome(busy(), false))).toBe(PLAYERS_UNSURE.linkBusy);
    for (const said of [PLAYERS_UNSURE.linkBusy, PLAYERS_UNSURE.nudgeBusy("Sam"), PLAYERS_UNSURE.starBusy("Sam"), PLAYERS_UNSURE.privacyBusy("Findable")]) {
      expect(said).toMatch(/too busy/);
      expect(said).not.toMatch(NOT);
    }
  });
});
