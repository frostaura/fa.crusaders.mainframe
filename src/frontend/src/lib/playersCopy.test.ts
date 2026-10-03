import { describe, expect, it } from "vitest";
import { BOOK_CONFIRM, DETAIL_ACTIONS, DETAIL_ADMIN } from "./playersCopy";

const ABBREVIATED = /\d[\s\u00a0]?(h|min|d)\b/;

describe("R7 J7-7 — the Confirm step's players line is a list, with its 'and'", () => {
  it("names you and one other with 'and'", () => {
    expect(BOOK_CONFIRM.playersLine(["Pam"])).toBe("You and Pam");
  });

  it("names you and several, the last with 'and'", () => {
    expect(BOOK_CONFIRM.playersLine(["Sam", "Alex"])).toBe("You, Sam and Alex");
    expect(BOOK_CONFIRM.playersLine(["Sam", BOOK_CONFIRM.linkInLine])).toBe("You, Sam and an open seat");
  });

  it("is just you when nobody else is on it", () => {
    expect(BOOK_CONFIRM.playersLine([])).toBe("You");
  });
});

describe("R7 J7-9 — removing a partner says what goes back, and what it costs the organiser", () => {
  it("the organiser's confirm names the refund and their own cost rising", () => {
    const body = DETAIL_ACTIONS.removeBodyFor("Sam", { paid: 30, share: 30 });
    expect(body).toBe(
      "Sam comes off this game and the 30 minutes they paid goes back to them from your balance. Your cost for the court goes up by 30 minutes.",
    );
    expect(body).not.toMatch(ABBREVIATED);
  });

  it("says nothing goes back when nothing was paid, and still names the cost", () => {
    expect(DETAIL_ACTIONS.removeBodyFor("Sam", { paid: 0, share: 45 })).toBe(
      "Sam comes off this game. They haven't paid anything, so nothing goes back. Your cost for the court goes up by 45 minutes.",
    );
  });

  it("keeps the plain sentence for a seat with no share", () => {
    expect(DETAIL_ACTIONS.removeBodyFor("Jo", { paid: 0, share: 0 })).toBe("Jo comes off this game. Nothing was paid and your cost does not change.");
  });

  it("the club's confirm names the refund and the organiser's cost, by name", () => {
    const body = DETAIL_ADMIN.removeBodyFor({ paid: 30, share: 30, organiser: "Naledi" });
    expect(body).toBe(
      "They come off the game and the 30 minutes they paid goes back to them from Naledi's balance. Naledi's cost for the court goes up by 30 minutes.",
    );
    expect(DETAIL_ADMIN.removeBodyFor({ paid: 0, share: 30, organiser: "Naledi" })).toBe(
      "They come off the game. They haven't paid anything, so nothing goes back. Naledi's cost for the court goes up by 30 minutes.",
    );
    expect(body).not.toMatch(ABBREVIATED);
  });
});
