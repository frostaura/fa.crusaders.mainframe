import { describe, expect, it } from "vitest";
import { ApiError, type AdminSettings } from "./api";
import {
  SETTINGS, describeSetting, rangeComplaints, settingDef, settingsFor, settingsIn,
} from "./settingsSchema";
import { describeSaveFailure } from "../components/settings/draft";

/**
 * The box and device settings (device-api §5, §6, §10; FA-2, FA-4, FA-5, FA-10, BA-03, BA-05).
 *
 * <p>
 * The defect these rows close was a client range that disagreed with the server's: the console
 * offered 5–120 s for the screen's revert and the API refused anything past 60, while 3 and 4,
 * which the API accepts, were forbidden. The rows now carry NO range of their own; the settings
 * GET's `bounds` is the only source, and this file fails if a row grows a copy.
 * </p>
 */

const BOX_KEYS = [
  // the seven the heartbeat already delivered and no screen showed (FA-4), plus the revert and hint
  "lcd_revert_seconds", "lcd_hint_seconds", "lcd_choice_seconds", "lcd_card_seconds", "scan_memory_seconds",
  "clock_trust_minutes", "relay_restore_enabled", "device_fault_reporting", "device_fault_max_per_hour",
  // the thirteen v3 keys (§5) and the key grace (§6)
  "lcd_layout", "lcd_marquee_enabled", "lcd_marquee_step_ms", "lcd_landing_page_seconds", "lcd_screen_ceiling_seconds",
  "lcd_landing_dwell_seconds", "lcd_after_lights_on_seconds", "lcd_reinit_seconds", "relay_authorisation_cap_minutes",
  "relay_reconcile_min_seconds", "device_power_restore_trust_minutes", "device_net_fallback_minutes",
  "device_ota_probation_minutes", "device_key_grace_hours",
  // the five hardware facts (§12; HW-1, HW-2, HW-5)
  "hw_relay_active_level", "hw_lcd_i2c_address", "hw_scanner_baud", "hw_scanner_line_end", "hw_scanner_gap_ms",
] as const;

const HW_SELECTS = ["hw_relay_active_level", "hw_lcd_i2c_address", "hw_scanner_baud", "hw_scanner_line_end"] as const;

const BOUNDS = {
  lcd_revert_seconds: { min: 3, max: 60 },
  lcd_choice_seconds: { min: 5, max: 60 },
  lcd_layout: { values: ["compact", "expanded"] },
  lcd_screen_ceiling_seconds: { min: 15, max: 120 },
};

const settingsWith = (extra: Record<string, unknown>): AdminSettings => ({
  slice_minutes: 15, advance_booking_days: 14, day_start_minute: 360, day_end_minute: 1320,
  penalty_pct: 50, grace_window_minutes: 10, penalty_window_minutes: 120, timezone: "Africa/Johannesburg",
  button_map: [], ...extra,
} as unknown as AdminSettings);

describe("every box and device setting has a row", () => {
  it.each(BOX_KEYS.map((key) => [key] as const))("%s", (key) => {
    const def = settingDef(key);
    expect(def, key).toBeDefined();
    expect(def!.optional, `${key} must render only when served`).toBe(true);
    expect(def!.serverBounds, `${key} takes its range from the API`).toBe(true);
    // Snake_case on the PUT: a camelCase spelling of these is bound by nothing and saves as a no-op.
    expect(["snake", "both"]).toContain(def!.wire);
  });

  it("has no client range on any row whose range is the API's", () => {
    for (const def of SETTINGS.filter((d) => d.serverBounds)) {
      expect(def.min, `${def.key} carries a client min`).toBeUndefined();
      expect(def.max, `${def.key} carries a client max`).toBeUndefined();
      // Nor a range written into the words, which is the same copy by another name.
      expect(def.description, def.key).not.toMatch(/\d+\s*[–-]\s*\d+/);
      expect(typeof def.help === "string" ? def.help : "", def.key).not.toMatch(/^\d+\s*[–-]\s*\d+\./);
    }
  });

  it("no longer has the dead rapid-scan window anywhere", () => {
    expect(settingDef("rapid_scan_window_seconds")).toBeUndefined();
  });

  it("puts the screen rows under Box screens and the restore switch with the boxes", () => {
    const screens = settingsIn("screens").map((d) => d.key);
    expect(screens).toEqual(expect.arrayContaining(["lcd_layout", "lcd_choice_seconds", "lcd_screen_ceiling_seconds"]));
    expect(settingDef("relay_restore_enabled")!.section).toBe("boxes");
    expect(settingDef("device_fault_reporting")!.section).toBe("monitoring");
  });
});

describe("what each screen timer governs, in words (FA-5)", () => {
  it("does not claim the revert is every screen's timeout, and names the hold that is", () => {
    const help = settingDef("lcd_revert_seconds")!.help as string;
    expect(help).not.toMatch(/Every screen on the box has this timeout/);
    expect(help).toContain("Court choice waits");
    expect(help).toContain("Longest any screen lasts");
    // The landing text the v3 glass actually renders, not a sentence it never shows.
    expect(help).toContain("SCAN YOUR QR");
    expect(help).not.toContain("Scan code to get started");
  });
});

