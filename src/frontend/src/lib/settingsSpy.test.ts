import { describe, expect, it } from "vitest";
import { sectionAtTop } from "./settingsSpy";

/** BA-18: the rail lit "Repeating bookings" while "Box screens & scanning" filled the screen. */
describe("the section the admin is reading", () => {
  const tops = (scrolled: number) => [
    { id: "schedules", top: 100 - scrolled }, { id: "boxes", top: 700 - scrolled }, { id: "screens", top: 1400 - scrolled },
    { id: "doors", top: 3400 - scrolled },
  ];

  it("is the last section whose heading has reached the top of the scroller", () => {
    // The scroller starts 64px down the window (under the app bar).
    expect(sectionAtTop(tops(1350), 64)).toBe("screens");
    // A long open section that has scrolled past the top is still the one being read.
    expect(sectionAtTop(tops(2600), 64)).toBe("screens");
    expect(sectionAtTop(tops(3300), 64)).toBe("doors");
  });

  it("is the first section before any heading reaches the top", () => {
    expect(sectionAtTop(tops(-500), 64)).toBe("schedules");
    expect(sectionAtTop([], 64)).toBeNull();
  });
});
