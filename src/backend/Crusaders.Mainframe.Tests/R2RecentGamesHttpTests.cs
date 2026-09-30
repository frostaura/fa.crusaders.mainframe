using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using static Crusaders.Mainframe.Tests.Play.PlayKit;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 2, C3 (MJ-H): once a game ended it left <c>/me/bookings/upcoming</c> and nothing
/// listed it, so "Record a result" and "Confirm" had no way in. <c>GET /me/bookings/recent</c>
/// lists the caller's games — organiser or accepted partner — that ended within the result
/// window, newest first, each with <c>result_status</c> and <c>can_record</c>.
/// </summary>
public sealed class R2RecentGamesHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private TestWebAppFactory CreateFactory() => new() { ConnectionString = pg.ConnectionString };

    private static async Task<JsonElement> RecentAsync(HttpClient client)
    {
        var response = await client.GetAsync("/api/v1/me/bookings/recent");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return await response.Content.ReadFromJsonAsync<JsonElement>();
    }

    private static List<Guid> Ids(JsonElement body) =>
        body.GetProperty("items").EnumerateArray().Select(i => i.GetProperty("booking_id").GetGuid()).ToList();

    private static JsonElement Item(JsonElement body, Guid bookingId) =>
        body.GetProperty("items").EnumerateArray().Single(i => i.GetProperty("booking_id").GetGuid() == bookingId);

    [SkippableFact]
    public async Task Games_that_ended_inside_the_window_are_listed_newest_first_for_organiser_and_accepted_partner_only()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "r2recent", timezone: "Africa/Johannesburg");
        var now = DateTimeOffset.UtcNow.Storable();

        var older = await club.GameAsync(f, now.AddDays(-3), club.Organiser, [club.Sam]);
        var newer = await club.GameAsync(f, now.AddHours(-3), club.Organiser, [club.Sam]);
        var unscanned = await club.GameAsync(f, now.AddHours(-5), club.Organiser, [club.Sam], checkIn: false);
        var tooOld = await club.GameAsync(f, now.AddDays(-9), club.Organiser, [club.Sam]);
        var ahead = await club.GameAsync(f, now.AddHours(5), club.Organiser, [club.Sam], checkIn: false);
        var cancelled = await club.GameAsync(f, now.AddHours(-6), club.Organiser, [club.Sam]);
        await club.WriteAsync(f, db => db.Bookings.IgnoreQueryFilters().First(b => b.Id == cancelled).Status = BookingStatus.Cancelled);
        var invitedOnly = await club.InsertBookingAsync(f, now.AddHours(-8));
        await club.InsertSeatAsync(f, invitedOnly, 1, club.Organiser, ParticipantStatus.Accepted, 0m);
        await club.InsertSeatAsync(f, invitedOnly, 2, club.Alex, ParticipantStatus.Invited, 16m);

        var olive = await RecentAsync(club.Client(f, club.Organiser));
        Assert.Equal("Africa/Johannesburg", olive.GetProperty("timezone").GetString());
        Assert.Equal([newer, unscanned, invitedOnly, older], Ids(olive));

        var sam = await RecentAsync(club.Client(f, club.Sam));
        Assert.Equal([newer, unscanned, older], Ids(sam));
        Assert.Equal("partner", Item(sam, newer).GetProperty("role").GetString());
        Assert.Equal("organiser", Item(olive, newer).GetProperty("role").GetString());

        Assert.Empty(Ids(await RecentAsync(club.Client(f, club.Alex))));          // an unanswered invite is not a game played
        Assert.Empty(Ids(await RecentAsync(club.Client(f, club.Bystander))));
        Assert.DoesNotContain(tooOld, Ids(olive));
        Assert.DoesNotContain(ahead, Ids(olive));
    }

    [SkippableFact]
    public async Task Each_game_says_its_result_state_and_whether_the_caller_can_record_one()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "r2recres");
        var now = DateTimeOffset.UtcNow.Storable();
        var played = await club.GameAsync(f, now.AddHours(-3), club.Organiser, [club.Sam]);
        var unscanned = await club.GameAsync(f, now.AddHours(-5), club.Organiser, [club.Sam], checkIn: false);

        var before = await RecentAsync(club.Client(f, club.Sam));
        Assert.Equal("none", Item(before, played).GetProperty("result_status").GetString());
        Assert.True(Item(before, played).GetProperty("can_record").GetBoolean());
        Assert.Equal("none", Item(before, unscanned).GetProperty("result_status").GetString());
        Assert.False(Item(before, unscanned).GetProperty("can_record").GetBoolean());

        var v = (await (await RecordAsync(club.Client(f, club.Organiser), played, [U(club.Organiser)], [U(club.Sam)])).JsonAsync())
            .GetProperty("version").GetInt32();
        var pending = Item(await RecentAsync(club.Client(f, club.Sam)), played);
        Assert.Equal("pending", pending.GetProperty("result_status").GetString());
        Assert.False(pending.GetProperty("can_record").GetBoolean());

        Assert.True((await ActAsync(club.Client(f, club.Sam), played, "dispute", v, "wrong")).IsSuccessStatusCode);
        Assert.Equal("disputed", Item(await RecentAsync(club.Client(f, club.Organiser)), played).GetProperty("result_status").GetString());
    }

    /// <summary>The upcoming list keeps its shape: the two recent-only fields are not sent there.</summary>
    [SkippableFact]
    public async Task The_upcoming_list_carries_no_result_fields()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "r2recup");
        var ahead = await club.GameAsync(f, DateTimeOffset.UtcNow.AddHours(5).Storable(), club.Organiser, [club.Sam], checkIn: false);

        var response = await club.Client(f, club.Sam).GetAsync("/api/v1/me/bookings/upcoming");
        var item = (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("items").EnumerateArray().Single();
        Assert.Equal(ahead, item.GetProperty("booking_id").GetGuid());
        Assert.False(item.TryGetProperty("result_status", out _));
        Assert.False(item.TryGetProperty("can_record", out _));
        foreach (var key in new[] { "court_name", "starts_at", "ends_at", "role", "status", "players", "my_share_credits", "needs_action" })
        {
            Assert.True(item.TryGetProperty(key, out _), key);
        }
    }

    /// <summary>A second club's member sees none of this club's games — tenant isolation on the new read.</summary>
    [SkippableFact]
    public async Task Another_clubs_member_sees_nothing_of_this_clubs_games()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "r2recA");
        var other = await SeedAsync(f, "r2recB");
        await club.GameAsync(f, DateTimeOffset.UtcNow.AddHours(-3).Storable(), club.Organiser, [club.Sam]);

        // The other club's token, naming THIS club's member id as its subject.
        var forged = other.Client(f, club.Sam);
        var response = await forged.GetAsync("/api/v1/me/bookings/recent");
        if (response.StatusCode == HttpStatusCode.OK)
        {
            Assert.Empty(Ids(await response.Content.ReadFromJsonAsync<JsonElement>()));
        }
        else
        {
            Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        }
    }
}
