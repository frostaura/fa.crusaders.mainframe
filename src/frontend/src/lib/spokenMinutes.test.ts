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
import { relative } from "./deviceLiveness";
import { SETTINGS, describeSetting, resolve } from "./settingsSchema";

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
    said(wallet.plainMovementSentence(-45, "booking_charge"));
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

/**
 * R8 J8-4 / X8-6: the R6/R7 scan read `lib/*Copy.ts` only, and compact units went on reaching
 * the screen and the screen reader from everywhere else — the settings captions ("Allowed:
 * 5–240 min."), a help line ("e.g. 30 min"), the header's freshness ("Updated 10s ago", an
 * `Intl.RelativeTimeFormat` in its narrow style) and every device age ("heard 8h ago", "last seen
 * 9m ago", read aloud as "eight aitch ago"). The rule is not about which file a line is written
 * in, so the scan now reads every source module that can draw text.
 */
const SRC = join(__dirname, "..");

/** A unit typed beside a number or an interpolation (JS `${n}` or JSX `{n}`): "30 min", `${h} h`. */
const COMPACT_UNIT_ANYWHERE = /(\d|\$?\{[^}]*\})([ \u00a0]|-)(min|h|d)(?![-=\w])/;
/**
 * R9 X9-4: a unit GLUED to its number — `${minutes}m`, `${hours}h`, "1h 04m" — slipped every scan
 * above, which wanted a space or a hyphen before the unit: the Night's burst said "4 in 1m" and its
 * gaps "1h 04m — nothing recorded", read aloud as letters.
 */
const GLUED_UNIT = /\$\{[^}]*\}(m|h|d|min)(?![\w-])|\b\d+h \d+m\b/;
/** A compact relative age: "12s ago", `${n}m ago`. */
const COMPACT_AGO = /(\d|\$?\{[^}]*\})[smhd] ago/;
/** The narrow and short `Intl.RelativeTimeFormat` styles print "10s ago" / "10 sec. ago". */
const ABBREVIATING_FORMAT = /RelativeTimeFormat\([^)]*(narrow|short)/;

/**
 * The figure formatters that may write the compact form — each one draws a standalone figure
 * that sits beside a spoken twin, never a sentence. Exempt by name so the exemption dies with
 * the function. `pages/dev/` is the primitives gallery, built only in development
 * (`import.meta.env.DEV` in App.tsx), and is not scanned.
 */
const FIGURE_FORMATTERS = [
  { file: "lib/playCopy.ts", fn: "hoursAndMinutes" },
  { file: "lib/minutes.ts", fn: "compactMagnitude" },
  { file: "lib/utils.ts", fn: "formatMinutes" },
  // The door's ticking face ("14m 03s"); DecisionCard says the same instant through
  // `spokenCountdown` in its live region (R9 X9-4 found it once the scan caught glued units).
  { file: "lib/countdown.ts", fn: "formatCountdown" },
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return ["test", "dev", "__tests__"].includes(entry.name) ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function drawnCode(path: string): string {
  const file = relative_(path);
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  let code = readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, lead: string) => lead + blank(m.slice(lead.length)));
  for (const { file: f, fn } of FIGURE_FORMATTERS) {
    if (f === file) code = code.replace(new RegExp(`(export )?function ${fn}\\([\\s\\S]*?\\n\\}`), blank);
  }
  return code;
}

const relative_ = (path: string) => path.slice(SRC.length + 1).split("\\").join("/");

describe("R8 J8-4 / X8-6 — spoken units in every module that draws text", () => {
  it("no source module writes a compact unit, a compact age or an abbreviating relative format", () => {
    const offenders = sourceFiles(SRC).flatMap((path) =>
      drawnCode(path)
        .split("\n")
        .map((line, i) => ({ line, at: `${relative_(path)}:${i + 1}` }))
        .filter(({ line }) => COMPACT_UNIT_ANYWHERE.test(line) || COMPACT_AGO.test(line) || ABBREVIATING_FORMAT.test(line)
          || GLUED_UNIT.test(line))
        .map(({ line, at }) => `${at}  ${line.trim()}`),
    );
    expect(offenders).toEqual([]);
  });

  it("catches a unit glued to its number, the way the Night's burst and gap were built (R9 X9-4)", () => {
    for (const line of ["return `${minutes}m`;", "`${hours}h ${String(rest).padStart(2, \"0\")}m`", "\"1h 04m\"", "`${n}d`"]) {
      expect(GLUED_UNIT.test(line), line).toBe(true);
    }
    for (const line of ["className=\"h-4 w-4\"", "const m = 3;", "`${id}-menu`", "\"md\"", "`${count}ms`", "rgb(var(--x))", "{ value: \"24h\" }", "getContext(\"2d\")"]) {
      expect(GLUED_UNIT.test(line), line).toBe(false);
    }
  });

  it("the exempt figure formatters still exist, so the exemption cannot outlive them", () => {
    for (const { file, fn } of FIGURE_FORMATTERS) {
      expect(readFileSync(join(SRC, file), "utf8"), `${file} ${fn}`).toMatch(new RegExp(`function ${fn}\\(`));
    }
  });

  it("a device's age is said in words (X8-6)", () => {
    const at = Date.parse("2026-10-03T12:00:00Z");
    const ago = (ms: number) => relative(new Date(at - ms).toISOString(), at);
    expect(ago(12_000)).toBe("12 seconds ago");
    expect(ago(1_000)).toBe("1 second ago");
    expect(ago(9 * 60_000)).toBe("9 minutes ago");
    expect(ago(60_000)).toBe("1 minute ago");
    expect(ago(8 * 3_600_000)).toBe("8 hours ago");
    expect(ago(86_400_000)).toBe("1 day ago");
    expect(relative(null, at)).toBe("never");
  });

  it("every settings caption states its range in spoken units (J8-4)", () => {
    // Every help line is resolved against the defaults, as the page draws it before an edit.
    const defaults = Object.fromEntries(SETTINGS.map((def) => [def.key, def.defaultValue]));
    const context = { settings: defaults as unknown as AdminSettings, currency: "R" };
    for (const def of SETTINGS) {
      said(describeSetting(def, "R"));
      said(resolve(def.help, context) ?? "");
    }
    const slice = SETTINGS.find((def) => def.key === "slice_minutes")!;
    expect(describeSetting(slice, "R")).toMatch(/Allowed: 5–240 minutes\.$/);
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
