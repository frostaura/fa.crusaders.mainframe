using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// D8 — a member booking several slots in one request, under every rule their single booking
/// obeys. Postgres-backed for the reasons <c>AdminBulkBookingHttpTests</c> gives: the payer lock,
/// the slot race and the idempotency guarantee are all the database's.
///
/// <para>
/// Every slot is at least a day ahead and before 16:00 in a UTC club, so neither the same-day cap
/// relaxation nor peak-hour league exclusivity is in play unless a test puts it there
/// (<c>memory/gotchas-clock.md</c>). The club's court is 8 credits a slice; four slices — an
/// hour, the default per-day cap — cost 32.
/// </para>
/// </summary>
public sealed class MemberBulkBookingHttpTests : IClassFixture<PostgresFixture>
{
    private readonly PostgresFixture _pg;

    public MemberBulkBookingHttpTests(PostgresFixture pg) => _pg = pg;

    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";
    private const string BulkPath = "/api/v1/bookings/bulk";

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    private static List<JsonElement> Results(JsonElement body) => body.GetProperty("results").EnumerateArray().ToList();

    /// <summary>A morning slot <paramref name="days"/> days out, in UTC, at <paramref name="hour"/>.</summary>
    private static DateTimeOffset Morning(int days, int hour = 8)
        => new(DateTimeOffset.UtcNow.AddDays(days).Date.AddHours(hour), TimeSpan.Zero);

    private static object Item(Guid courtId, DateTimeOffset startsAt, int sliceCount = 4)
        => new { courtId, startsAt, sliceCount };

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

    private static async Task<decimal> BalanceAsync(TestWebAppFactory factory, Guid userId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        return await db.LedgerEntries.IgnoreQueryFilters().Where(l => l.UserId == userId).SumAsync(l => l.AmountCredits);
    }

    private static async Task<int> LiveBookingsAsync(TestWebAppFactory factory, Guid tenantId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        return await db.Bookings.IgnoreQueryFilters()
            .CountAsync(b => b.TenantId == tenantId && b.Status == BookingStatus.Booked);
    }

    private static async Task<JsonElement> PostAsync(HttpClient client, object body, HttpStatusCode expected = HttpStatusCode.OK)
    {
        var response = await client.PostAsJsonAsync(BulkPath, body);
        Assert.Equal(expected, response.StatusCode);
        return await response.Content.ReadFromJsonAsync<JsonElement>();
    }

