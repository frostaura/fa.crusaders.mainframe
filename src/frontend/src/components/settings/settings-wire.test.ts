import { afterEach, describe, expect, it, vi } from "vitest";
import { endpoints, type AdminSettings } from "@/lib/api";
import { SETTINGS_FIXTURE, stubFetch } from "@/test/harness";
import { RETIRED_SETTING_KEYS, describeSaveFailure, saveBody, savePayload, wireBody } from "./draft";
import { ApiError } from "@/lib/api";

/**
 * The Settings page's PUT body (`draft.wireBody`), held against the shared mapper it replaced for
 * this page (`endpoints.adminSettingsSave`).
 *
 * <p>
 * The page builds its own body because the mapper names each key by hand: a key it has not heard
 * of — every R23 alert number, every cooldown the server adds — never reached the wire, and the
 * snake-only keys it did send camelCase were bound by nothing. Building a second body is only safe
 * while the two AGREE on every key they share, so this is the guard on that: any drift is red here
 * rather than a setting that silently stops saving.
 * </p>
 */

const DOC = {
  ...SETTINGS_FIXTURE,
  door_log_retention_days: 90, door_refusal_spike_count: 8, door_refusal_spike_minutes: 20,
  club_contact_phone: "076 226 1390", club_contact_email: "squash@example.co.za",
  lcd_revert_seconds: 10, member_max_slots_per_day: 4, admin_bulk_max_items: 50,
  schedule_materialisation_days: 60, schedule_max_rows_per_change: 500, device_error_retention_days: 30,
  device_error_max_open_rows: 200, sse_keepalive_seconds: 25, realtime_fallback_after_failures: 3,
  realtime_poll_seconds_control_board: 10, control_board_resync_seconds: 300,
  currency_symbol: "R", member_trace_enabled: true,
  fault_spike_count: 5, fault_spike_minutes: 15, application_reminder_hours: 24, admin_notification_retention_days: 90,
  topup_failure_cooldown_minutes: 30,
} as unknown as AdminSettings;

/**
 * An API mid-deploy may still serve every key P13 retired (contract §3.6, §3.9) — the slice price,
 * both conversion rates, the purchase block and cap. The server binds and ignores them; the console
 * must never send one, under either spelling.
 */
const RETIRED = {
  slice_price_credits: 8, credits_per_zar_regular: 1.6, credits_per_zar_league: 2.4,
  topup_block_zar: 100, topup_max_zar_per_member: 1000,
};
const OLD_DOC = { ...DOC, ...RETIRED } as unknown as AdminSettings;
const RETIRED_WIRE = /slice_?price|credits_?per_?zar|topup_?block|topup_?max/i;

async function mapperBody(doc: AdminSettings): Promise<Record<string, unknown>> {
  const stub = stubFetch([{ method: "PUT", path: "/api/v1/admin/settings/", body: { saved: true } }]);
  await endpoints.adminSettingsSave(doc);
  return stub.calls[0].body as Record<string, unknown>;
}

afterEach(() => vi.unstubAllGlobals());

describe("the Settings page's own PUT body", () => {
  it("agrees with the shared mapper on every key the mapper sends — except the button map, which is the Boards screen's", async () => {
    const theirs = await mapperBody(DOC);
    const ours = wireBody(savePayload(DOC));
    const { buttonMap: _map, ...shared } = theirs;
    for (const [key, value] of Object.entries(shared)) {
      if (RETIRED_WIRE.test(key)) continue;
      expect(ours[key], `${key} differs from the mapper`).toEqual(value);
    }
  });

  it("never sends the button map (the Boards screen's)", () => {
    const ours = wireBody(savePayload(DOC));
    expect(Object.keys(ours).filter((key) => /button_?map/i.test(key))).toEqual([]);
  });

  it("never sends a retired money key, even when the read still served one (P13 §3.9)", () => {
    expect(RETIRED_SETTING_KEYS).toEqual(Object.keys(RETIRED));
    const whole = wireBody(savePayload(OLD_DOC));
    expect(Object.keys(whole).filter((key) => RETIRED_WIRE.test(key))).toEqual([]);
    // The versioned save: edits over a copy that carried them, retired keys "edited" too.
    const edited = { ...(OLD_DOC as unknown as Record<string, unknown>), slice_minutes: 30, topup_block_zar: 150 };
    const partial = saveBody({ ...OLD_DOC, version: "v1" } as AdminSettings, edited as unknown as AdminSettings);
    expect(partial).toEqual({ version: "v1", sliceMinutes: 30 });
  });

  it("spells each key the way the API binds it", async () => {
    const ours = wireBody(savePayload(DOC));
    // R23 — snake_case only; a camelCase twin would be bound by nothing.
    expect(ours).toMatchObject({ fault_spike_count: 5, application_reminder_hours: 24, topup_failure_cooldown_minutes: 30 });
    expect(ours).not.toHaveProperty("faultSpikeCount");
    expect(ours).not.toHaveProperty("topupFailureCooldownMinutes");
    // The snake-only box and monitoring keys go under both, so the old spelling keeps its tests
    // and the new one is the one the API actually reads — and the shared mapper now sends them
    // snake_case too, so the button-map screen cannot fall into the same silent no-op.
    expect(ours).toMatchObject({ lcdRevertSeconds: 10, lcd_revert_seconds: 10, deviceErrorRetentionDays: 30, device_error_retention_days: 30 });
    // The camel-only originals stay camel-only.
    expect(ours).toMatchObject({ sliceMinutes: 15, operatingHours: SETTINGS_FIXTURE.operating_hours });
    expect(ours).not.toHaveProperty("slice_minutes");
    const theirs = await mapperBody(DOC);
    expect(theirs).toMatchObject({ lcd_revert_seconds: 10, device_error_retention_days: 30, device_error_max_open_rows: 200 });
    expect(theirs).not.toHaveProperty("lcdRevertSeconds");
  });

  it("sends nothing for a key the read did not carry — absent means unchanged", () => {
    const ours = wireBody(savePayload(SETTINGS_FIXTURE as unknown as AdminSettings));
    expect(Object.keys(ours).some((key) => /fault|reminder|notification|cooldown_minutes$/.test(key) && key !== "deviceAlertCooldownMinutes")).toBe(false);
  });
});

describe("a refused save, in words", () => {
  const refused = (code: string) => new ApiError(400, { error: code });

  it("names the field for any <key>_out_of_range this page shows", () => {
    expect(describeSaveFailure(refused("fault_spike_minutes_out_of_range"), "R"))
      .toBe("Fault spike window (minutes) is outside what the club’s system accepts. Nothing was saved.");
  });

  it("leaves every other code to the shared dictionary and its fallback", () => {
    expect(describeSaveFailure(refused("day_end_before_start"), "R")).toBe("day end before start");
    expect(describeSaveFailure(refused("mystery_thing_out_of_range"), "R")).toBe("mystery thing out of range");
  });
});
