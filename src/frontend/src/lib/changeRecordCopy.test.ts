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

/** Review round 3, A-8: the overdraft row carries what the member may spend beside the balance. */
describe("the overdraft row's two figures (R3 A-8)", () => {
  it("labels spendable credits 'Can spend' and pairs it before → after, like the balance", () => {
    const { changed } = presentChanges({
      area: "booking", action: "booking.overdraft_authorised",
      changes: [
        { field: "balance_credits", before: "50", after: "0" },
        { field: "spendable_credits", before: "20", after: "-30" },
      ],
    });
    expect(changed).toContainEqual({ field: "spendable_credits", label: "Can spend", before: "20.00 cr", after: "−30.00 cr" });
    expect(changed.map((c) => c.label)).toEqual(["Balance", "Can spend"]);
  });
});

/** Review round 3, A-5: a webhook added or removed is on the record, filed under settings. */
describe("a webhook added or removed (R3 A-5)", () => {
  it("lists what it sends to, which events and its name as facts, in words", () => {
    const { changed, facts } = presentChanges({
      area: "setting", action: "webhook.created",
      changes: [
        { field: "destination", before: null, after: "https://hooks.example.org" },
        { field: "event_filter", before: null, after: "*" },
        { field: "description", before: null, after: "Court lights" },
      ],
    });
    expect(changed).toEqual([]);
    expect(facts).toEqual([
      { field: "destination", label: "Sends to", value: "https://hooks.example.org" },
      { field: "event_filter", label: "Events", value: "Every event" },
      { field: "description", label: "Description", value: "Court lights" },
    ]);
  });

  it("still labels a real settings change with the Settings page's caption", () => {
    const { changed } = presentChanges({
      area: "setting", action: "settings.updated",
      changes: [{ field: "slice_minutes", before: "15", after: "30" }],
    });
    expect(changed[0].label).not.toBe("Slice minutes");
  });
});

/**
 * Review round 5, A5-3: a group edit that CLEARED a value (peak say back to "no say") was shown as
 * a fact "Peak priority — yes", which reads as the change being TO yes; and a group's top-up rate
 * was formatted as money ("R1.60") when it is a rate.
 */
describe("a group edit's cleared values and its rate (R5 A5-3)", () => {
  it("says a cleared peak say as a change to 'no say', never as a bare fact", () => {
    const { changed, facts } = presentChanges({
      area: "group", action: "group.updated",
      changes: [{ field: "peak_priority", label: "Peak priority", before: "yes", after: null }],
    });
    expect(facts).toEqual([]);
    expect(changed).toEqual([{ field: "peak_priority", label: "Peak priority", before: "yes", after: "no say" }]);
  });

  it("says a group's top-up rate as a rate, and a cleared one as the club's rate", () => {
    const { changed, facts } = presentChanges({
      area: "group", action: "group.updated",
      changes: [{ field: "credits_per_zar", label: "Credits per zar", before: "1.6", after: null }],
    });
    expect(facts).toEqual([]);
    expect(changed).toEqual([{ field: "credits_per_zar", label: "Top-up rate", before: "1.6 cr per R1", after: "the club's rate" }]);
    expect(JSON.stringify(changed)).not.toContain("R1.60");
  });

  it("keeps a NEW group's values as facts — nothing was cleared", () => {
    const { changed, facts } = presentChanges({
      area: "group", action: "group.created",
      changes: [{ field: "credits_per_zar", before: null, after: "2" }],
    });
    expect(changed).toEqual([]);
    expect(facts).toEqual([{ field: "credits_per_zar", label: "Top-up rate", value: "2 cr per R1" }]);
  });
});

/** Review round 5, A5-8: the box's hint time was on the record as "Lcd hint seconds". */
describe("every box screen setting has the Settings page's caption (R5 A5-8)", () => {
  it("labels lcd_hint_seconds in words", () => {
    const { changed } = presentChanges({
      area: "setting", action: "settings.updated",
      changes: [{ field: "lcd_hint_seconds", before: "3", after: "5" }],
    });
    expect(changed[0].label).not.toMatch(/lcd/i);
  });
});

/**
 * Review round 5, A5-2: a bulk cancel's row named nobody and listed its bookings as ids; the server
 * now sends `bookings` — one object per item — and the record says each one, a line apiece.
 */
describe("a batch's bookings, each named once (R5 A5-2)", () => {
  const ZONE = "Africa/Johannesburg";
  it("says each cancelled booking's member, court, time and what came back", () => {
    const items = [
      { booking_id: "a5604dd3-1204-4b67-bc6b-cfca1804fa4f", member_name: "Olga Smith", block_label: null, court: 2, starts_at: "2026-10-03T16:00:00Z", status: "cancelled", refund_credits: 50, penalty_credits: 0 },
      { booking_id: "b5604dd3-1204-4b67-bc6b-cfca1804fa4f", member_name: null, block_label: "Coaching", court: 3, starts_at: "2026-10-03T16:00:00Z", status: "block_lifted", refund_credits: 0, penalty_credits: 0 },
      { booking_id: "c5604dd3-1204-4b67-bc6b-cfca1804fa4f", member_name: "Ben Ng", block_label: null, court: 1, starts_at: "2026-10-03T16:30:00Z", status: "already_cancelled", refund_credits: 0, penalty_credits: 0 },
    ];
    const { facts } = presentChanges({
      area: "booking", action: "bookings.bulk_cancelled",
      changes: [
        { field: "bookings", label: "Bookings", before: null, after: items.map((i) => JSON.stringify(i)).join(", ") },
        { field: "booking_ids", label: "Booking ids", before: null, after: items.map((i) => i.booking_id).join(", ") },
        { field: "total_refunded_credits", label: "Total refunded credits", before: null, after: "50.00" },
      ],
    }, ZONE);
    const bookings = facts.find((f) => f.field === "bookings")!;
    expect(bookings.label).toBe("Bookings");
    expect(bookings.value.split("\n")).toEqual([
      "Olga Smith — Court 2, Sat 3 Oct, 18:00 — cancelled, 50.00 cr back",
      "Coaching (club hold) — Court 3, Sat 3 Oct, 18:00 — hold lifted",
      "Ben Ng — Court 1, Sat 3 Oct, 18:30 — already cancelled",
    ]);
    expect(facts.map((f) => f.value).join(" ")).not.toMatch(/a5604dd3|booking_id|\{/);
    expect(facts.find((f) => f.field === "total_refunded_credits")).toEqual({ field: "total_refunded_credits", label: "Refunded in all", value: "50.00 cr" });
  });

  it("says each booking of a bulk book, and a refused one with its reason", () => {
    const items = [
      { index: 0, booking_id: "a5604dd3-1204-4b67-bc6b-cfca1804fa4f", court: 2, starts_at: "2026-10-03T16:00:00Z", status: "booked", error: null, amount_credits: 50 },
      { index: 1, booking_id: null, court: 2, starts_at: "2026-10-03T16:15:00Z", status: "refused", error: "slot_taken", amount_credits: 0 },
    ];
    const { facts } = presentChanges({
      area: "booking", action: "bookings.bulk_booked",
      changes: [{ field: "bookings", before: null, after: items.map((i) => JSON.stringify(i)).join(", ") }],
    }, ZONE);
    expect(facts[0].value.split("\n")).toEqual([
      "Court 2, Sat 3 Oct, 18:00 — booked, 50.00 cr",
      "Court 2, Sat 3 Oct, 18:15 — not booked (Slot taken)",
    ]);
  });
});
