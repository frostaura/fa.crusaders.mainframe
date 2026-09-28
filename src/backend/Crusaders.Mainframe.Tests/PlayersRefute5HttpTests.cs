using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The fifth refuter round on the P11 players fixes (D11), on Postgres: a game cancelled after
/// check-in earmarks nothing, waiting returns are paid first come first served even when games
/// still hold money, a failed post-settlement reconcile leaves a durable marker, and one poisoned
/// booking stops nothing else. Each test failed on the code it follows.
/// </summary>
[Collection(HttpTestCollection.Name)]
public sealed class PlayersRefute5HttpTests
{
    private readonly PostgresFixture _pg;

    public PlayersRefute5HttpTests(PostgresFixture pg) => _pg = pg;

    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    private static async Task<JsonElement> JsonAsync(HttpResponseMessage response) =>
        await response.Content.ReadFromJsonAsync<JsonElement>();

    /// <summary>Adds members to an existing booking by amount, as the organiser; answers their seats in order.</summary>
    private static async Task<List<Guid>> AddAsync(PlayersClub club, TestWebAppFactory f, Guid bookingId, params (Guid Who, decimal Amount)[] players)
    {
        var add = await club.Client(f, club.Organiser).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players", new
        {
            players = players.Select(p => (object)new { userId = p.Who, amount = p.Amount }).ToArray(),
            splitMode = "amount",
        });
        var body = await JsonAsync(add);
        Assert.True(add.IsSuccessStatusCode, body.ToString());
        return body.GetProperty("participants").EnumerateArray().Select(p => p.GetProperty("participant_id").GetGuid()).ToList();
    }

    private static async Task AcceptAsync(PlayersClub club, TestWebAppFactory f, Guid who, Guid bookingId, Guid seat, decimal share)
    {
        var accept = await club.Client(f, who).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players/{seat}/accept", new { expectedShareCredits = share });
        Assert.True(accept.IsSuccessStatusCode, await accept.Content.ReadAsStringAsync());
    }

    private static Task<HttpResponseMessage> WithdrawAsync(PlayersClub club, TestWebAppFactory f, Guid who, Guid bookingId, Guid seat) =>
        club.Client(f, who).PostAsync($"/api/v1/bookings/{bookingId}/players/{seat}/withdraw", null);

    private static Task<decimal> CoverageAsync(PlayersClub club, TestWebAppFactory f, Guid bookingId, Guid seat) =>
        club.InClubAsync(f, sp => sp.GetRequiredService<LedgerService>().GetCoverageAsync(club.Organiser, bookingId, seat, default));

    // ------------------------------------------------------------------ MEDIUM. a game cancelled after check-in earmarks nothing

    /// <summary>
    /// Game Z holds Alex's 16. Game X was cancelled after check-in: Sam's 16 stayed owed, so it was
    /// spendable — and was spent. Sam then comes off X: his return is not earmarked by X (whose
    /// "hold" is only that return), so it must not be paid out of Z's money. It waits, and Alex's
    /// ordinary withdrawal from Z is paid at once.
    /// </summary>
    [SkippableFact]
    public async Task A_game_cancelled_after_check_in_earmarks_nothing_for_its_own_returns()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "r5s4");
        await club.CreditAsync(f, club.Sam, 50m);
        await club.CreditAsync(f, club.Alex, 50m);

        // X: Sam pays 16, the game is checked into and cancelled — nothing comes back (S4).
        await club.CreditAsync(f, club.Organiser, 32m);
        var x = await club.InsertBookingAsync(f, DateTimeOffset.UtcNow.AddMinutes(40));
        var sam = (await AddAsync(club, f, x, (club.Sam, 16m)))[0];
        await AcceptAsync(club, f, club.Sam, x, sam, 16m);
        await club.WriteAsync(f, db => db.Bookings.IgnoreQueryFilters().First(b => b.Id == x).CheckedInAt = DateTimeOffset.UtcNow);
        Assert.True((await club.Client(f, club.Organiser).PostAsJsonAsync($"/api/v1/bookings/{x}/cancel", new { })).IsSuccessStatusCode);
        await club.CreditAsync(f, club.Organiser, -16m);   // Sam's 16, spent: it was the organiser's to spend

        // Z: Alex pays 16, held for him.
        await club.CreditAsync(f, club.Organiser, 32m);
        var z = await club.InsertBookingAsync(f, PlayersClub.Tomorrow(8));
        var alex = (await AddAsync(club, f, z, (club.Alex, 16m)))[0];
        await AcceptAsync(club, f, club.Alex, z, alex, 16m);
        Assert.Equal(16m, await PlayersClub.BalanceAsync(f, club.Organiser));

        await club.WriteAsync(f, db => db.BookingParticipants.IgnoreQueryFilters().First(p => p.Id == sam).Status = ParticipantStatus.Removed);
        await club.InClubAsync(f, sp => sp.GetRequiredService<ShareLedger>().ReconcileAsync(x, default));

        Assert.Equal(34m, await PlayersClub.BalanceAsync(f, club.Sam));           // his return waits
        Assert.Equal(16m, await PlayersClub.BalanceAsync(f, club.Organiser));     // Z's money untouched

        Assert.True((await WithdrawAsync(club, f, club.Alex, z, alex)).IsSuccessStatusCode);
        Assert.Equal(50m, await PlayersClub.BalanceAsync(f, club.Alex));
    }

    // ------------------------------------------------------------------ LOW. first come, first served while games still hold

    /// <summary>
    /// Two games hold 16 each for Alex and Jo; a desk debit takes the organiser to 0, so when both
    /// withdraw — Alex first — both returns wait. A 16 top-up is Alex's, the older: Jo's coverage is
    /// nothing while Alex waits, whatever order the reconciles run in.
    /// </summary>
    [SkippableTheory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Waiting_returns_are_first_come_first_served_even_while_games_still_hold(bool oneGame)
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, oneGame ? "r5fcfs1" : "r5fcfs2");
        await club.CreditAsync(f, club.Alex, 50m);
        await club.CreditAsync(f, club.Jo, 50m);
        await club.CreditAsync(f, club.Organiser, oneGame ? 32m : 64m);
        Guid zAlex, zJo, alex, jo;
        if (oneGame)
        {
            zAlex = zJo = await club.InsertBookingAsync(f, PlayersClub.Tomorrow(8));
            var seats = await AddAsync(club, f, zAlex, (club.Alex, 16m), (club.Jo, 16m));
            (alex, jo) = (seats[0], seats[1]);
        }
        else
        {
            zAlex = await club.InsertBookingAsync(f, PlayersClub.Tomorrow(8));
            zJo = await club.InsertBookingAsync(f, PlayersClub.Tomorrow(12));
            alex = (await AddAsync(club, f, zAlex, (club.Alex, 16m)))[0];
            jo = (await AddAsync(club, f, zJo, (club.Jo, 16m)))[0];
        }
        await AcceptAsync(club, f, club.Alex, zAlex, alex, 16m);
        await AcceptAsync(club, f, club.Jo, zJo, jo, 16m);
        await club.CreditAsync(f, club.Organiser, -32m);    // a desk debit: the holds are underwater
        Assert.Equal(0m, await PlayersClub.BalanceAsync(f, club.Organiser));

        Assert.True((await WithdrawAsync(club, f, club.Alex, zAlex, alex)).IsSuccessStatusCode);
        await Task.Delay(20);
        Assert.True((await WithdrawAsync(club, f, club.Jo, zJo, jo)).IsSuccessStatusCode);
        Assert.Equal(34m, await PlayersClub.BalanceAsync(f, club.Alex));
        Assert.Equal(34m, await PlayersClub.BalanceAsync(f, club.Jo));

        await club.CreditAsync(f, club.Organiser, 16m);     // straight to the table: no retry yet
        Assert.Equal(0m, await CoverageAsync(club, f, zJo, jo));
        Assert.Equal(16m, await CoverageAsync(club, f, zAlex, alex));

        // Jo's game reconciled FIRST: still Alex's money.
        await club.InClubAsync(f, sp => sp.GetRequiredService<ShareLedger>().ReconcileAsync(zJo, default));
        await club.InClubAsync(f, sp => sp.GetRequiredService<ShareLedger>().ReconcileAsync(zAlex, default));
        Assert.Equal(50m, await PlayersClub.BalanceAsync(f, club.Alex));
        Assert.Equal(34m, await PlayersClub.BalanceAsync(f, club.Jo));
    }

    // ------------------------------------------------------------------ LOW. a failed hook leaves a marker

    /// <summary>
    /// A desk credit to the organiser naming a month-old game cancelled after check-in lowers what
    /// they owe, so Sam is due his share back — but the post-settlement reconcile fails. The
    /// booking is outside the sweep's week and the start-up catch-up does not look at such games;
    /// the failed hook's durable marker is what brings the next minute sweep to it.
    /// </summary>
    [SkippableFact]
    public async Task A_failed_settlement_hook_is_made_good_by_the_next_sweep_however_old_the_booking()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "r5marker");
        var bookingId = await club.InsertBookingAsync(f, DateTimeOffset.UtcNow.AddDays(-30));
        await club.WriteAsync(f, db =>
        {
            var b = db.Bookings.IgnoreQueryFilters().First(x => x.Id == bookingId);
            b.Status = BookingStatus.Cancelled;
            b.CheckedInAt = b.StartsAt;
            b.ShareDeadlineAt = DateTimeOffset.UtcNow.AddDays(-28);
        });
        await club.InsertSeatAsync(f, bookingId, 1, club.Organiser, ParticipantStatus.Accepted, 16m);
        var sam = await club.InsertSeatAsync(f, bookingId, 2, club.Sam, ParticipantStatus.Accepted, 16m);
        await club.WriteAsync(f, db =>
        {
            db.BookingParticipants.IgnoreQueryFilters().First(p => p.Id == sam).ConsentedCredits = 16m;
            foreach (var posting in ShareLedger.Pair(new Booking { Id = bookingId }, new ShareMove(sam, club.Sam, club.Organiser, 16m, 1), club.Sam))
            {
                db.LedgerEntries.Add(new LedgerEntry
                {
                    TenantId = club.TenantId, UserId = posting.UserId, Type = posting.Type, AmountCredits = posting.AmountCredits,
                    ActorUserId = posting.ActorUserId, RelatedBookingId = bookingId, ExternalReference = posting.ExternalReference,
                });
            }
            // The desk's goodwill credit naming the game: what the organiser owes falls to nothing.
            db.LedgerEntries.Add(new LedgerEntry
            {
                TenantId = club.TenantId, UserId = club.Organiser, Type = LedgerEntryType.AdminAdjustment, AmountCredits = 32m,
                ActorUserId = club.Admin, RelatedBookingId = bookingId, Reason = "Court flooded",
            });
        });
        await club.CreditAsync(f, club.Sam, 16m);   // Sam at 0 after paying

        // The hook runs while the club's settings cannot be read: its reconcile throws, and is swallowed.
        await club.WriteAsync(f, db => db.TenantSettings.IgnoreQueryFilters().First(s => s.TenantId == club.TenantId).SettingsJson = "[]");
        await f.Services.GetRequiredService<ShareHook>().AfterSettlementAsync(club.TenantId, club.Slug, [bookingId], default);
        await club.WriteAsync(f, db => db.TenantSettings.IgnoreQueryFilters().First(s => s.TenantId == club.TenantId).SettingsJson = PlayersClub.Settings);
        Assert.Equal(0m, await PlayersClub.BalanceAsync(f, club.Sam));

        await club.InClubAsync(f, async sp =>
        {
            await sp.GetRequiredService<ShareSweep>().SweepAsync(DateTimeOffset.UtcNow, default);
            return 0;
        });

        Assert.Equal(16m, await PlayersClub.BalanceAsync(f, club.Sam));
    }

    // ------------------------------------------------------------------ LOW. one poisoned booking stops nothing else

    /// <summary>
    /// A recent played game where Sam paid 16 and came off, the organiser able to cover it: his
    /// return is due and the minute sweep will make it.
    /// </summary>
    /// <param name="lowered">
    /// Keep the partner ON the game with their share lowered to 8 instead: 8 is due back, but only
    /// through the minute sweep — the start-up catch-up looks only at seats whose target is nothing.
    /// </param>
    private static async Task<Guid> DueAsync(PlayersClub club, TestWebAppFactory f, Guid partner, DateTimeOffset start, bool lowered = false)
    {
        var bookingId = await club.InsertBookingAsync(f, start);
        await club.WriteAsync(f, db => db.Bookings.IgnoreQueryFilters().First(b => b.Id == bookingId).Status = BookingStatus.Completed);
        await club.InsertSeatAsync(f, bookingId, 1, club.Organiser, ParticipantStatus.Accepted, 16m);
        var seat = lowered
            ? await club.InsertSeatAsync(f, bookingId, 2, partner, ParticipantStatus.Accepted, 8m)
            : await club.InsertSeatAsync(f, bookingId, 2, partner, ParticipantStatus.Removed, 16m);
        await club.WriteAsync(f, db =>
        {
            db.BookingParticipants.IgnoreQueryFilters().First(p => p.Id == seat).ConsentedCredits = 16m;
            foreach (var posting in ShareLedger.Pair(new Booking { Id = bookingId }, new ShareMove(seat, partner, club.Organiser, 16m, 1), partner))
            {
                db.LedgerEntries.Add(new LedgerEntry
                {
                    TenantId = club.TenantId, UserId = posting.UserId, Type = posting.Type, AmountCredits = posting.AmountCredits,
                    ActorUserId = posting.ActorUserId, RelatedBookingId = bookingId, ExternalReference = posting.ExternalReference,
                });
            }
        });
        await club.CreditAsync(f, club.Organiser, 32m);
        await club.CreditAsync(f, partner, 16m);
        return bookingId;
    }

    /// <summary>
    /// Two games owe a return; the one the sweep reaches FIRST (the lower id, in Postgres' own
    /// order) is poisoned — any share row naming it is refused. The other is still paid.
    /// </summary>
    [SkippableFact]
    public async Task A_poisoned_booking_does_not_stop_the_rest_of_the_sweep()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "r5poison");
        var a = await DueAsync(club, f, club.Sam, DateTimeOffset.UtcNow.AddHours(-3));
        var b = await DueAsync(club, f, club.Jo, DateTimeOffset.UtcNow.AddHours(-6));
        var (poison, healthy, paid) = string.CompareOrdinal(a.ToString(), b.ToString()) < 0 ? (a, b, club.Jo) : (b, a, club.Sam);

        await using (await ShareSabotage.InstallAsync(f, poison))
        {
            await club.InClubAsync(f, async sp =>
            {
                await sp.GetRequiredService<ShareSweep>().SweepAsync(DateTimeOffset.UtcNow, default);
                return 0;
            });
        }

        Assert.Equal(16m, await PlayersClub.BalanceAsync(f, paid));
        var marked = await PlayersClub.ReadAsync(f, db => db.Bookings.IgnoreQueryFilters().Where(x => x.Id == poison).Select(x => x.ShareReconcileDueAt).FirstAsync());
        Assert.NotNull(marked);
        Assert.Null(await PlayersClub.ReadAsync(f, db => db.Bookings.IgnoreQueryFilters().Where(x => x.Id == healthy).Select(x => x.ShareReconcileDueAt).FirstAsync()));
    }

    /// <summary>
    /// A club whose start-up catch-up fails — a month-old game owing a return, poisoned — still
    /// gets its minute sweep on the same pass: a recent game's return, which only the sweep makes
    /// (a lowered share on a seat still in the game), is paid.
    /// </summary>
    [SkippableFact]
    public async Task A_failing_catch_up_does_not_stop_the_clubs_minute_sweep()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "r5worker");
        var old = await DueAsync(club, f, club.Sam, DateTimeOffset.UtcNow.AddDays(-30));
        await club.WriteAsync(f, db => db.Bookings.IgnoreQueryFilters().First(x => x.Id == old).ShareDeadlineAt = DateTimeOffset.UtcNow.AddDays(-28));
        await DueAsync(club, f, club.Jo, DateTimeOffset.UtcNow.AddHours(-3), lowered: true);

        await using (await ShareSabotage.InstallAsync(f, old))
        {
            await f.Services.GetRequiredService<Api.Workers.ShareWorker>().TickAsync(DateTimeOffset.UtcNow, default);
        }

        Assert.Equal(8m, await PlayersClub.BalanceAsync(f, club.Jo));
        Assert.Equal(0m, await PlayersClub.BalanceAsync(f, club.Sam));
    }
}

