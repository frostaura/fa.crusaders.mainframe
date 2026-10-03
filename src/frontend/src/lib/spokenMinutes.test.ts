import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as desk from "./deskMinutesCopy";
import * as players from "./playersCopy";
import * as bookings from "./bookingsCopy";
import * as wallet from "./walletCopy";
import * as schedule from "./scheduleCopy";
import { MEMBER_TABS, BOOKINGS_TAB_COPY as MEMBER_BOOKINGS } from "./memberDetailCopy";
import { PACKAGES_COPY, savesWords } from "./packagesCopy";
import { ARCHIVE_COPY } from "./groupsCopy";
import { explainFault, faultDetail } from "./deviceFaultCopy";
import { FEATURES } from "./features";
import { sectionSummary } from "./settingsSummaries";
import type { AdminSettings } from "./api";
import { keepAmounts } from "../components/players/detail/detailModel";
import { CELEBRATION_COPY, RING_COPY, hoursAndMinutesSpoken } from "./playCopy";

/**
 * Review round 6, X6-2: a screen reader never hears "h", "d" or "min" (P13 contract §7.1).
 *
 * <p>
 * A sentence is read whole, so the compact figure inside it ("You need 45 min more") was heard
 * as "45 min". Minutes inside words — every sentence, label and button built in a copy module —
 * are written in the long form (`minutesSpoken`, the backend's `MoneyFormat.Minutes` wording),
 * and the compact form is left to a standalone figure drawn through `<Minutes>`, which pairs it
 * with its spoken twin.
 * </p>
 */
const ABBREVIATED = /\d[\s\u00a0]?(h|min|d)\b/;

const said = (s: string) => expect(s, s).not.toMatch(ABBREVIATED);

/** A number or an interpolation followed by a compact unit: `${n} min`, "15 min", `${h} h`, `${n}-min`. */
const LITERAL_UNIT = /(\d|\$\{[^}]*\})([ \u00a0]|-)(min|h|d)\b/;

/** The compact figure formatters a copy module may keep — each drawn only beside a spoken twin. */
const COMPACT_FORMATTERS = [{ file: "playCopy.ts", fn: "hoursAndMinutes" }];

/** The source with comments and the exempt formatters' bodies blanked, line numbers kept. */
function codeOf(source: string, file: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  let code = source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, lead: string) => lead + blank(m.slice(lead.length)));
  for (const { file: f, fn } of COMPACT_FORMATTERS) {
    if (f !== file) continue;
    code = code.replace(new RegExp(`export function ${fn}\\([\\s\\S]*?\\n\\}`), blank);
  }
  return code;
}

