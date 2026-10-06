import { describe, expect, it } from "vitest";
import { ApiError, NetworkError } from "./api";
import { UnsureOutcome, unsureCauseOf, unsureReasonOf, unsureSentence, writeOrReadBack } from "./lostReply";
import { ERROR_LEAD, LOST_REPLY, unsureWords } from "./lostReplyCopy";

/**
 * R19 X19-2 — a write the club's system answered with a plain 500 was said as "The club didn't
 * answer, so we checked … Try again in a moment": the club DID answer, with an error that will not
 * pass in a moment. "Didn't answer" is for silence only — no response at all, a timeout, a torn
 * request, or the gateway's own 502 / 503 (no code) / 504 saying the system behind it did not answer.
 */
const WORDS = unsureWords("Ada is still on the game", "Ada was removed");

async function unsureAfter(failure: unknown, readBack: () => Promise<null>): Promise<UnsureOutcome> {
  try {
    await writeOrReadBack(() => Promise.reject(failure), readBack);
  } catch (error) {
    if (error instanceof UnsureOutcome) return error;
    throw error;
  }
  throw new Error("expected an unknown outcome");
}

const READ_OK = () => Promise.resolve(null);
const READ_FAILS = () => Promise.reject(new NetworkError("unreachable"));

describe("R19 X19-2 — a 500 on a write is an error the club answered, not silence", () => {
  it.each([
    ["500", new ApiError(500, { error: "boom" })],
    ["500 without a body", new ApiError(500, null)],
    ["501", new ApiError(501, null)],
  ])("%s, record read: the error lead and the record, never \"didn't answer\"", async (_n, failure) => {
    const said = unsureSentence(await unsureAfter(failure, READ_OK), WORDS)!;
    expect(said.startsWith(`${ERROR_LEAD}, so we checked: Ada is still on the game — nothing changed.`)).toBe(true);
    expect(said).not.toMatch(/didn't answer/);
    expect(said).not.toMatch(/in a moment/);
  });

  it("500, record unreadable too: the error lead, and that we can't tell", async () => {
    const said = unsureSentence(await unsureAfter(new ApiError(500, null), READ_FAILS), WORDS)!;
    expect(said).toBe(LOST_REPLY.errorUnchecked("Ada was removed"));
    expect(said).not.toMatch(/didn't answer/);
  });

  it.each([
    ["no response at all", new NetworkError("unreachable")],
    ["a timeout", new NetworkError("timeout")],
    ["a torn request", new DOMException("aborted", "AbortError")],
    ["502 from the gateway", new ApiError(502, null)],
    ["504 from the gateway", new ApiError(504, null)],
    ["503 with no code of the club's own (down or restarting)", new ApiError(503, {})],
  ])("%s is still silence: \"didn't answer\"", async (_n, failure) => {
    const error = await unsureAfter(failure, READ_OK);
    expect(unsureReasonOf(error)).toBe("silent");
    expect(unsureSentence(error, WORDS)).toBe(LOST_REPLY.checked("Ada is still on the game"));
  });

  it("the passing 503s keep their own words", async () => {
    expect(unsureReasonOf(await unsureAfter(new ApiError(503, { error: "service_busy" }), READ_OK))).toBe("busy");
    expect(unsureReasonOf(await unsureAfter(new ApiError(503, { error: "conflict_retry" }), READ_OK))).toBe("conflict");
  });

  it("a hand-written pair with no error twin gets the generic error pair, never its silence sentence", async () => {
    const pair = { checked: "The club didn't answer — still there.", unchecked: "The club didn't answer — can't tell." };
    expect(unsureSentence(await unsureAfter(new ApiError(500, null), READ_OK), pair)).toBe(LOST_REPLY.errorGeneric.checked);
    expect(unsureSentence(await unsureAfter(new ApiError(500, null), READ_FAILS), pair)).toBe(LOST_REPLY.errorGeneric.unchecked);
  });

  it("the three-way cause the players hooks still index by is unchanged until they carry error words", async () => {
    expect(unsureCauseOf(await unsureAfter(new ApiError(500, null), READ_OK))).toBe("silent");
  });
});