/// <summary>
/// Refuses every ledger row naming one booking — a poisoned booking whose reconcile always throws —
/// the same trigger technique as <see cref="ChangeLogSabotage"/>. Dropped on dispose.
/// </summary>
public sealed class ShareSabotage : IAsyncDisposable
{
    private readonly TestWebAppFactory _factory;
    private readonly string _name;

    private ShareSabotage(TestWebAppFactory factory, string name)
    {
        _factory = factory;
        _name = name;
    }

    public static async Task<ShareSabotage> InstallAsync(TestWebAppFactory factory, Guid bookingId)
    {
        var name = $"sabotage_{Guid.NewGuid():N}";
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        // Identifiers and literals are generated here, never taken from input.
#pragma warning disable EF1002
        await db.Database.ExecuteSqlRawAsync($"""
            CREATE FUNCTION {name}() RETURNS trigger AS $$
            BEGIN
              IF NEW."RelatedBookingId" = '{bookingId}'::uuid THEN
                RAISE EXCEPTION 'share row refused by test sabotage';
              END IF;
              RETURN NEW;
            END $$ LANGUAGE plpgsql;
            CREATE TRIGGER {name} BEFORE INSERT ON ledger_entries
              FOR EACH ROW EXECUTE FUNCTION {name}();
            """);
#pragma warning restore EF1002
        return new ShareSabotage(factory, name);
    }

    public async ValueTask DisposeAsync()
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
#pragma warning disable EF1002
        await db.Database.ExecuteSqlRawAsync($"DROP TRIGGER IF EXISTS {_name} ON ledger_entries; DROP FUNCTION IF EXISTS {_name}();");
#pragma warning restore EF1002
    }
}
