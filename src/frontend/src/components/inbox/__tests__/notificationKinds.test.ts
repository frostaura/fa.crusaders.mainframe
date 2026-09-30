import { describe, expect, it } from "vitest";
import { KIND_ICON, kindWord } from "@/components/inbox/notificationKinds";
import { INBOX_KIND_WORD } from "@/lib/playersCopy";
import { UserPlus } from "@/components/ui/icons";

/** Every players kind the server writes (players-and-splits.md's notice table) has a word and a mark. */
describe("the inbox's players kinds", () => {
  it("knows every players kind by word and mark", () => {
    for (const kind of Object.keys(INBOX_KIND_WORD)) {
      expect(kindWord(kind), kind).toBe(INBOX_KIND_WORD[kind]);
      expect(KIND_ICON[kind], kind).toBeTruthy();
    }
  });

  it("names the club's seat (review round 1, B8) as the club's doing", () => {
    expect(kindWord("players.club_seat")).toBe("Added by the club");
    expect(KIND_ICON["players.club_seat"]).toBe(UserPlus);
  });

  it("falls back to no word for a kind this build does not know", () => {
    expect(kindWord("players.something_new")).toBeNull();
    expect(KIND_ICON["players.something_new"]).toBeUndefined();
  });
});