    /// <summary>
    /// The ordinary case: a member ticks slots across two days and gets each booked, charged at
    /// booking, answered in the order they ticked them.
    /// </summary>
    [SkippableFact]
    public async Task A_member_books_several_days_in_one_request_and_is_charged_for_each()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "mbulkok");
        await CreditAsync(factory, club.TenantId, club.MemberUserId, 100m);

        var body = await PostAsync(club.MemberClient(factory), new
        {
            idempotencyKey = "mb_ok",
            items = new[] { Item(club.CourtId, Morning(2)), Item(club.CourtId, Morning(3)) },
        });

        var results = Results(body);
        Assert.Equal(2, results.Count);
        Assert.All(results, r => Assert.Equal("booked", r.GetProperty("status").GetString()));
        Assert.Equal(0, results[0].GetProperty("index").GetInt32());
        Assert.Equal("Court 1", results[0].GetProperty("court_name").GetString());
        Assert.Equal(32m, results[0].GetProperty("amount_credits").GetDecimal());
        Assert.Equal(64m, body.GetProperty("charged_now_credits").GetDecimal());
        Assert.Equal(100m, body.GetProperty("balance_before_credits").GetDecimal());
        Assert.Equal(36m, body.GetProperty("balance_after_credits").GetDecimal());
        Assert.Equal(JsonValueKind.Null, body.GetProperty("halted_at").ValueKind);
        Assert.Equal(36m, await BalanceAsync(factory, club.MemberUserId));
    }

    /// <summary>
    /// The per-day cap is counted ACROSS the batch, not per item: an hour on Tuesday and another
    /// hour on Tuesday in one request is two hours on Tuesday. The batch is per-item, so the day
    /// that fits still books — a mixed answer, each refusal in the single route's own words.
    /// </summary>
    [SkippableFact]
    public async Task The_daily_cap_counts_the_whole_batch_and_the_answer_mixes_booked_and_refused()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "mbulkcap");
        await CreditAsync(factory, club.TenantId, club.MemberUserId, 500m);

        var body = await PostAsync(club.MemberClient(factory), new
        {
            idempotencyKey = "mb_cap",
            items = new[]
            {
                Item(club.CourtId, Morning(2, 8)),
                Item(club.CourtId, Morning(2, 10)),
                Item(club.CourtId, Morning(3, 8)),
                Item(Guid.NewGuid(), Morning(4, 8)),
            },
        });

        var results = Results(body);
        Assert.Equal("booked", results[0].GetProperty("status").GetString());
        Assert.Equal("refused", results[1].GetProperty("status").GetString());
        // The default club caps a member at four slots AND sixty minutes a day; four slices is
        // both, and the slot cap is asked first. A code the admin bulk's vocabulary never named
        // — there it would have read `booking_failed`.
        Assert.Equal("per_day_slot_cap_exceeded", results[1].GetProperty("reason").GetString());
        Assert.Equal(JsonValueKind.Null, results[1].GetProperty("booking_id").ValueKind);
        Assert.Equal("booked", results[2].GetProperty("status").GetString());
        Assert.Equal("court_not_found", results[3].GetProperty("reason").GetString());

        Assert.Equal(2, body.GetProperty("booked").GetInt32());
        Assert.Equal(2, body.GetProperty("refused").GetInt32());
        Assert.Equal(500m - 64m, await BalanceAsync(factory, club.MemberUserId));
    }

    /// <summary>
    /// <b>No overdraft, ever.</b> The batch halts at the first slot the member cannot cover; the
    /// rest answer <c>not_attempted</c>; the balance never goes below zero — and a body that asks
    /// for the admin override by name changes nothing, because the member's request has no such
    /// field and the service never sets one.
    /// </summary>
    [SkippableFact]
    public async Task A_member_cannot_overdraw_through_a_batch_even_by_asking()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "mbulkneg");
        await CreditAsync(factory, club.TenantId, club.MemberUserId, 40m);

        var body = await PostAsync(club.MemberClient(factory), new
        {
            idempotencyKey = "mb_neg",
            allowNegativeBalance = true,
            items = new[] { Item(club.CourtId, Morning(2)), Item(club.CourtId, Morning(3)), Item(club.CourtId, Morning(4)) },
        });

        var results = Results(body);
        Assert.Equal("booked", results[0].GetProperty("status").GetString());
        Assert.Equal("insufficient_balance", results[1].GetProperty("reason").GetString());
        Assert.Equal("not_attempted", results[2].GetProperty("reason").GetString());
        Assert.Equal(1, body.GetProperty("halted_at").GetInt32());
        Assert.Equal("insufficient_balance", body.GetProperty("halted_reason").GetString());

        Assert.Equal(8m, await BalanceAsync(factory, club.MemberUserId));
        Assert.Equal(1, await LiveBookingsAsync(factory, club.TenantId));
    }

    /// <summary>
    /// An ADMIN using the member route is still paying from their own wallet and still cannot
    /// overdraw it here — the override lives only on the admin routes, where it is asked for by
    /// name. Whatever the god-mode rule becomes there, this route never passes it.
    /// </summary>
    [SkippableFact]
    public async Task An_admin_on_the_member_route_cannot_overdraw_their_own_wallet_either()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "mbulkadm");

        var body = await PostAsync(club.AdminClient(factory), new
        {
            idempotencyKey = "mb_adm",
            allowNegativeBalance = true,
            items = new[] { Item(club.CourtId, Morning(2)) },
        });

        Assert.Equal("insufficient_balance", Results(body).Single().GetProperty("reason").GetString());
        Assert.Equal(0m, await BalanceAsync(factory, club.AdminUserId));
    }

    /// <summary>
    /// Same key, same answer: the replay books nothing twice, moves no money, and hands back the
    /// same booking ids. And after a halt, a top-up and the same key book exactly the rest.
    /// </summary>
    [SkippableFact]
    public async Task Replaying_the_same_key_books_nothing_twice_and_finishes_a_halted_batch()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "mbulkidem");
        await CreditAsync(factory, club.TenantId, club.MemberUserId, 32m);
        var client = club.MemberClient(factory);
        var request = new
        {
            idempotencyKey = "mb_idem",
            items = new[] { Item(club.CourtId, Morning(2)), Item(club.CourtId, Morning(3)) },
        };

        var first = Results(await PostAsync(client, request));
        Assert.Equal("booked", first[0].GetProperty("status").GetString());
        Assert.Equal("insufficient_balance", first[1].GetProperty("reason").GetString());

        var again = await PostAsync(client, request);
        var replay = Results(again);
        Assert.Equal(first[0].GetProperty("booking_id").GetGuid(), replay[0].GetProperty("booking_id").GetGuid());
        Assert.True(replay[0].GetProperty("replayed").GetBoolean());
        Assert.Equal(32m, replay[0].GetProperty("amount_credits").GetDecimal());
        Assert.Equal(0m, again.GetProperty("charged_now_credits").GetDecimal());
        Assert.Equal(0m, await BalanceAsync(factory, club.MemberUserId));
        Assert.Equal(1, await LiveBookingsAsync(factory, club.TenantId));

        await CreditAsync(factory, club.TenantId, club.MemberUserId, 32m);
        var finished = Results(await PostAsync(client, request));
        Assert.True(finished[0].GetProperty("replayed").GetBoolean());
        Assert.Equal("booked", finished[1].GetProperty("status").GetString());
        Assert.False(finished[1].GetProperty("replayed").GetBoolean());
        Assert.Equal(0m, await BalanceAsync(factory, club.MemberUserId));
        Assert.Equal(2, await LiveBookingsAsync(factory, club.TenantId));
    }

    /// <summary>
    /// A key reused for a DIFFERENT list does not answer item 0 with last time's item 0 — the
    /// replay is checked against the court and start it claims to be.
    /// </summary>
    [SkippableFact]
    public async Task A_key_reused_for_a_different_list_is_refused_rather_than_misreported()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "mbulkreuse");
        await CreditAsync(factory, club.TenantId, club.MemberUserId, 100m);
        var client = club.MemberClient(factory);

        await PostAsync(client, new { idempotencyKey = "mb_reuse", items = new[] { Item(club.CourtId, Morning(2)) } });
        var body = await PostAsync(client, new { idempotencyKey = "mb_reuse", items = new[] { Item(club.CourtId, Morning(5)) } });

        Assert.Equal("idempotency_key_reused", Results(body).Single().GetProperty("reason").GetString());
        Assert.Equal(1, await LiveBookingsAsync(factory, club.TenantId));
    }

    /// <summary>
    /// Two members whose phones mint the same key are two batches, not one. The admin bulk's
    /// reference carries no payer, so on that shape the second member's replay would have handed
    /// back the first member's booking as their own.
    /// </summary>
    [SkippableFact]
    public async Task Two_members_using_the_same_key_each_get_their_own_booking()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "mbulktwo");
        await CreditAsync(factory, club.TenantId, club.MemberUserId, 100m);
        await CreditAsync(factory, club.TenantId, club.AdminUserId, 100m);

        var mine = Results(await PostAsync(club.MemberClient(factory),
            new { idempotencyKey = "shared", items = new[] { Item(club.CourtId, Morning(2, 8)) } }));
        var theirs = Results(await PostAsync(club.ClientFor(factory, club.AdminUserId, null),
            new { idempotencyKey = "shared", items = new[] { Item(club.CourtId, Morning(2, 10)) } }));

        Assert.False(theirs[0].GetProperty("replayed").GetBoolean());
        Assert.NotEqual(mine[0].GetProperty("booking_id").GetGuid(), theirs[0].GetProperty("booking_id").GetGuid());
        Assert.Equal(68m, await BalanceAsync(factory, club.AdminUserId));
    }

    /// <summary>
    /// Another club's court id is a court this club does not have: refused, nothing charged,
    /// nothing written in either club. The tenant comes from the token, so there is no other way
    /// for a batch to reach another club at all.
    /// </summary>
    [SkippableFact]
    public async Task Another_clubs_court_cannot_be_booked_or_charged_through_a_batch()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var mine = await DoorClub.SeedAsync(factory, "mbulkmine");
        var theirs = await DoorClub.SeedAsync(factory, "mbulktheirs");
        await CreditAsync(factory, mine.TenantId, mine.MemberUserId, 100m);

        var body = await PostAsync(mine.MemberClient(factory), new
        {
            idempotencyKey = "mb_x",
            items = new[] { Item(theirs.CourtId, Morning(2)) },
        });

        Assert.Equal("court_not_found", Results(body).Single().GetProperty("reason").GetString());
        Assert.Equal(100m, await BalanceAsync(factory, mine.MemberUserId));
        Assert.Equal(0, await LiveBookingsAsync(factory, mine.TenantId));
        Assert.Equal(0, await LiveBookingsAsync(factory, theirs.TenantId));
    }

    /// <summary>
    /// A group's booking window reaches the member in its own word — the refusal the admin bulk's
    /// vocabulary never had to name, because admins are exempt from it.
    /// </summary>
    [SkippableFact]
    public async Task A_group_window_refusal_arrives_in_its_own_word()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "mbulkgrp");
        await CreditAsync(factory, club.TenantId, club.MemberUserId, 100m);

        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var group = new MemberGroup { TenantId = club.TenantId, Name = "Early birds" };
            db.MemberGroups.Add(group);
            db.MemberGroupMembers.Add(new MemberGroupMember { TenantId = club.TenantId, GroupId = group.Id, UserId = club.MemberUserId });
            foreach (var day in Enum.GetValues<DayOfWeek>())
            {
                db.MemberGroupWindows.Add(new MemberGroupWindow
                {
                    TenantId = club.TenantId,
                    GroupId = group.Id,
                    DayOfWeek = day,
                    StartMinute = 6 * 60,
                    EndMinute = 7 * 60,
                });
            }
            await db.SaveChangesAsync();
        }

        var body = await PostAsync(club.MemberClient(factory), new
        {
            idempotencyKey = "mb_grp",
            items = new[] { Item(club.CourtId, Morning(2, 6)), Item(club.CourtId, Morning(3, 8)) },
        });

        var results = Results(body);
        Assert.Equal("booked", results[0].GetProperty("status").GetString());
        Assert.Equal("group_window", results[1].GetProperty("reason").GetString());
    }

    [SkippableTheory]
    [InlineData(null, 1, "idempotency_key_invalid")]
    [InlineData("k", 0, "no_items")]
    [InlineData("k", 3, "too_many_items")]
    public async Task A_batch_this_server_will_not_attempt_is_refused_whole(string? key, int count, string error)
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "mbulkbad",
            """{"slice_minutes":15,"day_start_minute":0,"day_end_minute":1440,"grace_window_minutes":5,"timezone":"UTC","admin_bulk_max_items":2}""");

        var items = Enumerable.Range(0, count).Select(i => Item(club.CourtId, Morning(2 + i))).ToArray();
        var body = await PostAsync(club.MemberClient(factory), new { idempotencyKey = key, items }, HttpStatusCode.BadRequest);

        Assert.Equal(error, body.GetProperty("error").GetString());
        if (error == "too_many_items") Assert.Equal(2, body.GetProperty("max_items").GetInt32());
        Assert.Equal(0, await LiveBookingsAsync(factory, club.TenantId));
    }

    /// <summary>A suspended member is refused the batch by the same gate the single route asks.</summary>
    [SkippableFact]
    public async Task A_suspended_member_is_refused_the_whole_batch()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "mbulksus");
        await CreditAsync(factory, club.TenantId, club.MemberUserId, 100m);
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var membership = await db.Memberships.IgnoreQueryFilters().FirstAsync(m => m.UserId == club.MemberUserId);
            membership.Status = MembershipStatus.Suspended;
            await db.SaveChangesAsync();
        }

        await PostAsync(club.MemberClient(factory),
            new { idempotencyKey = "mb_sus", items = new[] { Item(club.CourtId, Morning(2)) } }, HttpStatusCode.Forbidden);
        Assert.Equal(100m, await BalanceAsync(factory, club.MemberUserId));
    }
}
