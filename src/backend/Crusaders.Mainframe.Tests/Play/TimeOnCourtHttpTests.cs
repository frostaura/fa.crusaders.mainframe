using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Microsoft.EntityFrameworkCore;
using static Crusaders.Mainframe.Tests.Play.PlayKit;

namespace Crusaders.Mainframe.Tests.Play;

/// <summary>
/// Review round 8, E8-4: "time on court" is ONE figure on every member screen. Profile (<c>/me/play</c>)
/// counted attended sessions as a booker OR an accepted partner, by the row as it stands (a released
/// tail, a cancellation after check-in); Wallet activity (<c>/reports/me/wallet</c>, <c>/daily</c>)
/// counted only bookings the member had made themselves, at their SOLD length. Both now read
/// <c>AttendanceQuery</c> — play.md §1 — so the two screens agree over any window.
/// </summary>
public sealed class TimeOnCourtHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private static async Task<JsonElement> GetAsync(HttpClient client, string path)
        => await (await client.GetAsync(path)).Content.ReadFromJsonAsync<JsonElement>();

    [SkippableFact]
    public async Task The_wallet_report_counts_time_on_court_by_the_play_rule()
    {
        Skip.IfNot(pg.Available, Skipped);
        var f = pg.SharedHost;
        var club = await SeedAsync(f, "toc");
        var start = new DateTimeOffset(DateTimeOffset.UtcNow.Year, 1, 5, 10, 0, 0, TimeSpan.Zero);

        // Sam is a PARTNER on both: one released after 37 minutes, one cancelled 20 minutes in.
        var released = await club.GameAsync(f, start, club.Organiser, [club.Sam]);
        await club.WriteAsync(f, db => db.Bookings.IgnoreQueryFilters().First(b => b.Id == released).EndsAt = start.AddMinutes(37));
        var cancelled = await club.GameAsync(f, start.AddDays(1), club.Organiser, [club.Sam]);
        await club.WriteAsync(f, db =>
        {
            var b = db.Bookings.IgnoreQueryFilters().First(x => x.Id == cancelled);
            b.Status = BookingStatus.Cancelled;
            b.CancelledAt = start.AddDays(1).AddMinutes(20);
        });
        // Outside the window: counts on the profile's all-time figure, not in this report.
        await club.GameAsync(f, start.AddDays(10), club.Organiser, [club.Sam]);

        var window = $"from={start:yyyy-MM-dd}T00:00:00Z&to={start.AddDays(1):yyyy-MM-dd}T00:00:00Z";
        foreach (var who in new[] { club.Sam, club.Organiser })
        {
            var client = club.Client(f, who);
            var wallet = await GetAsync(client, $"/api/v1/reports/me/wallet?{window}");
            // R17 J17-5: the session the club cancelled 20 minutes in is not attended — on the report as on the profile.
            Assert.Equal(37, wallet.GetProperty("minutes_on_court").GetInt32());
            Assert.Equal(1, wallet.GetProperty("attended_bookings").GetInt32());

            var daily = await GetAsync(client, $"/api/v1/reports/me/daily?{window}");
            var byDay = daily.EnumerateArray().ToDictionary(
                d => d.GetProperty("date").GetString()!, d => (d.GetProperty("minutes_on_court").GetInt32(), d.GetProperty("attended").GetInt32()));
            Assert.Equal((37, 1), byDay[$"{start:yyyy-MM-dd}"]);
            Assert.Equal((0, 0), byDay.GetValueOrDefault($"{start.AddDays(1):yyyy-MM-dd}"));

            // The profile's all-time figure is the same rule over all time: the window's one plus the third.
            var play = (await MyGameAsync(client)).GetProperty("stats");
            Assert.Equal(37 + 32, play.GetProperty("minutes_on_court").GetInt32());
        }
    }
}
