import { describe, expect, it } from "vitest";
import type { LedgerRow } from "./api";
import { csvLine, csvNumber, csvText, ledgerCsv } from "./csvExport";

/** FA-7 / BA-08: the console's CSVs keep the API's conventions (CsvCell.Of / Line). */

describe("a CSV cell", () => {
  it("defuses a formula, quotes a comma, a quote or a line break, and leaves plain text alone", () => {
    expect(csvText("=HYPERLINK(\"x\")")).toBe("\"'=HYPERLINK(\"\"x\"\")\"");
    expect(csvText("+27 82")).toBe("'+27 82");
    expect(csvText("@me")).toBe("'@me");
    expect(csvText("Smith, Ann")).toBe("\"Smith, Ann\"");
    expect(csvText("line\nbreak")).toBe("\"line\nbreak\"");
    expect(csvText("Ada Lovelace")).toBe("Ada Lovelace");
    expect(csvText(null)).toBe("");
  });

  it("writes a signed minute figure as a number a spreadsheet can sum, never defused", () => {
    expect(csvNumber(-30)).toBe("-30");
    expect(csvNumber(45)).toBe("45");
    expect(csvNumber(Number.NaN)).toBe("");
    expect(csvLine([{ number: -30 }, { text: "-30" }])).toBe("-30,'-30\r\n");
  });
});

describe("the ledger CSV", () => {
  const row = (extra: Partial<LedgerRow>): LedgerRow => ({
    id: "r1", at: "2026-11-13T18:00:00Z", from: "member", to: "club", amountMinutes: 30, signedAmountMinutes: -30,
    type: "BookingCharge", comment: "Court 2", subjectUserId: "u1", subjectName: "Ada Lovelace", actorUserId: "u1",
    actorName: "Ada Lovelace", relatedBookingId: "b1", ...extra,
  } as LedgerRow);

  it("has a header and one CRLF line per movement, in whole signed minutes", () => {
    const text = ledgerCsv([row({}), row({ id: "r2", signedAmountMinutes: 60, amountMinutes: 60, type: "TopUp", comment: "=1+1" })]);
    const lines = text.split("\r\n");
    expect(lines[0]).toBe("When (UTC),Type,Minutes,Member,By,Reason,From,To,Booking,Movement id");
    expect(lines[1]).toBe("2026-11-13T18:00:00Z,BookingCharge,-30,Ada Lovelace,Ada Lovelace,Court 2,member,club,b1,r1");
    expect(lines[2]).toContain(",60,");
    expect(lines[2]).toContain(",'=1+1,");
    expect(text.endsWith("\r\n")).toBe(true);
    expect(text).not.toMatch(/credit/i);
  });
});

describe("the report CSVs", () => {
  it("writes one row per day in whole minutes, absent figures empty, never a decimal", async () => {
    const { dailyCsv } = await import("./csvExport");
    const text = dailyCsv([{
      date: "2026-11-13", top_ups_minutes: 600, booking_charges_minutes: -240, refunds_minutes: 30, penalties_minutes: -15,
      adjustments_minutes: 0, reversals_minutes: 0, net_movement_minutes: 375, bookings: 8, no_shows: 1,
    }]);
    const [head, line] = text.split("\r\n");
    expect(head.split(",")).toHaveLength(12);
    expect(line).toBe("2026-11-13,600,,-240,30,-15,0,0,,375,8,1");
  });

  it("writes one row per court, a comma in a court's name quoted", async () => {
    const { courtsCsv } = await import("./csvExport");
    const text = courtsCsv([{ court_id: "c1", court_number: 1, court_name: "Court 1, glass", slices: 12, booked_minutes: 180, bookings: 4, kept_minutes: 120, sold_minutes: 180 }]);
    expect(text.split("\r\n")[1]).toBe("1,\"Court 1, glass\",4,180,180,120,12");
  });
});
