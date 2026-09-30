using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The money-lens review of the P2 backend (2026-09-23): five places where a record, a replay or
/// a zero-credit row disagreed with the money it described. Postgres-backed throughout — every
/// one of them is about what commits together, and the in-memory provider has no transactions.
///
/// <para>
/// The two "same unit of work" tests break the SECOND write on purpose
/// (<see cref="ChangeLogSabotage"/>): a happy path cannot tell "flushed together" from "flushed
/// one after the other", because both leave both rows.
/// </para>
/// </summary>
public sealed class BulkAndAdjustIntegrityHttpTests : IClassFixture<PostgresFixture>
{
    private readonly PostgresFixture _pg;

    public BulkAndAdjustIntegrityHttpTests(PostgresFixture pg) => _pg = pg;

    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";
    private const string AdminBulkPath = "/api/v1/admin/bookings/bulk";
    private const string MemberBulkPath = "/api/v1/bookings/bulk";

    private TestWebAppFactory CreateFactory() => _pg.SharedHost;

    /// <summary>A morning slot <paramref name="days"/> days out, in UTC — clear of every clock trap.</summary>
    private static DateTimeOffset Morning(int days, int hour = 8)
        => new(DateTimeOffset.UtcNow.AddDays(days).Date.AddHours(hour), TimeSpan.Zero);

    private static List<JsonElement> Results(JsonElement body) => body.GetProperty("results").EnumerateArray().ToList();

