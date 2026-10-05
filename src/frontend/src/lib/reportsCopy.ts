import { clubCurrencySymbol } from "./currency";
import { formatMoney } from "./utils";

/**
 * The club's report (`/admin/reports`) in words, since P13 made minutes the club's unit.
 *
 * <p>
 * The club sells minutes in packages and members spend them on court time, so the page has
 * two units and says which is which every time: <b>rand</b> is what members paid (from the
 * purchase rows), <b>minutes</b> is what those payments became and what the courts used. A
 * figure that is minutes never carries a currency symbol; a figure that is rand always does
 * (contract §6). Tests query these constants, so a rewording is one edit here.
 * </p>
 */
export const CLUB_REPORT_COPY = {
  title: "Reports",
  description: "The club's money, minutes, courts and attendance, for any period.",
  refreshFailed: "Couldn't refresh these figures — they are from the last read. Try Refresh again.",
  action: "load the club's reports",
  tilesLabel: "This period at a glance",
  tiles: {
    received: "Rand received (net)",
    sold: "Minutes sold (net)",
    perHour: "Rand per hour sold",
    noShows: "No-show rate",
  },
  /** `zar_per_minute_sold` is null when no minutes were sold (net ≤ 0): a dash, never "R0.00". */
  noRate: "—",
  sales: {
    title: "Sales",
    description: "What members paid for minutes in this period, and the minutes it bought them.",
    receivedGross: "Rand received",
    receivedReversed: "Rand reversed",
    receivedNet: "Rand received (net)",
    soldGross: "Minutes sold",
    soldReversed: "Minutes reversed",
    soldNet: "Minutes sold (net)",
    perHour: "Per hour sold",
    perMinute: "Per minute sold",
    footnote: "Rand is what members paid — through PayFast and at the desk. Minutes are what those packages "
      + "added to their wallets. A reversal is a payment clawed back after the fact. The price per hour is the "
      + "net rand over the net minutes sold, so a group discount or a bigger package lowers it.",
    /** R13 J13-2 — free packages the desk gave are not sales: said apart, never counted as sold. */
    givenNote: (minutes: string) => `The club also gave ${minutes} in free packages — not counted as sold.`,
  },
  totals: {
    title: "Club minutes — totals",
    description: "Every movement of members' minutes across the club in this period.",
    /** R14 J14-2 — paid minutes only: what the club gave is Given, beside it. */
    sold: "Sold",
    given: "Given",
    charges: "Bookings",
    refunds: "Refunds (net)",
    penalties: "Penalties (net)",
    adjustments: "Adjustments",
    reversals: "Reversals",
    courtsPlayed: "Courts played",
    noShows: "No-shows",
    days: "Days",
    /** The sentence under the card; `net` is the figure, already rendered. */
    netLead: "Members' minutes moved by",
    /** With a Given figure on the card, the sum names it too (R14 J14-2). */
    netTail: (given: boolean) => `over this period — sold ${given ? "+ given " : ""}− bookings + refunds − penalties + adjustments `
      + "+ reversals, which is every ledger movement in the club summed.",
    givenNote: "is free packages the desk handed over — never counted as sold;",
    adjustmentsNote: "is what the desk added or took back by hand;",
    reversalsNote: "is a payment clawed back after the fact.",
  },
  charts: {
    title: "Charts",
    sold: "Minutes sold over time",
    flow: "Daily minutes flow",
    bookings: "Bookings & no-shows",
    courts: "Minutes kept by court",
    shows: "Show rate",
  },
  utilisation: {
    title: "Utilisation by court",
    label: "Utilisation, one row per court",
    filter: "Filter by court name…",
    empty: "No bookings in this window.",
    court: "Court",
    bookings: "Bookings",
    booked: "Booked",
    charged: "Charged",
    kept: "Kept",
    note: {
      charged: "is the minutes the bookings cost when they were made — a booking costs its playing time.",
      kept: "is what the club actually kept once refunds, penalties and any desk adjustments naming the booking "
        + "are netted — for a no-show that is the penalty, not the booking.",
    },
  },
  daily: {
    title: "Daily breakdown",
    label: "Daily breakdown, one row per day",
    empty: "No activity in this window.",
    date: "Date",
    sold: "Sold",
    given: "Given",
    charges: "Bookings",
    refunds: "Refunds (net)",
    penalties: "Penalties (net)",
    adjustments: "Adjustments",
    reversals: "Reversals",
    courtsPlayed: "Courts played",
    noShows: "No-shows",
    netWhat: "Refunds, penalties, adjustments and reversals",
  },
  courts: (n: number) => `${n} court${n === 1 ? "" : "s"}`,
  days: (n: number) => `${n} day${n === 1 ? "" : "s"}`,
} as const;

/**
 * Rand per HOUR sold, from the server's rand per minute (`zar_per_minute_sold`, 4 dp, rounded
 * down). An hour is the figure a club prices in ("R110 an hour"); a per-minute figure in cents
 * reads as R1.83 and hides the third and fourth places the server kept.
 */
export function randPerHour(zarPerMinute: number | null | undefined): string {
  if (typeof zarPerMinute !== "number" || !Number.isFinite(zarPerMinute)) return CLUB_REPORT_COPY.noRate;
  return formatMoney(zarPerMinute * 60);
}

/** The server's per-minute figure as sent — all four places, with the club's symbol. */
export function randPerMinute(zarPerMinute: number | null | undefined): string {
  if (typeof zarPerMinute !== "number" || !Number.isFinite(zarPerMinute)) return CLUB_REPORT_COPY.noRate;
  return `${clubCurrencySymbol()}${zarPerMinute.toFixed(4)}`;
}
