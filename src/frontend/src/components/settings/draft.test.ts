import { describe, expect, it } from "vitest";
import { afterCaption } from "./draft";

/**
 * Review round 3, I-7: the blocker list prints the caption as a link and then the message. A
 * message that names the setting in its OWN words still said it twice:
 * "Door unlock time (seconds) — Unlock time has to be a whole number…".
 */
describe("a complaint says the setting's name once (R3 I-7)", () => {
  it("drops the caption when the message opens with it, as before", () => {
    expect(afterCaption("Slice length (minutes)", "Slice length (minutes) has to be a whole number from 5 to 240."))
      .toBe(" has to be a whole number from 5 to 240.");
    expect(afterCaption("Grace window (minutes)", "Grace window has to be from 0 to 60.")).toBe(" has to be from 0 to 60.");
  });

  it("drops the message's own name for the setting when it shares a word with the caption", () => {
    expect(afterCaption("Door unlock time (seconds)", "Unlock time has to be a whole number of seconds between 1 and 30."))
      .toBe(" has to be a whole number of seconds between 1 and 30.");
    expect(afterCaption("Refusal spikes (scans)", "A refusal spike has to be a whole number of scans between 2 and 100."))
      .toBe(" has to be a whole number of scans between 2 and 100.");
  });

  it("keeps a subject that is a different thing from the caption", () => {
    expect(afterCaption("Saturday opening hours", "Closing time has to be after opening time.")).toBeNull();
  });
});