    private static async Task CreditAsync(TestWebAppFactory factory, Guid tenantId, Guid userId, decimal credits)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        db.LedgerEntries.Add(new LedgerEntry
        {
            TenantId = tenantId,
            UserId = userId,
            Type = LedgerEntryType.TopUp,
            AmountCredits = credits,
            ActorUserId = Guid.Empty,
            Reason = "fixture float",
        });
        await db.SaveChangesAsync();
    }

    /// <summary>A second active member of the club. Returns the user id.</summary>
    private static async Task<Guid> AddMemberAsync(TestWebAppFactory factory, DoorClub club, string name)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var handle = $"{club.Slug}-{Guid.NewGuid():N}"[..30];
        var user = new User
        {
            TenantId = club.TenantId,
            Email = $"{handle}@test.local",
            PasswordHash = "x",
            EmailVerified = true,
        };
        db.Users.Add(user);
        db.Memberships.Add(new Membership
        {
            TenantId = club.TenantId,
            UserId = user.Id,
            FullName = name,
            MembershipNumber = handle,
            Status = MembershipStatus.Active,
        });
        await db.SaveChangesAsync();
        return user.Id;
    }

    private static async Task SetCourtPriceAsync(TestWebAppFactory factory, Guid courtId, decimal slicePrice)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var court = await db.Courts.IgnoreQueryFilters().FirstAsync(c => c.Id == courtId);
        court.SlicePriceCredits = slicePrice;
        await db.SaveChangesAsync();
    }

    private static async Task<List<LedgerEntry>> LedgerAsync(TestWebAppFactory factory, Guid tenantId, Guid userId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        return await db.LedgerEntries.IgnoreQueryFilters()
            .Where(l => l.TenantId == tenantId && l.UserId == userId).ToListAsync();
    }

    private static async Task<List<Booking>> BookingsAsync(TestWebAppFactory factory, Guid tenantId, Guid userId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        return await db.Bookings.IgnoreQueryFilters()
            .Where(b => b.TenantId == tenantId && b.UserId == userId).ToListAsync();
    }

    private static async Task<List<AdminChangeLog>> ChangesAsync(TestWebAppFactory factory, Guid tenantId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        return await db.AdminChangeLogs.IgnoreQueryFilters().Where(a => a.TenantId == tenantId).ToListAsync();
    }

    /// <summary>
    /// A request the server fails. The test host rethrows an unhandled exception into the client
    /// rather than answering 500, so both shapes count as "the request did not succeed".
    /// </summary>
    private static async Task<bool> SucceededAsync(Func<Task<HttpResponseMessage>> send)
    {
        try
        {
            var response = await send();
            return response.IsSuccessStatusCode;
        }
        catch (Exception)
        {
            return false;
        }
    }

    // ---- F1: a by-hand credit movement and its record are one unit of work ------------------

    /// <summary>
    /// <b>F1.</b> The adjust posted the ledger row in one commit and the audit and change-log rows
    /// in a second. When the second failed, the money had moved with no record of who moved it —
    /// and a retry without an idempotency key moved it again: two +25 adjusts, 50 credits on the
    /// ledger, nothing in either record. Now a refused record rolls the movement back, and the
    /// retry after the fault clears posts exactly once.
    /// </summary>
    [SkippableFact]
    public async Task A_credit_adjustment_whose_record_fails_moves_no_money()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "f1adjust");
        var admin = club.AdminClient(factory);
        var path = $"/api/v1/admin/credit/{club.MemberUserId}/adjust";
        object Body() => new { amountCredits = 25m, reason = "Lights failed", reasonCode = "goodwill" };

        await using (await ChangeLogSabotage.InstallAsync(factory, club.TenantId, "credit."))
        {
            Assert.False(await SucceededAsync(() => admin.PostAsJsonAsync(path, Body())));
            Assert.False(await SucceededAsync(() => admin.PostAsJsonAsync(path, Body())));
        }

        Assert.DoesNotContain(
            await LedgerAsync(factory, club.TenantId, club.MemberUserId),
            l => l.Type == LedgerEntryType.AdminAdjustment);
        Assert.Empty(await club.AuditRowsAsync(factory, "credit.adjusted"));
        Assert.Empty(await ChangesAsync(factory, club.TenantId));

        // The fault cleared: one adjust is one movement and one record.
        Assert.True(await SucceededAsync(() => admin.PostAsJsonAsync(path, Body())));
        Assert.Equal(25m, (await LedgerAsync(factory, club.TenantId, club.MemberUserId)).Sum(l => l.AmountCredits));
        Assert.Single(await ChangesAsync(factory, club.TenantId));
    }

    // ---- F2: every on-behalf booking a batch charged is in the record -----------------------

    /// <summary>
    /// <b>F2.</b> A batch's items each commit their booking and charge under their own lock, and
    /// the only record of the admin's decision was <c>bookings.bulk_booked</c>, saved after the
    /// loop. A request that died before that save left the member charged for bookings the club's
    /// undeletable record said nothing about. Each on-behalf item now writes its own row in its
    /// own unit of work, so a batch that dies still leaves one row per booking it charged.
    /// </summary>
    [SkippableFact]
    public async Task A_bulk_book_that_dies_mid_batch_still_records_every_booking_it_charged()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "f2bulk");
        await CreditAsync(factory, club.TenantId, club.MemberUserId, 500m);
        var admin = club.AdminClient(factory);

        await using (await ChangeLogSabotage.InstallAsync(factory, club.TenantId, "bookings.bulk_booked"))
        {
            Assert.False(await SucceededAsync(() => admin.PostAsJsonAsync(AdminBulkPath, new
            {
                idempotencyKey = "f2",
                onBehalf = new { userId = club.MemberUserId },
                items = new object[]
                {
                    new { courtId = club.CourtId, startsAt = Morning(2, 8), sliceCount = 2 },
                    new { courtId = club.CourtId, startsAt = Morning(2, 10), sliceCount = 2 },
                },
            })));
        }

        var charged = (await BookingsAsync(factory, club.TenantId, club.MemberUserId))
            .Where(b => b.Status == BookingStatus.Booked).Select(b => b.Id).ToHashSet();
        Assert.Equal(2, charged.Count);

        var recorded = (await ChangesAsync(factory, club.TenantId))
            .Where(c => c.Action == "booking.booked_on_behalf")
            .Select(c => JsonDocument.Parse(c.AfterJson!).RootElement.GetProperty("booking_id").GetGuid())
            .ToHashSet();
        Assert.Equal(charged, recorded);
    }

    // ---- F3: a bulk key reused for another payer never reports the first payer's booking -------

    /// <summary>
    /// <b>F3.</b> The admin bulk's reference was <c>bulkbook:{tenant}:{key}:{index}</c>, with no
    /// payer in it, and a replay was trusted without being checked. The console mints one key per
    /// sheet, so a batch for member A re-sent with the payer changed to B found A's debit and
    /// answered <c>duplicate</c> — succeeded 1, with A's booking id and A's 09:00 slot as B's
    /// result — while B had no booking and no charge.
    /// </summary>
    [SkippableFact]
    public async Task A_bulk_key_reused_for_another_payer_books_that_payer_or_says_why_not()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "f3payer");
        var memberB = await AddMemberAsync(factory, club, "Second Member");
        await CreditAsync(factory, club.TenantId, club.MemberUserId, 200m);
        await CreditAsync(factory, club.TenantId, memberB, 200m);
        var admin = club.AdminClient(factory);

        var first = await admin.PostAsJsonAsync(AdminBulkPath, new
        {
            idempotencyKey = "one-sheet",
            onBehalf = new { userId = club.MemberUserId },
            items = new object[] { new { courtId = club.CourtId, startsAt = Morning(2, 9), sliceCount = 2 } },
        });
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        var aBooking = Results(await first.Content.ReadFromJsonAsync<JsonElement>())[0].GetProperty("booking_id").GetGuid();

        var second = await admin.PostAsJsonAsync(AdminBulkPath, new
        {
            idempotencyKey = "one-sheet",
            onBehalf = new { userId = memberB },
            items = new object[] { new { courtId = club.CourtId, startsAt = Morning(2, 14), sliceCount = 2 } },
        });
        Assert.Equal(HttpStatusCode.OK, second.StatusCode);
        var row = Results(await second.Content.ReadFromJsonAsync<JsonElement>())[0];

        // Never A's booking reported as B's.
        if (row.GetProperty("booking_id").ValueKind == JsonValueKind.String)
        {
            Assert.NotEqual(aBooking, row.GetProperty("booking_id").GetGuid());
        }

        // And the answer is true of the ledger: B booked and charged at 14:00.
        Assert.Equal("booked", row.GetProperty("status").GetString());
        var bBookings = await BookingsAsync(factory, club.TenantId, memberB);
        var booked = Assert.Single(bBookings);
        Assert.Equal(Morning(2, 14), booked.StartsAt);
        Assert.Equal(-16m, (await LedgerAsync(factory, club.TenantId, memberB))
            .Where(l => l.Type == LedgerEntryType.BookingCharge).Sum(l => l.AmountCredits));
    }

    /// <summary>
    /// The same payer and the same key for a DIFFERENT list is refused per item, as the member
    /// route already refuses it — never answered with whatever sat at that index last time.
    /// </summary>
    [SkippableFact]
    public async Task A_bulk_key_reused_for_a_different_list_is_refused_not_replayed()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "f3list");
        await CreditAsync(factory, club.TenantId, club.MemberUserId, 200m);
        var admin = club.AdminClient(factory);

        object Batch(int hour) => new
        {
            idempotencyKey = "same-key",
            onBehalf = new { userId = club.MemberUserId },
            items = new object[] { new { courtId = club.CourtId, startsAt = Morning(2, hour), sliceCount = 2 } },
        };

        Assert.Equal(HttpStatusCode.OK, (await admin.PostAsJsonAsync(AdminBulkPath, Batch(9))).StatusCode);
        var again = await admin.PostAsJsonAsync(AdminBulkPath, Batch(15));
        var row = Results(await again.Content.ReadFromJsonAsync<JsonElement>())[0];

        Assert.Equal("failed", row.GetProperty("status").GetString());
        Assert.Equal("idempotency_key_reused", row.GetProperty("error").GetString());
        Assert.Single(await BookingsAsync(factory, club.TenantId, club.MemberUserId));
    }

    // ---- F4: a replay of a cancelled booking does not say "booked" -------------------------

    /// <summary>
    /// <b>F4, member route.</b> Bulk-book, cancel (refunded), resend the same request: the answer
    /// was <c>booked, replayed</c> with the same id, while the booking was cancelled and the
    /// member held no court. It is now refused <c>already_cancelled</c>.
    /// </summary>
    [SkippableFact]
    public async Task A_member_bulk_replay_of_a_cancelled_booking_says_it_was_cancelled()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "f4member");
        await CreditAsync(factory, club.TenantId, club.MemberUserId, 100m);
        var member = club.MemberClient(factory);
        var body = new
        {
            idempotencyKey = "f4-key",
            items = new object[] { new { courtId = club.CourtId, startsAt = Morning(3, 9), sliceCount = 1 } },
        };

        var first = await member.PostAsJsonAsync(MemberBulkPath, body);
        var id = Results(await first.Content.ReadFromJsonAsync<JsonElement>())[0].GetProperty("booking_id").GetGuid();
        Assert.Equal(HttpStatusCode.OK, (await member.PostAsync($"/api/v1/bookings/{id}/cancel", null)).StatusCode);

        var again = await member.PostAsJsonAsync(MemberBulkPath, body);
        var answer = await again.Content.ReadFromJsonAsync<JsonElement>();
        var row = Results(answer)[0];

        Assert.Equal("refused", row.GetProperty("status").GetString());
        Assert.Equal("already_cancelled", row.GetProperty("reason").GetString());
        Assert.Equal(0, answer.GetProperty("booked").GetInt32());
    }

    /// <summary><b>F4, admin route.</b> The same replay, the same honest answer.</summary>
    [SkippableFact]
    public async Task An_admin_bulk_replay_of_a_cancelled_booking_says_it_was_cancelled()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "f4admin");
        await CreditAsync(factory, club.TenantId, club.MemberUserId, 100m);
        var admin = club.AdminClient(factory);
        var body = new
        {
            idempotencyKey = "f4-admin",
            onBehalf = new { userId = club.MemberUserId },
            items = new object[] { new { courtId = club.CourtId, startsAt = Morning(3, 11), sliceCount = 1 } },
        };

        var first = await admin.PostAsJsonAsync(AdminBulkPath, body);
        var id = Results(await first.Content.ReadFromJsonAsync<JsonElement>())[0].GetProperty("booking_id").GetGuid();
        Assert.Equal(
            HttpStatusCode.OK,
            (await club.MemberClient(factory).PostAsync($"/api/v1/bookings/{id}/cancel", null)).StatusCode);

        var row = Results(await (await admin.PostAsJsonAsync(AdminBulkPath, body)).Content.ReadFromJsonAsync<JsonElement>())[0];

        Assert.Equal("failed", row.GetProperty("status").GetString());
        Assert.Equal("already_cancelled", row.GetProperty("error").GetString());
    }

    // ---- F5: a free court bulk-booked writes no 0.00 row, and still replays ----------------------

    /// <summary>
    /// <b>F5.</b> Settlement-model I10: a posting of zero credits is not written, the walk-up the
    /// one exception. The single booking of a free court honoured it; the member and admin bulk
    /// routes wrote a 0.00 <c>BookingCharge</c> — a phantom line on the member's statement —
    /// because the skip keyed on "has no reference" and a bulk item always has one. The retry the
    /// reference existed for still answers with the same booking rather than <c>slot_taken</c>
    /// about the court the member already holds.
    /// </summary>
    [SkippableFact]
    public async Task A_free_court_bulk_booked_posts_no_zero_row_and_still_replays()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "f5free");
        await SetCourtPriceAsync(factory, club.CourtId, 0m);
        var member = club.MemberClient(factory);
        var admin = club.AdminClient(factory);

        var memberBody = new
        {
            idempotencyKey = "f5-member",
            items = new object[] { new { courtId = club.CourtId, startsAt = Morning(2, 9), sliceCount = 1 } },
        };
        var adminBody = new
        {
            idempotencyKey = "f5-admin",
            onBehalf = new { userId = club.MemberUserId },
            items = new object[] { new { courtId = club.CourtId, startsAt = Morning(2, 13), sliceCount = 1 } },
        };

        var memberFirst = Results(await (await member.PostAsJsonAsync(MemberBulkPath, memberBody)).Content.ReadFromJsonAsync<JsonElement>())[0];
        var adminFirst = Results(await (await admin.PostAsJsonAsync(AdminBulkPath, adminBody)).Content.ReadFromJsonAsync<JsonElement>())[0];
        Assert.Equal("booked", memberFirst.GetProperty("status").GetString());
        Assert.Equal("booked", adminFirst.GetProperty("status").GetString());

        Assert.Empty(await LedgerAsync(factory, club.TenantId, club.MemberUserId));

        // The retries each answer with their own booking.
        var memberAgain = Results(await (await member.PostAsJsonAsync(MemberBulkPath, memberBody)).Content.ReadFromJsonAsync<JsonElement>())[0];
        Assert.Equal("booked", memberAgain.GetProperty("status").GetString());
        Assert.True(memberAgain.GetProperty("replayed").GetBoolean());
        Assert.Equal(memberFirst.GetProperty("booking_id").GetGuid(), memberAgain.GetProperty("booking_id").GetGuid());

        var adminAgain = Results(await (await admin.PostAsJsonAsync(AdminBulkPath, adminBody)).Content.ReadFromJsonAsync<JsonElement>())[0];
        Assert.Equal("duplicate", adminAgain.GetProperty("status").GetString());
        Assert.Equal(adminFirst.GetProperty("booking_id").GetGuid(), adminAgain.GetProperty("booking_id").GetGuid());

        Assert.Equal(2, (await BookingsAsync(factory, club.TenantId, club.MemberUserId)).Count);
        Assert.Empty(await LedgerAsync(factory, club.TenantId, club.MemberUserId));
    }
}
