import { describe, expect, it } from "vitest";
import {
  ECO_NUMERIC_RULES, ECO_SETTING_LABELS, ecoSettingComplaints,
} from "./ecoSettings";

/**
 * Every number this release made configurable, and the bound that makes it safe to type.
 *
 * <p>
 * Ruling 13: every configurable number is a tenant setting with validation and a row. The
 * failure this file guards against is not a missing bound — it is a bound that DISAGREES
 * with the server's, which produces either a save that fails with a message nobody on the
 * screen can act on, or a value the product supports and the screen silently forbids.
 * </p>
 */
describe("every new key has a row, a bound and a sentence", () => {
  it.each(ECO_NUMERIC_RULES.map((r) => [r.key, r] as const))("%s", (_key, rule) => {
    expect(rule.label.length).toBeGreaterThan(5);
    // The hint carries the range, because a bound the admin cannot read is a refusal waiting
    // to happen — every existing field on this page states its own.
    expect(rule.hint).toContain(`${rule.min}`);
    expect(rule.hint).toContain(`${rule.max}`);
    expect(rule.min).toBeLessThan(rule.max);
    expect(ECO_SETTING_LABELS[rule.key]).toBe(rule.label);
  });

  it("says what zero means wherever zero is magic", () => {
    // "0 = unlimited" is the convention throughout this codebase, and a field offering 0 with
    // no explanation is a field where somebody types it meaning "none".
    for (const rule of ECO_NUMERIC_RULES) {
      if (rule.min !== 0) continue;
      expect(rule.zeroMeans, `${rule.key} allows 0 and does not say what it means`).toBeTruthy();
      expect(rule.hint).toMatch(/\b0\b/);
    }
  });

  /** D2 §14's bounds, restated here so a drift in either direction fails a test. */
  it.each([
    ["lcd_revert_seconds", 5, 120],
    ["rapid_scan_window_seconds", 0, 60],
    ["member_max_slots_per_day", 0, 96],
    ["admin_bulk_max_items", 1, 500],
    ["schedule_materialisation_days", 7, 365],
    ["schedule_max_rows_per_change", 100, 20_000],
    ["device_error_retention_days", 7, 730],
    ["device_error_max_open_rows", 20, 2000],
    ["sse_keepalive_seconds", 5, 55],
    ["realtime_fallback_after_failures", 1, 10],
    ["realtime_poll_seconds_control_board", 5, 120],
    ["control_board_resync_seconds", 30, 3600],
  ])("%s is bounded %i..%i, exactly as the API is", (key, min, max) => {
    const rule = ECO_NUMERIC_RULES.find((r) => r.key === key)!;
    expect(rule.min).toBe(min);
    expect(rule.max).toBe(max);
  });

  it("keeps the keep-alive under the gateway's own idle timeout, and says why", () => {
    const rule = ECO_NUMERIC_RULES.find((r) => r.key === "sse_keepalive_seconds")!;
    // Above 60 the gateway closes a quiet connection, so a live screen drops and reconnects
    // for ever — the one bound here whose reason is not obvious from the field's name.
    expect(rule.max).toBeLessThan(60);
    expect(rule.hint).toContain("60");
  });
});

describe("what the page refuses, and what it deliberately does not", () => {
  it("complains about a number outside its bound, naming the field and the range", () => {
    const said = ecoSettingComplaints({ member_max_slots_per_day: 200 });
    expect(said).toHaveLength(1);
    expect(said[0].key).toBe("member_max_slots_per_day");
    expect(said[0].message).toContain("between 0 and 96");
  });

  it("accepts both ends of every range", () => {
    for (const rule of ECO_NUMERIC_RULES) {
      expect(ecoSettingComplaints({ [rule.key]: rule.min }), `${rule.key} min`).toEqual([]);
      expect(ecoSettingComplaints({ [rule.key]: rule.max }), `${rule.key} max`).toEqual([]);
    }
  });

  it("refuses a fraction, because every one of these is a whole number", () => {
    expect(ecoSettingComplaints({ sse_keepalive_seconds: 25.5 })).toHaveLength(1);
  });

  /**
   * <b>The rule that keeps this page savable against a backend that is still being built.</b>
   * Three lanes are writing these keys in parallel; a console that refused to save because
   * the API had not shipped one yet would take the whole settings page down for a field
   * nobody had touched.
   */
  it("says nothing at all about a key the API has not shipped", () => {
    expect(ecoSettingComplaints({})).toEqual([]);
    expect(ecoSettingComplaints({ sse_keepalive_seconds: undefined })).toEqual([]);
    expect(ecoSettingComplaints({ sse_keepalive_seconds: null })).toEqual([]);
  });

  /**
   * An EMPTIED box is a different thing from an absent key, and the page's own empty-number
   * check owns it. Two messages on one input is worse than one, and "has to be between 5 and
   * 55" is a confusing thing to be told about a box you have just cleared.
   */
  it("leaves an emptied box to the page's own message", () => {
    expect(ecoSettingComplaints({ sse_keepalive_seconds: Number.NaN })).toEqual([]);
  });

  /**
   * The one cross-field rule, and the one whose failure appears weeks later: a member books
   * fourteen days ahead into a league night that is only written seven days ahead, and
   * nothing goes wrong until the week it does.
   */
  it("refuses a booking window that reaches past where repeating bookings are written", () => {
    const said = ecoSettingComplaints({ advance_booking_days: 90, schedule_materialisation_days: 60 });
    expect(said).toHaveLength(1);
    expect(said[0].key).toBe("schedule_materialisation_days");
    expect(said[0].message).toContain("book into a league night that has not been written yet");
  });

  it("is happy when the two are equal, which is the tightest setting that works", () => {
    expect(ecoSettingComplaints({ advance_booking_days: 60, schedule_materialisation_days: 60 })).toEqual([]);
  });

  it("does not invent the cross-field rule out of one half of it", () => {
    expect(ecoSettingComplaints({ advance_booking_days: 90 })).toEqual([]);
    expect(ecoSettingComplaints({ schedule_materialisation_days: 60 })).toEqual([]);
  });

  /**
   * The money symbol, bounded exactly as the server bounds it.
   *
   * <p>
   * The bound is `CurrencySymbol.IsAcceptable`'s, mirrored. The whole reason this module
   * exists is that a screen bounding a field differently from the server either refuses a
   * value the product supports or produces a save that fails with a message nobody on the
   * screen can act on.
   * </p>
   */
  it("takes any symbol a real currency uses", () => {
    for (const symbol of ["R", "$", "€", "kr", "R$", "CHF", "US$"]) {
      expect(ecoSettingComplaints({ currency_symbol: symbol }), symbol).toEqual([]);
    }
    // Whitespace is packaging, and the server trims it too.
    expect(ecoSettingComplaints({ currency_symbol: "  R  " })).toEqual([]);
  });

  it("refuses a symbol the product cannot print in front of a number", () => {
    for (const bad of ["", "   ", "RANDS", "R 50", "50", "R50", "<b>"]) {
      expect(ecoSettingComplaints({ currency_symbol: bad }), bad).toHaveLength(1);
    }
    expect(ecoSettingComplaints({ currency_symbol: "" })[0].key).toBe("currency_symbol");
  });

  it("says nothing about a key the API never served", () => {
    // An absent key is never a complaint — this module's own rule, and the commonest case
    // against an API that predates the key.
    expect(ecoSettingComplaints({})).toEqual([]);
    expect(ecoSettingComplaints({ currency_symbol: undefined })).toEqual([]);
    expect(ecoSettingComplaints({ currency_symbol: null })).toEqual([]);
  });
});
