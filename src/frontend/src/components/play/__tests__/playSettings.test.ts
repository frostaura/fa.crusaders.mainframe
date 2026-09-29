import { describe, expect, it } from "vitest";
import { SETTINGS_SECTIONS, settingsIn } from "@/lib/settingsSchema";
import { sectionSummary } from "@/lib/settingsSummaries";
import { SETTINGS_FIXTURE } from "@/test/harness";
import type { AdminSettings } from "@/lib/api";

/** The seven club numbers of play.md §6.4, on the Settings page — bounds and defaults as the server's. */
describe("the play settings", () => {
  it("are one section with the seven keys, their bounds and defaults, sent snake_case", () => {
    expect(SETTINGS_SECTIONS.map((s) => s.id)).toContain("play");
    const rows = settingsIn("play").map((d) => [d.key, d.min, d.max, d.defaultValue, d.wire]);
    expect(rows).toEqual([
      ["result_autoconfirm_hours", 12, 168, 48, "snake"],
      ["result_record_days", 1, 30, 7, "snake"],
      ["streak_rest_every_weeks", 2, 12, 4, "snake"],
      ["streak_rest_cap", 0, 4, 2, "snake"],
      ["streak_pause_weeks_per_year", 0, 26, 8, "snake"],
      ["play_early_bird_before_minute", 0, 720, 420, "snake"],
      ["play_night_owl_from_minute", 720, 1439, 1260, "snake"],
    ]);
    for (const def of settingsIn("play")) {
      expect(def.optional, def.key).toBe(true);
      expect(def.range, def.key).toBe(true);
    }
  });

  it("summarise themselves when collapsed, and say so when the club's system does not serve them", () => {
    const served = { ...SETTINGS_FIXTURE, result_autoconfirm_hours: 48, streak_rest_every_weeks: 4, streak_rest_cap: 2 } as unknown as AdminSettings;
    expect(sectionSummary("play", served, "R")).toBe("Results confirm after 48 hours · a rest week every 4 weeks played");
    expect(sectionSummary("play", SETTINGS_FIXTURE as unknown as AdminSettings, "R")).toBe("Not available on this club's system yet");
  });
});
