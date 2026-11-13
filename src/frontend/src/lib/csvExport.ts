import { ledgerPage, type LedgerFilters } from "./adminPaging";
import type { DailyAdminPoint, LedgerRow, UtilisationRow } from "./api";

/**
 * Exports built in the console from the same reads the screen makes (FA-7, BA-08): the
 * Transactions ledger and the Reports figures, as CSV a treasurer can reconcile outside the app.
 *
 * <p>
 * <b>The server's conventions, mirrored.</b> A text cell that a spreadsheet would read as a
 * formula (`=`, `+`, `-`, `@`) is defused with a leading `'`, a cell holding a comma, a quote or a
 * line break is quoted with its quotes doubled, and every line ends CRLF — `CsvCell.Of`/`Line` on
 * the API, so a file from here and one from the server read the same. Numbers are written as
 * numbers: a signed minute figure is data, not a formula, and defusing `-30` would turn it into
 * text nobody can sum.
 * </p>
 */

const FORMULA_STARTERS = "=+-@";

/** One text cell, safe to join into a CSV line. */
export function csvText(value: string | null | undefined): string {
  const raw = value ?? "";
  const safe = raw.length > 0 && FORMULA_STARTERS.includes(raw[0]) ? `'${raw}` : raw;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll("\"", "\"\"")}"` : safe;
}

/** One number cell: an integer as itself, anything else empty. */
export function csvNumber(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(Math.trunc(value)) : "";
}

export type CsvCell = { text: string | null | undefined } | { number: number | null | undefined };

/** One CRLF-terminated line. */
export function csvLine(cells: readonly CsvCell[]): string {
  return `${cells.map((c) => ("number" in c ? csvNumber(c.number) : csvText(c.text))).join(",")}\r\n`;
}

export const LEDGER_CSV_HEADER = [
  "When (UTC)", "Type", "Minutes", "Member", "By", "Reason", "From", "To", "Booking", "Movement id",
] as const;

/** The ledger rows as a CSV, header first. Minutes are signed whole minutes (P13: never a fraction). */
export function ledgerCsv(rows: readonly LedgerRow[]): string {
  const head = csvLine(LEDGER_CSV_HEADER.map((text) => ({ text })));
  return head + rows.map((r) => csvLine([
    { text: r.at }, { text: r.type }, { number: r.signedAmountMinutes }, { text: r.subjectName },
    { text: r.actor_name ?? r.actorName }, { text: r.comment }, { text: r.from }, { text: r.to },
    { text: r.relatedBookingId }, { text: r.id },
  ])).join("");
}

/** At most this many movements in one export; past it the file says it is cut. */
export const LEDGER_EXPORT_CAP = 50_000;

/**
 * Every movement the filters select, a page at a time to the end (or the cap), then the name
 * search the screen applies on top — so the file holds exactly what the page would show if every
 * row were on it.
 */
export async function readLedgerForExport(
  filters: LedgerFilters, keep: (row: LedgerRow) => boolean,
): Promise<{ rows: LedgerRow[]; truncated: boolean }> {
  const rows: LedgerRow[] = [];
  let cursor: string | null = "";
  while (cursor !== null && rows.length < LEDGER_EXPORT_CAP) {
    const page = await ledgerPage(filters, cursor, 500);
    rows.push(...page.items);
    cursor = page.next_cursor;
  }
  return { rows: rows.filter(keep), truncated: cursor !== null };
}

/** A CSV text as a file the browser can save. */
export function csvBlob(text: string): Blob {
  // A BOM so a spreadsheet opens a name with an accent as the name, not as mojibake.
  return new Blob(["﻿", text], { type: "text/csv;charset=utf-8" });
}

export const DAILY_CSV_HEADER = [
  "Date", "Minutes bought", "Of which given", "Booking charges", "Refunds", "Penalties", "Adjustments", "Reversals",
  "Share transfers", "Net movement", "Bookings", "No-shows",
] as const;

/** Reports › the day-by-day breakdown, one row per club day, in whole minutes (FA-7). */
export function dailyCsv(days: readonly DailyAdminPoint[]): string {
  return csvLine(DAILY_CSV_HEADER.map((text) => ({ text }))) + days.map((d) => csvLine([
    { text: d.date }, { number: d.top_ups_minutes }, { number: d.given_minutes ?? null }, { number: d.booking_charges_minutes },
    { number: d.refunds_minutes }, { number: d.penalties_minutes }, { number: d.adjustments_minutes }, { number: d.reversals_minutes },
    { number: d.share_transfers_minutes ?? null }, { number: d.net_movement_minutes }, { number: d.bookings }, { number: d.no_shows },
  ])).join("");
}

export const COURTS_CSV_HEADER = ["Court number", "Court", "Bookings", "Booked minutes", "Sold minutes", "Kept minutes", "Slices"] as const;

/** Reports › court utilisation, one row per court (FA-7). */
export function courtsCsv(rows: readonly UtilisationRow[]): string {
  return csvLine(COURTS_CSV_HEADER.map((text) => ({ text }))) + rows.map((r) => csvLine([
    { number: r.court_number }, { text: r.court_name }, { number: r.bookings }, { number: r.booked_minutes },
    { number: r.sold_minutes }, { number: r.kept_minutes }, { number: r.slices },
  ])).join("");
}
