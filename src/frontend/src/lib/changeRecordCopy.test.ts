import { describe, expect, it } from "vitest";
import { presentChanges } from "./changeRecordCopy";

/**
 * Review round 2, F3-7 — the rows the reviewer opened, as the server sends them today, and what
 * a volunteer must read instead.
 */
describe("the change record in words", () => {
  it("says a membership decision in the Members page's words", () => {
    const { changed } = presentChanges({
      area: "member", action: "member.rejected",
      changes: [{ field: "status", label: "Status", before: "pending_approval", after: "rejected" }],
    });
    expect(changed).toEqual([{ field: "status", label: "Status", before: "Awaiting approval", after: "Turned down" }]);
  });

  it("formats a desk top-up's money, names its reason and hides the ledger id", () => {
    const { changed, facts } = presentChanges({
      area: "credit", action: "credit.topped_up",
      changes: [
        { field: "entry_id", label: "Entry id", before: null, after: "ce45e706-b3ee-458e-abe2-8b69d932be6f" },
        { field: "reason_code", label: "Reason code", before: null, after: "top_up_cash" },
        { field: "zar_received", label: "Zar received", before: null, after: "125.5" },
        { field: "amount_credits", label: "Amount credits", before: null, after: "200" },
        { field: "balance_credits", label: "Balance credits", before: "0.0", after: "200.00" },
      ],
    });
    expect(changed).toEqual([{ field: "balance_credits", label: "Balance", before: "0.00 cr", after: "200.00 cr" }]);
    expect(facts.map((f) => `${f.label}: ${f.value}`)).toEqual([
      "Reason: Cash paid at the desk", "Money received: R125.50", "Amount: 200.00 cr",
    ]);
    expect(JSON.stringify({ changed, facts })).not.toMatch(/ce45e706|top_up_cash|125\.5"|Zar/);
  });

  it("joins a collection's balance pair into one row the right way round, and lists its facts as facts", () => {
    const { changed, facts } = presentChanges({
      area: "booking", action: "players.share_collected",
      changes: [
        { field: "collected_credits", label: "Collected credits", before: null, after: "100.00" },
        { field: "balance_after_credits", label: "Balance after credits", before: null, after: "-100.00" },
        { field: "balance_before_credits", label: "Balance before credits", before: null, after: "0.00" },
        { field: "seat", label: "Seat", before: "2", after: null },
        { field: "booking_id", label: "Booking id", before: "a5604dd3-1204-4b67-bc6b-cfca1804fa4f", after: null },
        { field: "participant_id", label: "Participant id", before: "1efc8f32-2aae-46d5-87a4-808a5818e8de", after: null },
      ],
    });
    expect(changed).toEqual([{ field: "balance_credits", label: "Balance", before: "0.00 cr", after: "−100.00 cr" }]);
    expect(facts).toEqual([
      { field: "collected_credits", label: "Collected", value: "100.00 cr" },
      { field: "seat", label: "Seat", value: "2" },
    ]);
  });

  it("names a repeating booking's fields instead of printing its keys", () => {
    const { changed } = presentChanges({
      area: "schedule", action: "schedule.updated_future",
      changes: [
        { field: "end_minute", label: "End", before: "21:00", after: "21:30" },
        { field: "days_of_week", label: "Days of week", before: "Tue", after: "Tue, Thu" },
      ],
    });
    expect(changed.map((c) => c.label)).toEqual(["Ends", "Days"]);
  });
});

/** Review round 3, A-7: raw UTC instants, ISO dates and bare counts reached the page. */
describe("times, dates and counts in the club's words (R3 A-7)", () => {
  const row = (changes: Array<{ field: string; before?: string | null; after?: string | null }>) =>
    presentChanges({ area: "booking", action: "booking.admin_created", changes }, "Africa/Johannesburg");

  it("says an instant in the club's day and clock, and a date as the club's short date", () => {
    const { facts } = row([
      { field: "starts_at", after: "2026-09-30T16:00:00+00:00" },
      { field: "occurrence_date", after: "2026-10-04" },
    ]);
    expect(facts).toEqual([
      { field: "starts_at", label: "Starts", value: "Wed 30 Sep, 18:00" },
      { field: "occurrence_date", label: "Date", value: "Sun 4 Oct" },
    ]);
  });

  it("says a length in minutes and a repeat in weeks", () => {
    const { facts, changed } = row([
      { field: "minutes", after: "15" },
      { field: "interval_weeks", before: "1", after: "2" },
      { field: "start_date", after: "2026-09-30" },
    ]);
    expect(facts).toContainEqual({ field: "minutes", label: "Length", value: "15 minutes" });
    expect(facts).toContainEqual({ field: "start_date", label: "First date", value: "Wed 30 Sep" });
    expect(changed).toContainEqual({ field: "interval_weeks", label: "Repeats", before: "Every week", after: "Every 2 weeks" });
    expect(JSON.stringify({ facts, changed })).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});
