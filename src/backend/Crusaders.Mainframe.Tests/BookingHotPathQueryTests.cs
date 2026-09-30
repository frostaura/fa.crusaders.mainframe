using System.Collections.Concurrent;
using System.Data.Common;
using System.Net;
using System.Net.Http.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// What a member's own booking costs the database — the hottest write path in the product, run
/// under the payer's lock.
///
/// <para>
/// R19's change-record staging looked up the booked person's NAME before asking whether there
/// was anything to record, so every member self-booking and every court-box walk-up paid one
/// more read inside the lock for a row that is never written (review finding P3-2). The name is
/// only wanted for an on-behalf booking or an overdraft.
/// </para>
/// </summary>
public sealed class BookingHotPathQueryTests : IClassFixture<PostgresFixture>
{
    private readonly PostgresFixture _pg;

    public BookingHotPathQueryTests(PostgresFixture pg) => _pg = pg;

    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    /// <summary>Every command the app sends while recording is on.</summary>
    private sealed class RecordingInterceptor : DbCommandInterceptor
    {
        public ConcurrentQueue<string> Commands { get; } = new();

        public volatile bool On;

        public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(
            DbCommand command, CommandEventData eventData, InterceptionResult<DbDataReader> result,
            CancellationToken cancellationToken = default)
        {
            if (On) Commands.Enqueue(command.CommandText);
            return base.ReaderExecutingAsync(command, eventData, result, cancellationToken);
        }
    }

    /// <summary>
    /// <c>PersonNames.ForAsync</c>'s shape: a membership's user id and full name, and nothing
    /// else. Matched on the projection, because the membership GATE also reads memberships on
    /// this path and is meant to.
    /// </summary>
    private static bool IsNameLookup(string sql)
        => sql.Contains("\"FullName\"", StringComparison.Ordinal)
           && sql.Contains("FROM memberships", StringComparison.Ordinal)
           && !sql.Contains("\"Status\"", StringComparison.Ordinal);

    [SkippableFact]
    public async Task A_members_own_booking_does_not_look_up_a_name_it_never_writes()
    {
        Skip.IfNot(_pg.Available, Skipped);

        var recorder = new RecordingInterceptor();
        await using var factory = _pg.SharedHost;
        await using var app = factory.WithWebHostBuilder(b => b.ConfigureTestServices(s =>
            s.ConfigureDbContext<MainframeDbContext>(o => o.AddInterceptors(recorder))));

        var club = await DoorClub.SeedAsync(factory, "hotpath");
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            db.LedgerEntries.Add(new LedgerEntry
            {
                TenantId = club.TenantId,
                UserId = club.MemberUserId,
                Type = LedgerEntryType.TopUp,
                AmountCredits = 100m,
                ActorUserId = Guid.Empty,
                Reason = "fixture float",
            });
            await db.SaveChangesAsync();
        }

        var client = app.CreateClient();
        client.DefaultRequestHeaders.Authorization =
            new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", club.TokenFor(club.MemberUserId, null));
        var startsAt = new DateTimeOffset(DateTimeOffset.UtcNow.AddDays(2).Date.AddHours(9), TimeSpan.Zero);

        recorder.On = true;
        var response = await client.PostAsJsonAsync("/api/v1/bookings/", new { courtId = club.CourtId, startsAt, sliceCount = 1 });
        recorder.On = false;

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.NotEmpty(recorder.Commands);
        Assert.DoesNotContain(recorder.Commands, IsNameLookup);
    }
}
