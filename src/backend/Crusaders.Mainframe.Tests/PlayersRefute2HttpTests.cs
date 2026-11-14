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
/// The second refuter round on the P11 players fixes (D11), on Postgres: a return must be
/// COVERED to post — whatever the deadline — a waiting return is never stranded, and the deadline
/// backfill reads the setting exactly as the app does. Each test failed on the code it follows.
/// </summary>
public sealed class PlayersRefute2HttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    /// <summary>The kind the partner and the organiser are told a return is waiting under.</summary>
    private const string ReturnWaitingKind = "players.return_waiting";

    private TestWebAppFactory CreateFactory() => pg.SharedHost;

    private static async Task<JsonElement> JsonAsync(HttpResponseMessage response) =>
        await response.Content.ReadFromJsonAsync<JsonElement>();

    private static string? Error(JsonElement body) => body.TryGetProperty("error", out var e) ? e.GetString() : null;

    /// <summary>
    /// A game cancelled AFTER check-in (S4): nothing is refunded, every share stays owed in full,
    /// so nothing is held and the organiser may spend Sam's 16 — and does. Balance 0.
    /// </summary>
    private static async Task<(Guid BookingId, Guid Seat)> SpentS4GameAsync(PlayersClub club, TestWebAppFactory f)
    {
        await club.CreditAsync(f, club.Organiser, 32);
        await club.CreditAsync(f, club.Sam, 50);
        var bookingId = await club.InsertBookingAsync(f, DateTimeOffset.UtcNow.AddMinutes(40));
        var organiser = club.Client(f, club.Organiser);
        var add = await organiser.PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players", new { players = new object[] { new { userId = club.Sam } } });
        Assert.True(add.IsSuccessStatusCode, await add.Content.ReadAsStringAsync());
        var seat = (await JsonAsync(add)).GetProperty("participants")[0].GetProperty("participant_id").GetGuid();
        var accept = await club.Client(f, club.Sam).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players/{seat}/accept", new { expectedShareMinutes = 16 });
        Assert.True(accept.IsSuccessStatusCode, await accept.Content.ReadAsStringAsync());

        await club.WriteAsync(f, db => db.Bookings.IgnoreQueryFilters().First(b => b.Id == bookingId).CheckedInAt = DateTimeOffset.UtcNow);
        // R15 D15-5: a member may not cancel once checked in — the S4 cancel is the desk's now (same money: (0, 0), shares owed).
        var cancel = await club.Client(f, club.Admin, admin: true).PostAsJsonAsync($"/api/v1/admin/bookings/{bookingId}/cancel", new { reason = "Court flooded" });
        Assert.True(cancel.IsSuccessStatusCode, await cancel.Content.ReadAsStringAsync());
        Assert.Equal(16, await PlayersClub.BalanceAsync(f, club.Organiser));

        var spend = await organiser.PostAsJsonAsync("/api/v1/bookings",
            new { courtId = club.CourtId, startsAt = PlayersClub.Tomorrow(8).AddDays(1), sliceCount = 2 });
        Assert.True(spend.IsSuccessStatusCode, await spend.Content.ReadAsStringAsync());
        Assert.Equal(0, await PlayersClub.BalanceAsync(f, club.Organiser));
        return (bookingId, seat);
    }

    /// <summary>
    /// A played game past its deadline on which Sam paid 16, the organiser spent it, and Sam's
    /// seat came off — the return is waiting on an organiser at 0.
    /// </summary>
    private static async Task<(Guid BookingId, Guid Seat)> WaitingReturnAsync(PlayersClub club, TestWebAppFactory f, int daysAgo)
    {
        var bookingId = await club.InsertBookingAsync(f, DateTimeOffset.UtcNow.AddDays(-daysAgo));
        await club.WriteAsync(f, db => db.Bookings.IgnoreQueryFilters().First(b => b.Id == bookingId).Status = BookingStatus.Completed);
        await club.InsertSeatAsync(f, bookingId, 1, club.Organiser, ParticipantStatus.Accepted, 16);
        var seat = await club.InsertSeatAsync(f, bookingId, 2, club.Sam, ParticipantStatus.Accepted, 16);
        await club.WriteAsync(f, db =>
        {
            db.Bookings.IgnoreQueryFilters().First(b => b.Id == bookingId).ShareDeadlineAt = DateTimeOffset.UtcNow.AddDays(2 - daysAgo);
            db.BookingParticipants.IgnoreQueryFilters().First(p => p.Id == seat).ConsentedMinutes = 16;
            foreach (var posting in ShareLedger.Pair(new Booking { Id = bookingId }, new ShareMove(seat, club.Sam, club.Organiser, 16, 1), club.Sam))
            {
                db.LedgerEntries.Add(new LedgerEntry
                {
                    TenantId = club.TenantId,
                    UserId = posting.UserId,
                    Type = posting.Type,
                    AmountMinutes = posting.AmountMinutes,
                    ActorUserId = posting.ActorUserId,
                    RelatedBookingId = bookingId,
                    ExternalReference = posting.ExternalReference,
                });
            }
        });
        await club.CreditAsync(f, club.Organiser, 32);
        await club.CreditAsync(f, club.Organiser, -16);
        await club.CreditAsync(f, club.Sam, 16);
        await club.WriteAsync(f, db => db.BookingParticipants.IgnoreQueryFilters().First(p => p.Id == seat).Status = ParticipantStatus.Removed);
        await club.InClubAsync(f, sp => sp.GetRequiredService<ShareLedger>().ReconcileAsync(bookingId, default));
        Assert.Equal(0, await PlayersClub.BalanceAsync(f, club.Organiser));
        Assert.Equal(0, await PlayersClub.BalanceAsync(f, club.Sam));
        return (bookingId, seat);
    }

    // ------------------------------------------------------------------ H1. coverage, not the deadline

    /// <summary>
    /// Before the deadline, on a game cancelled after check-in, an admin remove or settle-outside
    /// would hand back a share the organiser was free to spend and did. It is not covered, so it
    /// needs the overdraft said by name — refused without it, whatever the deadline.
    /// </summary>
    [SkippableTheory]
    [InlineData("remove")]
    [InlineData("settle-outside")]
    public async Task An_uncovered_admin_return_needs_the_overdraft_even_before_the_deadline(string action)
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, $"r2adm{action.Length}");
        var (bookingId, seat) = await SpentS4GameAsync(club, f);
        var admin = club.Client(f, club.Admin, admin: true);
        var path = $"/api/v1/admin/bookings/{bookingId}/players/{seat}/{action}";

        var refused = await admin.PostAsJsonAsync(path, new { reason = "Asked for it back" });
        Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);
        Assert.Equal(PlayerErrors.OverdraftNotAuthorised, Error(await JsonAsync(refused)));
        Assert.Equal(0, await PlayersClub.BalanceAsync(f, club.Organiser));

        var forced = await admin.PostAsJsonAsync(path, new { reason = "Agreed at the desk", allowNegativeBalance = true });
        Assert.True(forced.IsSuccessStatusCode, await forced.Content.ReadAsStringAsync());
        Assert.Equal(-16, await PlayersClub.BalanceAsync(f, club.Organiser));
    }

    /// <summary>The ledger's own rule, on any path: an uncovered return waits, before the deadline too.</summary>
    [SkippableFact]
    public async Task An_uncovered_return_waits_even_before_the_deadline()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "r2wait");
        var (bookingId, seat) = await SpentS4GameAsync(club, f);
        await club.WriteAsync(f, db => db.BookingParticipants.IgnoreQueryFilters().First(p => p.Id == seat).Status = ParticipantStatus.Removed);

        var moves = await club.InClubAsync(f, sp => sp.GetRequiredService<ShareLedger>().ReconcileAsync(bookingId, default));

        Assert.Empty(moves);
        Assert.Equal(0, await PlayersClub.BalanceAsync(f, club.Organiser));
        Assert.NotNull((await club.SeatsAsync(f, bookingId)).Single(s => s.Id == seat).ReturnPendingSince);
    }

    // ------------------------------------------------------------------ M1. a waiting return is never stranded

    /// <summary>
    /// Long past the sweep's week, a waiting return is still swept: the sweep selects on the
    /// seat's pending stamp, not the booking's age.
    /// </summary>
    [SkippableFact]
    public async Task A_waiting_return_is_swept_however_old_the_booking()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "r2old");
        var (bookingId, seat) = await WaitingReturnAsync(club, f, daysAgo: 10);
        await club.CreditAsync(f, club.Organiser, 100);   // straight to the table: no hook runs

        await club.InClubAsync(f, async sp =>
        {
            await sp.GetRequiredService<ShareSweep>().SweepAsync(DateTimeOffset.UtcNow, default);
            return 0;
        });

        Assert.Equal(16, await PlayersClub.BalanceAsync(f, club.Sam));
        Assert.Equal(84, await PlayersClub.BalanceAsync(f, club.Organiser));
        Assert.Null((await club.SeatsAsync(f, bookingId)).Single(s => s.Id == seat).ReturnPendingSince);
    }

    /// <summary>A credit reaching the organiser — here a desk top-up naming no booking — pays a waiting return at once.</summary>
    [SkippableFact]
    public async Task A_credit_to_the_organiser_pays_a_waiting_return_at_once()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "r2credit");
        await WaitingReturnAsync(club, f, daysAgo: 10);

        var topUp = await club.Client(f, club.Admin, admin: true).PostAsJsonAsync($"/api/v1/admin/minutes/{club.Organiser}/adjust",
            new { amountMinutes = 20, reason = "Cash at the desk", reasonCode = "goodwill" });

        Assert.True(topUp.IsSuccessStatusCode, await topUp.Content.ReadAsStringAsync());
        Assert.Equal(16, await PlayersClub.BalanceAsync(f, club.Sam));
        Assert.Equal(4, await PlayersClub.BalanceAsync(f, club.Organiser));
    }

    /// <summary>
    /// The partner and the organiser are told once that a return is waiting — not on every
    /// reconcile or every sweep that finds it still waiting.
    /// </summary>
    [SkippableFact]
    public async Task A_waiting_return_is_told_once_to_both_sides()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "r2told");
        var (bookingId, _) = await WaitingReturnAsync(club, f, daysAgo: 10);
        for (var i = 0; i < 2; i++)
        {
            await club.InClubAsync(f, sp => sp.GetRequiredService<ShareLedger>().ReconcileAsync(bookingId, default));
            await club.InClubAsync(f, async sp =>
            {
                await sp.GetRequiredService<ShareSweep>().SweepAsync(DateTimeOffset.UtcNow, default);
                return 0;
            });
        }

        var told = await PlayersClub.ReadAsync(f, db => db.MemberNotifications.IgnoreQueryFilters()
            .Where(n => n.TenantId == club.TenantId && n.Kind == ReturnWaitingKind).Select(n => n.UserId).ToListAsync());
        Assert.Equal(new[] { club.Organiser, club.Sam }.Order(), told.Order());
    }

    // ------------------------------------------------------------------ L1. the backfill reads the setting as the app does

    /// <summary>
    /// The deadline backfill and the C# reader agree for every shape the setting can take: a
    /// JSON string is not a number to the reader, a ten-digit number past int range is not an
    /// int, and anything unreadable is 48.
    /// </summary>
    [SkippableTheory]
    [InlineData("\"100\"")]
    [InlineData("100")]
    [InlineData("12.5")]
    [InlineData("2147483648")]
    [InlineData("1000000000")]
    [InlineData("-5")]
    [InlineData("true")]
    public async Task The_deadline_backfill_reads_the_setting_exactly_as_the_app_does(string value)
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "r2fill", PlayersClub.Settings.Replace("}", $",\"share_lapse_hours\":{value}}}"));
        var bookingId = await club.InsertBookingAsync(f, DateTimeOffset.UtcNow.AddDays(-1));
        await club.InsertSeatAsync(f, bookingId, 1, club.Organiser, ParticipantStatus.Accepted, 32);

        var (stamped, expected) = await club.InClubAsync(f, async sp =>
        {
            var db = sp.GetRequiredService<MainframeDbContext>();
            // ExecuteSqlRaw formats its string, so the SQL's own braces are escaped; the migration runs it as is.
            var sql = ShareDeadlineBackfill.Sql($"AND b.\"Id\" = '{bookingId}'").Replace("{", "{{").Replace("}", "}}");
            await db.Database.ExecuteSqlRawAsync(sql);
            var b = await db.Bookings.AsNoTracking().FirstAsync(x => x.Id == bookingId);
            var settings = await sp.GetRequiredService<TenantSettingsAccessor>().GetAsync(default);
            return (b.ShareDeadlineAt, PlayerSettings.DeadlineFromSettings(b, settings));
        });

        Assert.Equal(expected, stamped!.Value);
    }
}
