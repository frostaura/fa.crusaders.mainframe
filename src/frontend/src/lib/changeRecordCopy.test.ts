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

  it("says a desk sale's minutes and money, names its reason and hides the ledger id", () => {
    const { changed, facts } = presentChanges({
      area: "credit", action: "credit.topped_up",
      changes: [
        { field: "entry_id", label: "Entry id", before: null, after: "ce45e706-b3ee-458e-abe2-8b69d932be6f" },
        { field: "reason_code", label: "Reason code", before: null, after: "top_up_cash" },
        { field: "zar_received", label: "Zar received", before: null, after: "125.5" },
        // What `AdminChangeDiff.Number` prints for a `*_minutes` figure.
        { field: "amount_minutes", label: "Amount minutes", before: null, after: "300 minutes" },
        { field: "balance_minutes", label: "Balance minutes", before: "0 minutes", after: "300 minutes" },
      ],
    });
    expect(changed).toEqual([{ field: "balance_minutes", label: "Balance", before: "0 minutes", after: "5 hours" }]);
    expect(facts.map((f) => `${f.label}: ${f.value}`)).toEqual([
      "Reason: Cash paid at the desk", "Money received: R125.50", "Amount: 5 hours",
    ]);
    expect(JSON.stringify({ changed, facts })).not.toMatch(/ce45e706|top_up_cash|125\.5"|Zar|\.00|cr\b/);
  });

  it("joins a collection's balance pair into one row the right way round, and lists its facts as facts", () => {
    const { changed, facts } = presentChanges({
      area: "booking", action: "players.share_collected",
      changes: [
        { field: "collected_minutes", label: "Collected minutes", before: null, after: "100 minutes" },
        { field: "balance_after_minutes", label: "Balance after minutes", before: null, after: "-100 minutes" },
        { field: "balance_before_minutes", label: "Balance before minutes", before: null, after: "0 minutes" },
        { field: "seat", label: "Seat", before: "2", after: null },
        { field: "booking_id", label: "Booking id", before: "a5604dd3-1204-4b67-bc6b-cfca1804fa4f", after: null },
        { field: "participant_id", label: "Participant id", before: "1efc8f32-2aae-46d5-87a4-808a5818e8de", after: null },
      ],
    });
    expect(changed).toEqual([{ field: "balance_minutes", label: "Balance", before: "0 minutes", after: "minus 1 hour 40 minutes" }]);
    expect(facts).toEqual([
      { field: "collected_minutes", label: "Collected", value: "1 hour 40 minutes" },
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
  it("labels spendable minutes 'Can spend' and pairs it before → after, like the balance", () => {
    const { changed } = presentChanges({
      area: "booking", action: "booking.overdraft_authorised",
      changes: [
        { field: "balance_minutes", before: "50 minutes", after: "0 minutes" },
        { field: "spendable_minutes", before: "20 minutes", after: "-30 minutes" },
      ],
    });
    expect(changed).toContainEqual({ field: "spendable_minutes", label: "Can spend", before: "20 minutes", after: "minus 30 minutes" });
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

  /** P13 §3.8: "no say → 10%", in the console's words — never "Package discount bps 1000". */
  it("says a group's package discount as a percentage off, and a cleared one as 'no say'", () => {
    const { changed, facts } = presentChanges({
      area: "group", action: "group.updated",
      changes: [
        { field: "package_discount_bps", label: "Package discount bps", before: null, after: "1000" },
        { field: "max_slots_per_day", label: "Max slots per day", before: "2", after: "3" },
      ],
    });
    expect(facts).toEqual([]);
    expect(changed).toContainEqual({ field: "package_discount_bps", label: "Package discount", before: "no say", after: "10% off packages" });
    const cleared = presentChanges({
      area: "group", action: "group.updated",
      changes: [{ field: "package_discount_bps", before: "1250", after: null }],
    });
    expect(cleared.changed).toEqual([{ field: "package_discount_bps", label: "Package discount", before: "12.5% off packages", after: "no say" }]);
  });

  it("keeps a NEW group's values as facts — nothing was cleared", () => {
    const { changed, facts } = presentChanges({
      area: "group", action: "group.created",
      changes: [{ field: "package_discount_bps", before: null, after: "0" }],
    });
    expect(changed).toEqual([]);
    expect(facts).toEqual([{ field: "package_discount_bps", label: "Package discount", value: "0% off packages" }]);
  });

  /**
   * The record is append-only and outlives the P13 money reset (contract §2.5): a row written
   * before minutes still reads in words, said as history, its figures bare — no retired unit.
   */
  it("still reads an old row's retired rate and balance, as history, without the old unit", () => {
    const { changed } = presentChanges({
      area: "group", action: "group.updated",
      changes: [{ field: "credits_per_zar", label: "Credits per zar", before: "1.6", after: null }],
    });
    expect(changed).toEqual([{ field: "credits_per_zar", label: "Top-up rate (retired)", before: "1.6 per R1", after: "the club's rate" }]);
    const old = presentChanges({
      area: "credit", action: "credit.adjusted",
      changes: [{ field: "balance_credits", label: "Balance credits", before: "0.0", after: "200.00" }],
    });
    expect(old.changed).toEqual([{ field: "balance_credits", label: "Balance (before minutes)", before: "0", after: "200" }]);
    expect(JSON.stringify([changed, old])).not.toMatch(/\bcr\b|R1\.60/);
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
      { booking_id: "a5604dd3-1204-4b67-bc6b-cfca1804fa4f", member_name: "Olga Smith", block_label: null, court: 2, starts_at: "2026-10-03T16:00:00Z", status: "cancelled", refund_minutes: 50, penalty_minutes: 0 },
      { booking_id: "b5604dd3-1204-4b67-bc6b-cfca1804fa4f", member_name: null, block_label: "Coaching", court: 3, starts_at: "2026-10-03T16:00:00Z", status: "block_lifted", refund_minutes: 0, penalty_minutes: 0 },
      { booking_id: "c5604dd3-1204-4b67-bc6b-cfca1804fa4f", member_name: "Ben Ng", block_label: null, court: 1, starts_at: "2026-10-03T16:30:00Z", status: "already_cancelled", refund_minutes: 0, penalty_minutes: 0 },
    ];
    const { facts } = presentChanges({
      area: "booking", action: "bookings.bulk_cancelled",
      changes: [
        { field: "bookings", label: "Bookings", before: null, after: items.map((i) => JSON.stringify(i)).join(", ") },
        { field: "booking_ids", label: "Booking ids", before: null, after: items.map((i) => i.booking_id).join(", ") },
        { field: "total_refunded_minutes", label: "Total refunded minutes", before: null, after: "50 minutes" },
      ],
    }, ZONE);
    const bookings = facts.find((f) => f.field === "bookings")!;
    expect(bookings.label).toBe("Bookings");
    expect(bookings.value.split("\n")).toEqual([
      "Olga Smith — Court 2, Sat 3 Oct, 18:00 — cancelled, 50 minutes back",
      "Coaching (club hold) — Court 3, Sat 3 Oct, 18:00 — hold lifted",
      "Ben Ng — Court 1, Sat 3 Oct, 18:30 — already cancelled",
    ]);
    expect(facts.map((f) => f.value).join(" ")).not.toMatch(/a5604dd3|booking_id|\{/);
    expect(facts.find((f) => f.field === "total_refunded_minutes")).toEqual({ field: "total_refunded_minutes", label: "Refunded in all", value: "50 minutes" });
  });

  it("says each booking of a bulk book, and a refused one with its reason", () => {
    const items = [
      { index: 0, booking_id: "a5604dd3-1204-4b67-bc6b-cfca1804fa4f", court: 2, starts_at: "2026-10-03T16:00:00Z", status: "booked", error: null, amount_minutes: 50 },
      { index: 1, booking_id: null, court: 2, starts_at: "2026-10-03T16:15:00Z", status: "refused", error: "slot_taken", amount_minutes: 0 },
    ];
    const { facts } = presentChanges({
      area: "booking", action: "bookings.bulk_booked",
      changes: [{ field: "bookings", before: null, after: items.map((i) => JSON.stringify(i)).join(", ") }],
    }, ZONE);
    expect(facts[0].value.split("\n")).toEqual([
      "Court 2, Sat 3 Oct, 18:00 — booked, 50 minutes",
      "Court 2, Sat 3 Oct, 18:15 — not booked (Slot taken)",
    ]);
  });
});

/** P13 §3.6, §3.9: a settings row written before the retired settings went still reads in words. */
describe("an old settings row's retired keys (P13)", () => {
  it("names each as retired and says the rate as a rate, the block and cap as money", () => {
    const { changed } = presentChanges({
      area: "setting", action: "settings.updated",
      changes: [
        { field: "credits_per_zar_regular", label: "Credits per zar regular", before: "1.6", after: "2" },
        { field: "topup_block_zar", label: "Topup block zar", before: "100", after: "50" },
        { field: "topup_max_zar_per_member", label: "Topup max zar per member", before: "1000", after: "2000" },
      ],
    });
    expect(changed).toEqual([
      { field: "credits_per_zar_regular", label: "Top-up rate for members (retired)", before: "1.6 per R1", after: "2 per R1" },
      { field: "topup_block_zar", label: "Top-up block (retired)", before: "R100.00", after: "R50.00" },
      { field: "topup_max_zar_per_member", label: "Top-up cap per member (retired)", before: "R1000.00", after: "R2000.00" },
    ]);
  });
});

/** P13 §3.5, §4.5: a minutes package's record says its minutes as an amount and its price as money. */
describe("a minutes package's record (P13)", () => {
  it("says the minutes as an amount, the price in rand and the shelf place in words", () => {
    const { changed } = presentChanges({
      area: "credit", action: "package.updated",
      changes: [
        { field: "minutes", label: "Minutes", before: "300", after: "330" },
        { field: "price_zar", label: "Price zar", before: "550.00", after: "600.00" },
        { field: "sort_order", label: "Sort order", before: "1", after: "2" },
      ],
    });
    expect(changed).toEqual([
      { field: "minutes", label: "Minutes", before: "5 hours", after: "5 hours 30 minutes" },
      { field: "price_zar", label: "Price", before: "R550.00", after: "R600.00" },
      { field: "sort_order", label: "Place on the shelf", before: "1", after: "2" },
    ]);
  });

  it("names the group a package belongs to, never its JSON", () => {
    const { facts } = presentChanges({
      area: "credit", action: "package.created",
      changes: [{ field: "group", before: null, after: "{\"id\": \"ce45e706-b3ee-458e-abe2-8b69d932be6f\", \"name\": \"League\"}" }],
    });
    expect(facts).toEqual([{ field: "group", label: "Group", value: "League" }]);
  });
});
