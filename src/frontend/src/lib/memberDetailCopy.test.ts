import { describe, expect, it } from "vitest";
import { accountStatusWord } from "./memberDetailCopy";

describe("R7 L7-16 — the account's status is a word, never the raw code", () => {
  it("says the two states the server sends", () => {
    expect(accountStatusWord("active")).toBe("Active");
    expect(accountStatusWord("suspended")).toBe("Suspended");
  });

  it("never shows an unknown code as an underscored token", () => {
    expect(accountStatusWord("pending_review")).toBe("Pending review");
  });
});
