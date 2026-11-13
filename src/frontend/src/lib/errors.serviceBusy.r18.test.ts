import { describe, it, expect } from "vitest";
import { ApiError } from "./api";
import { UnsureOutcome } from "./bookingOutcome";
import { SERVICE_BUSY_CAUSE, describeFailure, isConfigurationFault } from "./errors";
import {
  SERVICE_BUSY_BOOK_TEXT, SERVICE_BUSY_UNSURE_TEXT, describeBookingError, worthRetrying,
} from "./bookingErrors";

/**
 * R18 BE18s — `503 {"error":"service_busy"}` (Retry-After: 2): every database connection the API
 * may hold is in use. Not down, not restarting and not a deployment fault: the club is busy for a
 * moment, so the sentence says so ("try again in a moment"), never "down or restarting… give it a
 * minute", and the Try again affordance stays.
 */
const busy = () => new ApiError(503, { error: "service_busy" });

describe("service_busy", () => {
  it("is worded as busy for a moment, with the member's action in front — never 'down or restarting'", () => {
    const message = describeFailure(busy(), { action: "load your wallet" });
    expect(message).toBe(`Couldn't load your wallet — ${SERVICE_BUSY_CAUSE}`);
    expect(message).toMatch(/busy/);
    expect(message).toMatch(/in a moment/);
    expect(message).not.toMatch(/down or restarting|give it a minute|connection|committee/i);
  });

  it("reads as a sentence on its own when no action is given", () => {
    expect(describeFailure(busy())).toBe(SERVICE_BUSY_CAUSE.charAt(0).toUpperCase() + SERVICE_BUSY_CAUSE.slice(1));
  });

  it("is not a configuration fault, so the Try again button stays", () => {
    expect(isConfigurationFault(busy())).toBe(false);
    expect(isConfigurationFault(new ApiError(503, {}))).toBe(false);
  });

  it("a plain 503 keeps its own words", () => {
    expect(describeFailure(new ApiError(503, {}))).toMatch(/down or restarting/);
  });

  it("the booking sheets: busy, not 'didn't answer' — one slot, several, and a cancel", () => {
    expect(describeBookingError(busy(), "f", { action: "book" })).toBe(SERVICE_BUSY_BOOK_TEXT.book);
    expect(describeBookingError(busy(), "f", { action: "book", slots: 2 })).toBe(SERVICE_BUSY_BOOK_TEXT.bookMany);
    expect(describeBookingError(busy(), "f", { action: "cancel" })).toBe(SERVICE_BUSY_BOOK_TEXT.cancel);
    for (const s of Object.values(SERVICE_BUSY_BOOK_TEXT)) expect(s).not.toMatch(/didn't answer|down or restarting/);
    expect(worthRetrying(busy())).toBe(true);
  });

  it("the booking sheets after the read-back: busy, then what the schedule showed", () => {
    const checked = new UnsureOutcome(busy(), true);
    const unchecked = new UnsureOutcome(busy(), false);
    expect(describeBookingError(checked, "f", { action: "book" })).toBe(SERVICE_BUSY_UNSURE_TEXT.book.checked);
    expect(describeBookingError(checked, "f", { action: "book", slots: 3 })).toBe(SERVICE_BUSY_UNSURE_TEXT.bookMany.checked);
    expect(describeBookingError(unchecked, "f", { action: "cancel" })).toBe(SERVICE_BUSY_UNSURE_TEXT.cancel.unchecked);
    expect(SERVICE_BUSY_UNSURE_TEXT.bookMany.checked).toMatch(/slots are still free/);
    for (const v of Object.values(SERVICE_BUSY_UNSURE_TEXT)) {
      expect(v.checked).not.toMatch(/didn't answer/);
      expect(v.unchecked).not.toMatch(/didn't answer/);
    }
  });
});
