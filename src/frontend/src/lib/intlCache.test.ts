import { describe, expect, it } from "vitest";
import { dateTimeFormat } from "./intlCache";
import { clubClock } from "./clubClock";

describe("dateTimeFormat", () => {
  it("builds one formatter per locale and options, and reuses it", () => {
    const a = dateTimeFormat("en-GB", { weekday: "long", timeZone: "UTC" });
    expect(dateTimeFormat("en-GB", { weekday: "long", timeZone: "UTC" })).toBe(a);
    expect(dateTimeFormat("en-GB", { weekday: "short", timeZone: "UTC" })).not.toBe(a);
    expect(dateTimeFormat("en-GB", { weekday: "long", timeZone: "Africa/Johannesburg" })).not.toBe(a);
    expect(a.format(new Date(Date.UTC(2026, 8, 30)))).toBe("Wednesday");
  });

  it("builds afresh when no zone is named — the device's zone can change under it", () => {
    expect(dateTimeFormat("en-GB", { weekday: "long" })).not.toBe(dateTimeFormat("en-GB", { weekday: "long" }));
  });

  it("still refuses a zone this engine does not know, and caches nothing for it", () => {
    expect(() => dateTimeFormat("en-GB", { timeZone: "Not/AZone" })).toThrow(RangeError);
    expect(() => dateTimeFormat("en-GB", { timeZone: "Not/AZone" })).toThrow(RangeError);
  });

  it("leaves clubClock's answers as they were, a bad instant included", () => {
    expect(clubClock("2026-09-30T19:25:00Z", "Africa/Johannesburg")).toBe("21:25");
    expect(clubClock("not a date", "Africa/Johannesburg")).toBe("Invalid Date");
  });
});