describe("X6-2 — minutes in words are spoken words", () => {
  it("the desk's adjust and sell sheets", () => {
    said(desk.balanceSentence("Thandi", 370, 100, "add"));
    said(desk.overdraftWarning(30, 90)!);
    said(desk.confirmConsequence("Thandi", 370, 100, "take_back"));
    said(desk.receiptHeader("Thandi", 370, 90, "add"));
    said(desk.doneSentence("Thandi", 460));
    said(desk.signedAmount("add", 15));
    said(desk.signedAmount("take_back", 120));
    said(desk.ADJUST_SHEET.amountEcho(90));
    said(desk.ADJUST_SHEET.idleAdd(60));
    said(desk.ADJUST_SHEET.idleTakeBack(45));
    said(desk.SELL_COPY.idle(600));
    said(desk.SELL_COPY.receipt("Thandi", "Ten hours", 600));
    expect(desk.signedAmount("add", 90)).toBe("+1 hour 30 minutes");
    expect(desk.SELL_COPY.idle(60)).toBe("Sell 1 hour");
  });

  it("invites, splits and the booking detail", () => {
    expect(players.acceptLabel(30)).toBe("Accept and pay 30 minutes");
    said(players.acceptedUnpaidLine(5));
    said(players.askedAgainLine("Sam", 30));
    said(players.shortByLine(12));
    said(players.acceptedLine(22, "Sam"));
    said(players.heldLine(12, null));
    said(players.owedBackLine(15));
    said(players.owedBackQuoteLine(15, "Jo"));
    said(players.confirmPlayersSentence(60, [{ kind: "member", name: "Jo", share: 15 }]));
    said(players.confirmPlayersSentence(60, [{ kind: "member", name: "Jo", share: 15 }, { kind: "member", name: "Sam", share: 20 }]));
  });

  it("bookings: the grid, the sheet, the cancel rows and the booking-for bar", () => {
    expect(bookings.sliceLengthLine(15)).toBe("15-minute slots");
    expect(bookings.sliceLengthLine(60)).toBe("1-hour slots");
    said(bookings.sliceLengthLine(90));
    said(bookings.selectionHeadline(2, 90));
    said(bookings.signedMinutes(-16));
    said(bookings.splitRowOutcome(30, 15, 5));
    said(bookings.cancelRowOutcome(45, 5));
    said(bookings.BOOKING_FOR.canSpend(90));
    said(bookings.BOOKING_FOR.held(15));
    expect(bookings.cancelTermsLine(30, 15)).toBe(
      "Cancel more than 15 minutes before the start and the full amount comes back; inside 15 minutes, 30% is kept. Once the lights have been on, nothing comes back.",
    );
  });

  it("the settings summaries an admin reads down the collapsed sections (R7 J7-3)", () => {
    const settings = {
      slice_minutes: 15, advance_booking_days: 14, member_per_day_max_minutes: 60, penalty_pct: 30,
      penalty_window_minutes: 15, grace_window_minutes: 10, walk_up_max_minutes: 90,
      activation_cue_window_minutes: 10, fault_spike_count: 5, fault_spike_minutes: 15,
      lcd_revert_seconds: 5, gate_unlock_seconds: 15,
    } as unknown as AdminSettings;
    const ids = ["bookings", "cancellations", "boxes", "alerts", "screens", "doors"] as const;
    for (const id of ids) said(sectionSummary(id, settings, "R"));
    expect(sectionSummary("bookings", settings, "R")).toBe("15-minute slices · 14 days ahead · 1 hour a day each");
    expect(sectionSummary("cancellations", settings, "R")).toBe("30% penalty inside 15 minutes · 10-minute grace before a no-show");
    expect(sectionSummary("boxes", settings, "R")).toBe("Walk-ups up to 1 hour 30 minutes · lights on 10 minutes early");
    expect(sectionSummary("alerts", settings, "R")).toMatch(/^5 faults in 15 minutes is a spike/);
  });

  it("the package editor's hour chips are said as hours", () => {
    expect(PACKAGES_COPY.hoursChip(1)).toBe("1 hour");
    expect(PACKAGES_COPY.hoursChip(10)).toBe("10 hours");
  });

  it("the wallet's sentences", () => {
    said(wallet.minutesArrivedSentence(90, "AdminAdjustment", "Thandi"));
    said(wallet.minutesLeftSentence(45, "BookingCharge"));
    said(wallet.movementSentence(-45, "booking_charge"));
    said(wallet.spendableLine(-4));
    said(wallet.spendableLine(30));
    said(wallet.chipHeldTitle(15, 10));
  });

  it("the admin's member detail and schedule refunds", () => {
    expect(MEMBER_BOOKINGS.charged(30)).toBe("30 minutes");
    said(schedule.conflictRefundPhrase({ would_refund_minutes: 45, member_name: "Jo" }));
    said(schedule.clearAllLabel(2, 90));
    said(schedule.conflictRefundedLine(60));
    said(schedule.clearAllDescription(2, 90));
  });

  it("time on court in sentences and the ring's label", () => {
    expect(hoursAndMinutesSpoken(405)).toBe("6 hours 45 minutes");
    expect(hoursAndMinutesSpoken(60)).toBe("1 hour");
    said(RING_COPY.aria(405, 600));
    said(RING_COPY.caption(600));
    said(CELEBRATION_COPY.goalBody(600));
  });

  it("no copy module formats a minutes figure in the compact form", () => {
    // A copy module writes words; the compact figure belongs to `<Minutes>` and its spoken twin.
    const dir = __dirname;
    const offenders = readdirSync(dir)
      .filter((f) => /Copy\.ts$/.test(f))
      .filter((f) => /\bminutes(Compact|Signed)\(/.test(readFileSync(join(dir, f), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("no copy module writes a literal compact unit into its words (R7 J7-3)", () => {
    // R6's guard caught a `minutesCompact(` call but not the unit typed by hand: "inside
    // ${windowMinutes} min", "${minutes} min a day", "${hours} h" all reached members and
    // admins as "min" and "h". Comments are documentation and are stripped before the scan.
    const dir = __dirname;
    const files = [
      ...readdirSync(dir).filter((f) => /Copy\.ts$/.test(f)),
      "settingsSummaries.ts",
    ];
    const offenders = files.flatMap((f) =>
      codeOf(readFileSync(join(dir, f), "utf8"), f)
        .split("\n")
        .map((line, i) => ({ line, at: `${f}:${i + 1}` }))
        .filter(({ line }) => LITERAL_UNIT.test(line))
        .map(({ line, at }) => `${at}  ${line.trim()}`),
    );
    expect(offenders).toEqual([]);
  });

  it("the one compact formatter a copy module keeps is still a figure, not a sentence", () => {
    // `hoursAndMinutes` draws the tile's and the ring's figure; each pairs it with a spoken twin
    // (`hoursAndMinutesSpoken`, RING_COPY.aria). Exempt by name, so the exemption cannot outlive it.
    for (const { file, fn } of COMPACT_FORMATTERS) {
      expect(readFileSync(join(__dirname, file), "utf8")).toMatch(new RegExp(`export function ${fn}\\(`));
    }
  });

  it("a spoken figure in a sentence is still held together (R5 V5-7)", () => {
    expect(keepAmounts("Paid 1 day 6 hours 15 minutes of 2 hours")).toBe(
      "Paid 1 day 6 hours 15 minutes of 2 hours",
    );
  });
});

describe("J6-1 — an amount split is in whole minutes", () => {
  it("says whole minutes, never decimal places", () => {
    const text = players.PLAYERS_REFUSAL.split_amount_invalid;
    expect(text).not.toMatch(/decimal/);
    expect(text).toMatch(/whole number of minutes/);
  });
});

describe("J6-9 — archiving a group", () => {
  it("is grammatical for one member and says its packages leave their shelves", () => {
    const one = ARCHIVE_COPY.body("Juniors", 1);
    expect(one).toMatch(/its member goes back/);
    expect(one).toMatch(/packages/);
    expect(ARCHIVE_COPY.body("Juniors", 3)).toMatch(/its 3 members go back.*packages/);
  });
});

describe("J6-8 — taking minutes back below zero is said on the check step", () => {
  it("the armed consequence names the debt", () => {
    expect(desk.confirmConsequence("Thandi", 30, 90, "take_back")).toMatch(/owe the club 1 hour/);
    expect(desk.confirmConsequence("Thandi", 300, 90, "take_back")).not.toMatch(/owe/);
  });
});

describe("L6-11 — a saving is worded one way", () => {
  it("the desk's badge and the console's preview share the words", () => {
    expect(savesWords("R50.00", 8)).toBe("Saves R50.00 (8%)");
    expect(desk.SELL_COPY.saving("R50.00", 8)).toBe(savesWords("R50.00", 8));
    expect(PACKAGES_COPY.previewSaves(50, 8, "One hour")).toMatch(/^Saves R\s?50\.00 \(8%\) against One hour\.$/);
  });
});

describe("L6-12 — the access tab says what it holds", () => {
  it("does not promise biometrics while fingerprints are switched off", () => {
    const access = MEMBER_TABS.find((t) => t.path === "access")!;
    expect(FEATURES.fingerprintEnrolment).toBe(false);
    expect(access.label).not.toMatch(/biometric/i);
  });
});

describe("L6-15 — a refused scan's reason in words", () => {
  it("never shows the raw refusal code", () => {
    expect(faultDetail("out_of_hours", undefined)).not.toMatch(/_/);
    expect(faultDetail("insufficient_balance", undefined)).not.toMatch(/_/);
    expect(faultDetail("no_booking", undefined)).not.toMatch(/_/);
    const row = { code: "walkup_refused", headline: "A walk-up purchase at the box was refused", detail: "out_of_hours" };
    expect(explainFault(row).unrecognised).toBe(false);
  });
});
