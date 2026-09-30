using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// GOAL items 5 and 13 — an admin ticking a list of grid cells and cancelling or booking all
/// of them.
///
/// <para>
/// <b>Postgres-backed, not in-memory, and that is not a preference.</b> The payer lock is a
/// <c>pg_advisory_xact_lock</c>, the slot race is decided by a GiST exclusion constraint, and
/// the idempotency guarantee is a filtered unique index. The EF in-memory provider has none of
/// the three, so a bulk suite written against it would prove that the loop runs and nothing
/// about whether the batch is safe.
/// </para>
/// </summary>
public sealed class AdminBulkBookingHttpTests : IClassFixture<PostgresFixture>
{
    private readonly PostgresFixture _pg;

    public AdminBulkBookingHttpTests(PostgresFixture pg) => _pg = pg;

    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";
    private const string CancelPath = "/api/v1/admin/bookings/bulk-cancel";
    private const string BookPath = "/api/v1/admin/bookings/bulk";

    private TestWebAppFactory CreateFactory() => _pg.SharedHost;

    private static List<JsonElement> Results(JsonElement body)
        => body.GetProperty("results").EnumerateArray().ToList();

    /// <summary>A booked slot belonging to this club's member, charged at the given price.</summary>
    private static async Task<Guid> SeedBookingAsync(
        TestWebAppFactory factory, DoorClub club, DateTimeOffset startsAt, decimal charged = 32m,
        Guid? userId = null)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var payer = userId ?? club.MemberUserId;
        var booking = new Booking
        {
            TenantId = club.TenantId,
            CourtId = club.CourtId,
            UserId = payer,
            BookedByUserId = payer,
            PaidByUserId = payer,
            ActorUserId = payer,
            StartsAt = startsAt.ToUniversalTime(),
            EndsAt = startsAt.AddMinutes(60).ToUniversalTime(),
            SliceMinutes = 15,
            SliceCount = 4,
            AmountChargedCredits = charged,
            Status = BookingStatus.Booked,
            ChargedAt = DateTimeOffset.UtcNow,
        };
        db.Bookings.Add(booking);
        db.LedgerEntries.Add(new LedgerEntry
        {
            TenantId = club.TenantId,
            UserId = payer,
            Type = LedgerEntryType.TopUp,
            AmountCredits = charged,
            ActorUserId = Guid.Empty,
            Reason = "fixture float",
        });
        await db.SaveChangesAsync();
        return booking.Id;
    }

    private static async Task<Guid> SeedBlockAsync(
        TestWebAppFactory factory, DoorClub club, DateTimeOffset startsAt, string label = "Maintenance")
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var block = new Booking
        {
            TenantId = club.TenantId,
            CourtId = club.CourtId,
            UserId = null,
            ActorUserId = club.AdminUserId,
            StartsAt = startsAt.ToUniversalTime(),
            EndsAt = startsAt.AddMinutes(60).ToUniversalTime(),
            SliceMinutes = 15,
            SliceCount = 4,
            AmountChargedCredits = 0m,
            Status = BookingStatus.AdminBlock,
            BlockLabel = label,
        };
        db.Bookings.Add(block);
        await db.SaveChangesAsync();
        return block.Id;
    }

    private static async Task CreditAsync(TestWebAppFactory factory, DoorClub club, Guid userId, decimal credits)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        db.LedgerEntries.Add(new LedgerEntry
        {
            TenantId = club.TenantId,
            UserId = userId,
            Type = LedgerEntryType.TopUp,
            AmountCredits = credits,
            ActorUserId = Guid.Empty,
            Reason = "fixture float",
        });
        await db.SaveChangesAsync();
    }

    private static async Task<List<LedgerEntry>> LedgerAsync(TestWebAppFactory factory, Guid tenantId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        return await db.LedgerEntries.IgnoreQueryFilters().Where(l => l.TenantId == tenantId).ToListAsync();
    }

    private static async Task<List<AdminChangeLog>> ChangeRowsAsync(TestWebAppFactory factory, Guid tenantId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        return await db.AdminChangeLogs.IgnoreQueryFilters().Where(a => a.TenantId == tenantId).ToListAsync();
    }

    // ------------------------------------------------------------------ bulk cancel

    /// <summary>
    /// The answer is a list in the order the admin sent, and it distinguishes the four
    /// outcomes.
    ///
    /// <para>
    /// The console renders this list. It must never render a bulk action as a spinner ending in
    /// a toast: a toast cannot say "2 cancelled, 1 was already gone, 1 block lifted" and stay
    /// readable, and this audience will not go looking.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task Every_ticked_row_gets_its_own_outcome_in_the_order_it_was_sent()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "bulkcan");
        var slot = DateTimeOffset.UtcNow.AddDays(3);

        var booked = await SeedBookingAsync(factory, club, slot);
        var block = await SeedBlockAsync(factory, club, slot.AddHours(2));
        var missing = Guid.NewGuid();

        var response = await club.AdminClient(factory).PostAsJsonAsync(CancelPath, new
        {
            idempotencyKey = "bc_order_1",
            reason = "League night moved to Wednesday",
            items = new[]
            {
                new { bookingId = booked },
                new { bookingId = block },
                new { bookingId = missing },
            },
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        var results = Results(body);

        Assert.Equal(3, results.Count);
        Assert.Equal(booked, results[0].GetProperty("booking_id").GetGuid());
        Assert.Equal("cancelled", results[0].GetProperty("status").GetString());
        Assert.Equal("block_lifted", results[1].GetProperty("status").GetString());
        Assert.Equal("failed", results[2].GetProperty("status").GetString());
        Assert.Equal("booking_not_found", results[2].GetProperty("error").GetString());

        Assert.Equal(3, body.GetProperty("requested").GetInt32());
        Assert.Equal(2, body.GetProperty("succeeded").GetInt32());
        Assert.Equal(1, body.GetProperty("failed").GetInt32());
    }

    /// <summary>
    /// A row that was already cancelled is a SUCCESS, not a failure.
    ///
    /// <para>
    /// <b>This is the whole reason bulk cancel needs its own outcome vocabulary.</b>
    /// <c>CancelAsync</c> answers <c>NotFound</c> for a row that is not <c>Booked</c>, so a
    /// retried batch whose first attempt half-landed would report its own successes as errors.
    /// An admin reading "6 failed" about 6 bookings they successfully cancelled forty seconds
    /// ago will cancel something else to compensate — and the something else is somebody's
    /// court.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task An_already_cancelled_row_counts_as_a_success()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "bulkagain");
        var id = await SeedBookingAsync(factory, club, DateTimeOffset.UtcNow.AddDays(3));
        var client = club.AdminClient(factory);

        var first = await client.PostAsJsonAsync(CancelPath, new
        {
            idempotencyKey = "bc_twice_1",
            reason = "Court closed",
            items = new[] { new { bookingId = id } },
        });
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);

        // A DIFFERENT key, so nothing is replayed — this is the admin pressing the button
        // again on a list they had not refreshed.
        var second = await client.PostAsJsonAsync(CancelPath, new
        {
            idempotencyKey = "bc_twice_2",
            reason = "Court closed",
            items = new[] { new { bookingId = id } },
        });

        var body = await second.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("already_cancelled", Results(body).Single().GetProperty("status").GetString());
        Assert.Equal(1, body.GetProperty("succeeded").GetInt32());
        Assert.Equal(0, body.GetProperty("failed").GetInt32());
    }

    /// <summary>
    /// A whole-batch retry under the SAME key posts no second refund.
    ///
    /// <para>
    /// Two guards, and the test would pass on either alone, which is why both are asserted:
    /// the row is already <c>Cancelled</c> so the loop never reaches <c>CancelAsync</c>, and
    /// the refund carries an <c>ExternalReference</c> the filtered unique index would refuse.
    /// Counting the ledger rows is what proves the money did not move twice.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task A_retry_under_the_same_key_refunds_once()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "bulkidem");
        var id = await SeedBookingAsync(factory, club, DateTimeOffset.UtcNow.AddDays(3), charged: 32m);
        var client = club.AdminClient(factory);

        var payload = new
        {
            idempotencyKey = "bc_retry_same",
            reason = "Power cut",
            items = new[] { new { bookingId = id } },
        };

        await client.PostAsJsonAsync(CancelPath, payload);
        await client.PostAsJsonAsync(CancelPath, payload);

        var refunds = (await LedgerAsync(factory, club.TenantId))
            .Where(l => l.Type == LedgerEntryType.CancellationRefund)
            .ToList();

        Assert.Single(refunds);
        Assert.Equal(32m, refunds[0].AmountCredits);
        Assert.StartsWith("bulkcancel:", refunds[0].ExternalReference);
        Assert.EndsWith(":refund", refunds[0].ExternalReference);
    }

    /// <summary>
    /// The totals on the envelope are the sum of the rows beneath them.
    ///
    /// <para>
    /// A console prints the total in a sentence the admin reads first — "550.00 credits
    /// refunded" — and then the list. If the two disagree, the sentence is the one that gets
    /// quoted.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task The_totals_are_the_sum_of_the_rows()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "bulktotal");
        var slot = DateTimeOffset.UtcNow.AddDays(4);
        var a = await SeedBookingAsync(factory, club, slot, charged: 32m);
        var b = await SeedBookingAsync(factory, club, slot.AddHours(3), charged: 16m);

        var response = await club.AdminClient(factory).PostAsJsonAsync(CancelPath, new
        {
            idempotencyKey = "bc_totals",
            reason = "Tournament",
            items = new[] { new { bookingId = a }, new { bookingId = b } },
        });

        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        var rows = Results(body);
        var summed = rows.Sum(r => r.GetProperty("refund_credits").GetDecimal());

        Assert.Equal(summed, body.GetProperty("total_refunded_credits").GetDecimal());
        Assert.Equal(48m, body.GetProperty("total_refunded_credits").GetDecimal());
    }

    /// <summary>
    /// Another club's booking id answers <c>booking_not_found</c> and moves no money.
    ///
    /// <para>
    /// <b>This matters more here than anywhere else in the product.</b> The member-facing
    /// <c>GET /api/v1/schedule</c> hands every member every other member's booking id, and this
    /// is the first endpoint that accepts a LIST of them. The refusal is deliberately
    /// non-committal — the same answer an invented id gets — so a caller learns nothing, not
    /// even that the id is real.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task A_foreign_clubs_booking_id_is_not_found_and_writes_no_ledger_row()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var clubA = await DoorClub.SeedAsync(factory, "bulkxta");
        var clubB = await DoorClub.SeedAsync(factory, "bulkxtb");

        var theirs = await SeedBookingAsync(factory, clubB, DateTimeOffset.UtcNow.AddDays(3), charged: 40m);
        var beforeCount = (await LedgerAsync(factory, clubB.TenantId)).Count;

        var response = await clubA.AdminClient(factory).PostAsJsonAsync(CancelPath, new
        {
            idempotencyKey = "bc_cross",
            reason = "Trying it on",
            items = new[] { new { bookingId = theirs } },
        });

        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("failed", Results(body).Single().GetProperty("status").GetString());
        Assert.Equal("booking_not_found", Results(body).Single().GetProperty("error").GetString());

        Assert.Equal(beforeCount, (await LedgerAsync(factory, clubB.TenantId)).Count);

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var untouched = await db.Bookings.IgnoreQueryFilters().FirstAsync(x => x.Id == theirs);
        Assert.Equal(BookingStatus.Booked, untouched.Status);
    }

    /// <summary>
    /// A list naming one booking twice is refused outright, with the id.
    ///
    /// <para>
    /// Silently collapsing it would hide a console bug and make the counts in the answer
    /// disagree with the list the admin sent.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task A_booking_named_twice_in_one_batch_is_refused()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "bulkdup");
        var id = await SeedBookingAsync(factory, club, DateTimeOffset.UtcNow.AddDays(3));

        var response = await club.AdminClient(factory).PostAsJsonAsync(CancelPath, new
        {
            idempotencyKey = "bc_dup",
            reason = "Twice",
            items = new[] { new { bookingId = id }, new { bookingId = id } },
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("duplicate_item", body.GetProperty("error").GetString());
        Assert.Equal(id, body.GetProperty("booking_id").GetGuid());
    }

    /// <summary>The batch's bounds, each with the figure its sentence needs.</summary>
    [SkippableTheory]
    [InlineData(null, "reason", 1, "idempotency_key_invalid")]
    [InlineData("k", null, 1, "reason_required")]
    [InlineData("k", "reason", 0, "no_items")]
    [InlineData("k", "reason", 101, "too_many_items")]
    public async Task The_batch_bounds_are_refused_with_a_stable_code(
        string? key, string? reason, int itemCount, string expected)
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "bulkbound");

        var response = await club.AdminClient(factory).PostAsJsonAsync(CancelPath, new
        {
            idempotencyKey = key,
            reason,
            items = Enumerable.Range(0, itemCount).Select(_ => new { bookingId = Guid.NewGuid() }).ToArray(),
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(expected, body.GetProperty("error").GetString());

        if (expected == "too_many_items")
        {
            Assert.Equal(BulkSettings.DefaultMaxItems, body.GetProperty("max_items").GetInt32());
        }
    }

    /// <summary>
    /// One undeletable change row per BATCH, carrying the admin's own words — not one per item.
    ///
    /// <para>
    /// The batch row is the INTENT; <c>CancelAsync</c>'s per-booking <c>audit_log</c> rows are
    /// the EFFECTS, and the night trace reads the effects. Recording the intent per item would
    /// store the same sentence forty times and still not say they were one decision.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task One_batch_writes_one_undeletable_change_row_carrying_the_reason()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "bulkrec");
        var slot = DateTimeOffset.UtcNow.AddDays(5);
        var a = await SeedBookingAsync(factory, club, slot);
        var b = await SeedBookingAsync(factory, club, slot.AddHours(2));

        await club.AdminClient(factory).PostAsJsonAsync(CancelPath, new
        {
            idempotencyKey = "bc_record",
            reason = "Burst pipe in the gallery",
            items = new[] { new { bookingId = a }, new { bookingId = b } },
        });

        var rows = await ChangeRowsAsync(factory, club.TenantId);
        var row = Assert.Single(rows);

        Assert.Equal(AdminChangeActions.BookingsBulkCancelled, row.Action);
        Assert.Equal(AdminChangeAreas.Booking, row.Area);
        Assert.Equal("Burst pipe in the gallery", row.Reason);
        Assert.Equal("Door Admin", row.ActorName);
        Assert.Contains(a.ToString(), row.AfterJson);
        Assert.Contains(b.ToString(), row.AfterJson);
    }

    // ------------------------------------------------------------------ bulk book

    /// <summary>
    /// A free-text guest becomes an admin block that charges nobody, and the answer says so.
    ///
    /// <para>
    /// A guest has no wallet, no email and no cancellation rights — which is exactly what a
    /// block already is. Putting the name in <c>BlockLabel</c> is not schema abuse:
    /// <c>BlockLabel</c> IS the label a block carries, and the grid already renders one.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task A_written_in_name_becomes_a_block_that_charges_nobody()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "bulkguest");
        var slot = new DateTimeOffset(DateTimeOffset.UtcNow.AddDays(2).Date.AddHours(10), TimeSpan.Zero);

        var response = await club.AdminClient(factory).PostAsJsonAsync(BookPath, new
        {
            idempotencyKey = "bb_guest",
            onBehalf = new { guestName = "Priya's guest" },
            items = new[] { new { courtId = club.CourtId, startsAt = slot, sliceCount = 4 } },
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        var row = Results(body).Single();

        Assert.Equal("blocked", row.GetProperty("status").GetString());
        Assert.Equal(0m, row.GetProperty("amount_credits").GetDecimal());
        Assert.Equal(JsonValueKind.Null, body.GetProperty("payer").ValueKind);

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var written = await db.Bookings.IgnoreQueryFilters()
            .FirstAsync(b => b.Id == row.GetProperty("booking_id").GetGuid());

        Assert.Equal(BookingStatus.AdminBlock, written.Status);
        Assert.Null(written.UserId);
        Assert.Equal("Priya's guest", written.BlockLabel);
        Assert.Equal(0m, written.AmountChargedCredits);
        Assert.Empty(await db.LedgerEntries.IgnoreQueryFilters()
            .Where(l => l.RelatedBookingId == written.Id).ToListAsync());
    }

    /// <summary>
    /// A guest name BESIDE a real member does not turn that member's paid booking into a block
    /// — the name goes on <c>AdminNote</c>.
    /// </summary>
    [SkippableFact]
    public async Task A_guest_name_beside_a_member_lands_on_the_admin_note_not_the_block_label()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "bulknote");
        await CreditAsync(factory, club, club.MemberUserId, 500m);
        var slot = new DateTimeOffset(DateTimeOffset.UtcNow.AddDays(2).Date.AddHours(11), TimeSpan.Zero);

        var response = await club.AdminClient(factory).PostAsJsonAsync(BookPath, new
        {
            idempotencyKey = "bb_note",
            onBehalf = new { userId = club.MemberUserId, guestName = "Priya's guest" },
            items = new[] { new { courtId = club.CourtId, startsAt = slot, sliceCount = 4 } },
        });

        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        var row = Results(body).Single();
        Assert.Equal("booked", row.GetProperty("status").GetString());

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var written = await db.Bookings.IgnoreQueryFilters()
            .FirstAsync(b => b.Id == row.GetProperty("booking_id").GetGuid());

        Assert.Equal(BookingStatus.Booked, written.Status);
        Assert.Equal(club.MemberUserId, written.UserId);
        Assert.Equal("Priya's guest", written.AdminNote);
        Assert.Null(written.BlockLabel);
    }

    /// <summary>
    /// A payer who runs out of credit mid-batch HALTS it, and the retry under the same key
    /// skips what already landed.
    ///
    /// <para>
    /// Continuing would produce a jagged half-booked league night and a member who cannot cover
    /// it. Halting and reporting <c>halted_at</c> lets the admin come back with
    /// <c>allowNegativeBalance</c> under the same key — the landed items answer
    /// <c>duplicate</c>, and only the rest are attempted. That retry-safety is the entire
    /// reason the key is mandatory.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task Running_out_of_credit_halts_the_batch_and_the_retry_skips_what_landed()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "bulkhalt");

        // Exactly two slots' worth: 4 slices × 8 credits = 32 each.
        await CreditAsync(factory, club, club.MemberUserId, 64m);
        var day = DateTimeOffset.UtcNow.AddDays(2).Date;
        var client = club.AdminClient(factory);

        object Items() => new[]
        {
            new { courtId = club.CourtId, startsAt = new DateTimeOffset(day.AddHours(8), TimeSpan.Zero), sliceCount = 4 },
            new { courtId = club.CourtId, startsAt = new DateTimeOffset(day.AddHours(9), TimeSpan.Zero), sliceCount = 4 },
            new { courtId = club.CourtId, startsAt = new DateTimeOffset(day.AddHours(10), TimeSpan.Zero), sliceCount = 4 },
            new { courtId = club.CourtId, startsAt = new DateTimeOffset(day.AddHours(11), TimeSpan.Zero), sliceCount = 4 },
        };

        var first = await client.PostAsJsonAsync(BookPath, new
        {
            idempotencyKey = "bb_halt",
            onBehalf = new { userId = club.MemberUserId },
            items = Items(),
        });

        var firstBody = await first.Content.ReadFromJsonAsync<JsonElement>();
        var firstRows = Results(firstBody);

        // THREE results for FOUR items, and that is the assertion that proves the loop
        // stopped rather than merely reporting the last failure. A test that sent exactly as
        // many items as it expected results could not tell a halt from a batch that ran to the
        // end and happened to fail on its final row — removing the `break` left it green.
        Assert.Equal(3, firstRows.Count);
        Assert.Equal("booked", firstRows[0].GetProperty("status").GetString());
        Assert.Equal("booked", firstRows[1].GetProperty("status").GetString());
        Assert.Equal("failed", firstRows[2].GetProperty("status").GetString());
        Assert.Equal("insufficient_balance", firstRows[2].GetProperty("error").GetString());
        Assert.Equal(2, firstBody.GetProperty("halted_at").GetInt32());
        Assert.Equal("insufficient_balance", firstBody.GetProperty("halted_reason").GetString());

        var second = await client.PostAsJsonAsync(BookPath, new
        {
            idempotencyKey = "bb_halt",
            onBehalf = new { userId = club.MemberUserId },
            allowNegativeBalance = true,
            items = Items(),
        });

        var secondRows = Results(await second.Content.ReadFromJsonAsync<JsonElement>());
        Assert.Equal(4, secondRows.Count);
        Assert.Equal("duplicate", secondRows[0].GetProperty("status").GetString());
        Assert.Equal("duplicate", secondRows[1].GetProperty("status").GetString());
        Assert.Equal("booked", secondRows[2].GetProperty("status").GetString());
        Assert.Equal("booked", secondRows[3].GetProperty("status").GetString());

        // Four bookings, four charges — not six. The two that landed on the first attempt were
        // replayed, not re-debited.
        var charges = (await LedgerAsync(factory, club.TenantId))
            .Where(l => l.Type == LedgerEntryType.BookingCharge).ToList();
        Assert.Equal(4, charges.Count);
    }

    /// <summary>
    /// A slot somebody else already has does NOT stop the batch — it is one row's answer.
    ///
    /// <para>
    /// In a twenty-slot league book-out, one slot already taken is the expected case, and an
    /// all-or-nothing batch would fail the whole thing and give the admin no way to see which
    /// one.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task A_taken_slot_is_one_rows_answer_and_the_batch_carries_on()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "bulktaken");
        await CreditAsync(factory, club, club.MemberUserId, 500m);

        var day = DateTimeOffset.UtcNow.AddDays(2).Date;
        var taken = new DateTimeOffset(day.AddHours(13), TimeSpan.Zero);
        await SeedBookingAsync(factory, club, taken, charged: 32m);

        var response = await club.AdminClient(factory).PostAsJsonAsync(BookPath, new
        {
            idempotencyKey = "bb_taken",
            onBehalf = new { userId = club.MemberUserId },
            items = new[]
            {
                new { courtId = club.CourtId, startsAt = taken, sliceCount = 4 },
                new { courtId = club.CourtId, startsAt = new DateTimeOffset(day.AddHours(15), TimeSpan.Zero), sliceCount = 4 },
            },
        });

        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        var rows = Results(body);

        Assert.Equal("failed", rows[0].GetProperty("status").GetString());
        Assert.Equal("slot_taken", rows[0].GetProperty("error").GetString());
        Assert.Equal("booked", rows[1].GetProperty("status").GetString());
        // Not halted: a taken slot is a per-item answer, never the end of the batch.
        Assert.Equal(JsonValueKind.Null, body.GetProperty("halted_at").ValueKind);
    }

    /// <summary>
    /// Omitting <c>on_behalf</c> books the admin's own court on the admin's own wallet.
    ///
    /// <para>
    /// A real shape, not an oversight. Refusing it would make an admin booking their own court
    /// use a different route from the one they are already on.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task Omitting_on_behalf_books_the_admins_own_court_on_their_own_wallet()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "bulkself");
        await CreditAsync(factory, club, club.AdminUserId, 200m);
        var slot = new DateTimeOffset(DateTimeOffset.UtcNow.AddDays(2).Date.AddHours(7), TimeSpan.Zero);

        var response = await club.AdminClient(factory).PostAsJsonAsync(BookPath, new
        {
            idempotencyKey = "bb_self",
            items = new[] { new { courtId = club.CourtId, startsAt = slot, sliceCount = 4 } },
        });

        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        var row = Results(body).Single();
        Assert.Equal("booked", row.GetProperty("status").GetString());

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var written = await db.Bookings.IgnoreQueryFilters()
            .FirstAsync(b => b.Id == row.GetProperty("booking_id").GetGuid());
        Assert.Equal(club.AdminUserId, written.UserId);
    }

    /// <summary>Another club's member cannot be booked for.</summary>
    [SkippableFact]
    public async Task A_foreign_clubs_member_cannot_be_booked_for()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var clubA = await DoorClub.SeedAsync(factory, "bulkbxa");
        var clubB = await DoorClub.SeedAsync(factory, "bulkbxb");
        var slot = new DateTimeOffset(DateTimeOffset.UtcNow.AddDays(2).Date.AddHours(6), TimeSpan.Zero);

        var response = await clubA.AdminClient(factory).PostAsJsonAsync(BookPath, new
        {
            idempotencyKey = "bb_cross",
            onBehalf = new { userId = clubB.MemberUserId },
            items = new[] { new { courtId = clubA.CourtId, startsAt = slot, sliceCount = 4 } },
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("member_not_found", body.GetProperty("error").GetString());
    }

    /// <summary>A member cannot reach either route. Both are admin-only.</summary>
    [SkippableTheory]
    [InlineData(CancelPath)]
    [InlineData(BookPath)]
    public async Task A_member_cannot_reach_a_bulk_route(string path)
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "bulkrole");

        var response = await club.MemberClient(factory).PostAsJsonAsync(path, new
        {
            idempotencyKey = "nope",
            reason = "nope",
            items = Array.Empty<object>(),
        });

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }
}
