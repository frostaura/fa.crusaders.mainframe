import { describe, it, expect } from "vitest";
import { ApiError } from "./api";
import { CONFLICT_RETRY_CAUSE, describeFailure, isDeploymentFault } from "./errors";
import { CONFLICT_RETRY_TEXT, describeBookingError, worthRetrying } from "./bookingErrors";

/**
 * R16 BE16c — `503 {"error":"conflict_retry"}` (with Retry-After) is the server's answer when
 * PostgreSQL chose the request as a deadlock's victim and the server's own retries ran out. It is
 * neither "the club's system is down" nor a deployment fault: asking again a second later is
 * exactly right, so the sentence says so and the retry affordance stays.
 */
const conflict = () => new ApiError(503, { error: "conflict_retry" });

describe("conflict_retry", () => {
  it("is worded as a clash to try again, with the member's action in front — never 'down or restarting'", () => {
    const message = describeFailure(conflict(), { action: "save your name" });
    expect(message).toBe(`Couldn't save your name — ${CONFLICT_RETRY_CAUSE}`);
    expect(message).not.toMatch(/down or restarting/i);
    expect(message).not.toMatch(/connection/i);
  });

  it("reads as a sentence on its own when no action is given", () => {
    expect(describeFailure(conflict())).toBe(CONFLICT_RETRY_CAUSE.charAt(0).toUpperCase() + CONFLICT_RETRY_CAUSE.slice(1));
  });

  it("lets a screen's own wording win (the players screens' 409 conflict_retry)", () => {
    expect(describeFailure(conflict(), { codes: { conflict_retry: "Screen words." } })).toBe("Screen words.");
  });

  it("is not a deployment fault, so the Try again button stays", () => {
    expect(isDeploymentFault(conflict())).toBe(false);
    expect(isDeploymentFault(new ApiError(503, { error: "unavailable" }))).toBe(true);
  });

  it("has its own booking sentences — not 'the club's system didn't answer' — and is worth retrying", () => {
    expect(describeBookingError(conflict(), "fallback", { action: "book" })).toBe(CONFLICT_RETRY_TEXT.book);
    expect(describeBookingError(conflict(), "fallback", { action: "cancel" })).toBe(CONFLICT_RETRY_TEXT.cancel);
    expect(CONFLICT_RETRY_TEXT.book).not.toMatch(/didn't answer/);
    expect(worthRetrying(conflict())).toBe(true);
  });
});
