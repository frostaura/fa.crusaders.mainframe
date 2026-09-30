import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { RATE_LIMITED_TAIL, describeBookingError } from "./bookingErrors";
import { rateLimitedSentence } from "./errors";

/**
 * R4 I4-3 — a 429 on the member's Book or Cancel said the generic "Couldn't make that booking";
 * the club's `retry_after_seconds` was never used. It is refused before it runs, so nothing
 * happened, and the sentence says so with the wait.
 */
describe("describeBookingError — the club's rate limit", () => {
  const limited = (seconds?: number) => new ApiError(429, { error: "rate_limited", ...(seconds ? { retry_after_seconds: seconds } : {}) });

  it("says the wait the club gave, and that nothing was booked", () => {
    expect(describeBookingError(limited(12), "fallback", { action: "book" }))
      .toBe(`${rateLimitedSentence(12)} ${RATE_LIMITED_TAIL.book}`);
    expect(describeBookingError(limited(12), "fallback", { action: "book" })).toContain("wait 12 seconds");
  });

  it("says the booking is still there for a cancel", () => {
    expect(describeBookingError(limited(3), "fallback", { action: "cancel" }))
      .toBe(`${rateLimitedSentence(3)} ${RATE_LIMITED_TAIL.cancel}`);
  });

  it("still words a 429 without a wait", () => {
    expect(describeBookingError(limited(), "fallback")).toBe(`${rateLimitedSentence(null)} ${RATE_LIMITED_TAIL.book}`);
  });
});