describe("the API's bounds are the only bounds", () => {
  it("applies a served range to the row, the line under it and the check", () => {
    const settings = settingsWith({ lcd_revert_seconds: 90, bounds: BOUNDS });
    const def = settingsFor(settings).find((d) => d.key === "lcd_revert_seconds")!;
    expect(def.min).toBe(3);
    expect(def.max).toBe(60);
    expect(describeSetting(def, "R")).toContain("Allowed: 3–60 seconds.");
    const complaints = rangeComplaints(settings, { settings, currency: "R" });
    expect(complaints.map((c) => c.key)).toEqual(["lcd_revert_seconds"]);
    expect(complaints[0].message).toContain("from 3 to 60");
  });

  it("accepts 3, which the old client range forbade, and refuses nothing without a served bound", () => {
    const three = settingsWith({ lcd_revert_seconds: 3, bounds: BOUNDS });
    expect(rangeComplaints(three, { settings: three, currency: "R" })).toEqual([]);
    // No bounds served (an older API): no client check at all — the refusal names the range.
    const unbounded = settingsWith({ lcd_revert_seconds: 900 });
    expect(rangeComplaints(unbounded, { settings: unbounded, currency: "R" })).toEqual([]);
    const def = settingsFor(unbounded).find((d) => d.key === "lcd_revert_seconds")!;
    expect(describeSetting(def, "R")).not.toContain("Allowed");
  });

  it("follows the bound when the API changes it, rather than caching the first one", () => {
    const narrow = settingsWith({ lcd_choice_seconds: 50, bounds: { lcd_choice_seconds: { min: 5, max: 40 } } });
    const wide = settingsWith({ lcd_choice_seconds: 50, bounds: { lcd_choice_seconds: { min: 5, max: 60 } } });
    expect(rangeComplaints(narrow, { settings: narrow, currency: "R" })).toHaveLength(1);
    expect(rangeComplaints(wide, { settings: wide, currency: "R" })).toHaveLength(0);
  });

  it("offers exactly the layouts the API serves", () => {
    const settings = settingsWith({ lcd_layout: "compact", bounds: { lcd_layout: { values: ["compact"] } } });
    const def = settingsFor(settings).find((d) => d.key === "lcd_layout")!;
    expect(def.options!.map((o) => o.value)).toEqual(["compact"]);
  });

  it("quotes the range a refusal carries, by the field's caption", () => {
    const err = new ApiError(400, { error: "lcd_revert_seconds_out_of_range", min: 3, max: 60 });
    expect(describeSaveFailure(err, "R")).toBe("Screen returns to the start after a result (seconds) has to be from 3 to 60. Nothing was saved.");
  });
});

describe("the hardware facts (device-api §12)", () => {
  it("carries no client enumeration for any of them: the values are the API's", () => {
    for (const key of HW_SELECTS) {
      expect(settingDef(key)!.options ?? [], key).toEqual([]);
      expect(settingDef(key)!.kind).toBe("select");
    }
    expect(settingDef("hw_scanner_gap_ms")!.kind).toBe("number");
  });

  it("offers exactly the served values, named in words, numeric ones held as numbers", () => {
    const settings = settingsWith({
      hw_lcd_i2c_address: 0, hw_scanner_baud: 9600, hw_relay_active_level: "high",
      bounds: {
        hw_lcd_i2c_address: { values: [0, 39, 63] },
        hw_scanner_baud: { values: [0, 9600] },
        hw_relay_active_level: { values: ["high", "low"] },
        hw_scanner_gap_ms: { min: 50, max: 500 },
      },
    });
    const of = (key: string) => settingsFor(settings).find((d) => d.key === key)!;
    expect(of("hw_lcd_i2c_address").options).toEqual([
      { value: "0", label: "Search for it" }, { value: "39", label: "0x27" }, { value: "63", label: "0x3F" },
    ]);
    expect(of("hw_lcd_i2c_address").numericChoice).toBe(true);
    expect(of("hw_scanner_baud").options!.map((o) => o.label)).toEqual(["Auto-detect", "9600 baud"]);
    expect(of("hw_relay_active_level").options!.map((o) => o.value)).toEqual(["high", "low"]);
    expect(of("hw_relay_active_level").numericChoice).toBeUndefined();
    expect([of("hw_scanner_gap_ms").min, of("hw_scanner_gap_ms").max]).toEqual([50, 500]);
  });

  it("without served values offers only what the club holds, never a made-up list", () => {
    const settings = settingsWith({ hw_scanner_line_end: "crlf", bounds: { lcd_layout: { values: ["compact"] } } });
    expect(settingsFor(settings).find((d) => d.key === "hw_scanner_line_end")!.options).toEqual([{ value: "crlf", label: "CR/LF — only the scanner's own line end" }]);
  });
});

describe("the levers the box ignores say so (FC-8)", () => {
  it("labels slice and grace as the club system's rules, and the walk-up cap as the buttons' cap", () => {
    expect(settingDef("slice_minutes")!.help as string).toMatch(/a box never uses it/);
    expect(settingDef("grace_window_minutes")!.help as string).toMatch(/court boxes do nothing with it/);
    expect(settingDef("walk_up_max_minutes")!.description).toMatch(/the most any time button gives/);
    expect(settingDef("walk_up_max_minutes")!.help as string).toMatch(/caps every time button above it/);
  });
});
