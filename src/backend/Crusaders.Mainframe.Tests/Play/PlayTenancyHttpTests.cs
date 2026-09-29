using System.Net;
using System.Net.Http.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using static Crusaders.Mainframe.Tests.Play.PlayKit;

namespace Crusaders.Mainframe.Tests.Play;

/// <summary>
/// Cross-tenant, non-negotiable (<c>docs/specs/play.md</c> §10): a result, badge, celebration, pause
/// or profile of another club is invisible and unactionable on every route — 404 and no row
/// changed — and the worker never evaluates across clubs.
/// </summary>
public sealed class PlayTenancyHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private TestWebAppFactory CreateFactory() => new() { ConnectionString = pg.ConnectionString };

    private sealed record Other(PlayersClub Club, Guid Booking, Guid Result, int Version, Guid Celebration);

    private static async Task<Other> OtherClubAsync(TestWebAppFactory f)
    {
        var club = await SeedAsync(f, "tn-other");
        var booking = await club.GameAsync(f, DateTimeOffset.UtcNow.AddHours(-2).Storable(), club.Organiser, [club.Sam]);
        var r = await (await RecordAsync(club.Client(f, club.Organiser), booking, [U(club.Organiser)], [U(club.Sam)])).JsonAsync();
        var celebration = (await CelebrationsAsync(f, club.Sam)).First().Id;
        return new Other(club, booking, r.GetProperty("result_id").GetGuid(), r.GetProperty("version").GetInt32(), celebration);
    }

    [SkippableFact]
    public async Task Every_member_route_answers_404_for_another_clubs_booking_and_changes_nothing()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var other = await OtherClubAsync(f);
        var mine = await SeedAsync(f, "tn-mine");
        var me = mine.Client(f, mine.Organiser);
        var before = (await ResultRowAsync(f, other.Booking))!;

        var b = other.Booking;
        Assert.Equal(HttpStatusCode.NotFound, (await me.GetAsync($"/api/v1/bookings/{b}/result")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await RecordAsync(me, b, [U(mine.Organiser)], [U(other.Club.Sam)])).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await me.PutAsJsonAsync($"/api/v1/bookings/{b}/result", new
        {
            expectedVersion = other.Version, format = "best_of_5", sideA = new[] { U(mine.Organiser) }, sideB = new[] { U(other.Club.Sam) }, games = ThreeOne,
        })).StatusCode);
        foreach (var action in new[] { "confirm", "dispute", "withdraw" })
        {
            Assert.Equal(HttpStatusCode.NotFound, (await ActAsync(me, b, action, other.Version)).StatusCode);
        }

        // The other club's own member, holding a token of the other club, is the only one who sees it.
        Assert.Equal(HttpStatusCode.OK, (await other.Club.Client(f, other.Club.Sam).GetAsync($"/api/v1/bookings/{b}/result")).StatusCode);

        var seen = await (await mine.Client(f, mine.Sam).PostAsJsonAsync("/api/v1/me/play/celebrations/seen", new { ids = new[] { other.Celebration } })).JsonAsync();
        Assert.Equal(0, seen.GetProperty("seen").GetInt32());

        var after = (await ResultRowAsync(f, other.Booking))!;
        Assert.Equal((before.Status, before.Version, before.GamesJson), (after.Status, after.Version, after.GamesJson));
        Assert.All(await CelebrationsAsync(f, other.Club.Sam), c => Assert.Null(c.SeenAt));
        Assert.Equal(0, await PlayersClub.ReadAsync(f, db => db.MatchResults.IgnoreQueryFilters().CountAsync(r => r.TenantId == mine.TenantId)));
    }

    [SkippableFact]
    public async Task Every_admin_route_answers_404_for_another_clubs_result_or_member_and_the_lists_hold_only_this_club()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var other = await OtherClubAsync(f);
        await ActAsync(other.Club.Client(f, other.Club.Sam), other.Booking, "dispute", other.Version, "theirs");
        var mine = await SeedAsync(f, "tn-admin");
        var admin = mine.Client(f, mine.Admin, admin: true);

        Assert.Equal(HttpStatusCode.NotFound, (await admin.PostAsJsonAsync($"/api/v1/admin/play/results/{other.Result}/void", new { reason = "x" })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await admin.PostAsJsonAsync($"/api/v1/admin/play/results/{other.Result}/uphold", new { reason = "x" })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await admin.GetAsync($"/api/v1/admin/members/{other.Club.Sam}/play")).StatusCode);
        Assert.Equal(0, (await (await admin.GetAsync("/api/v1/admin/play/results?status=all")).JsonAsync()).GetProperty("count").GetInt32());
        Assert.Equal(0, (await (await admin.GetAsync("/api/v1/admin/play/results/disputed/count")).JsonAsync()).GetProperty("count").GetInt32());
        Assert.Equal(MatchResultStatus.Disputed, (await ResultRowAsync(f, other.Booking))!.Status);
        Assert.Empty(await PlayersClub.ReadAsync(f, db => db.AdminChangeLogs.IgnoreQueryFilters()
            .Where(l => l.Action == AdminChangeActions.PlayResultVoided || l.Action == AdminChangeActions.PlayResultUpheld).ToListAsync()));
    }

    /// <summary>
    /// A member's own page reads their club only: the same person id cannot exist twice, so the
    /// probe is a member of this club whose partner's badges, pauses and profile live in another.
    /// </summary>
    [SkippableFact]
    public async Task My_game_reads_only_this_club_and_the_worker_evaluates_each_club_as_itself()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var other = await OtherClubAsync(f);
        await other.Club.Client(f, other.Club.Sam).PostAsync("/api/v1/me/play/pause", null);
        var mine = await SeedAsync(f, "tn-game");

        // Rows of the other club written against a member id of THIS club: the filters must hide them.
        await other.Club.WriteAsync(f, db =>
        {
            db.MemberBadges.Add(new MemberBadge { TenantId = other.Club.TenantId, UserId = mine.Sam, BadgeKey = BadgeCatalogue.Sessions100, AwardedAt = DateTimeOffset.UtcNow, CreatedAt = DateTimeOffset.UtcNow });
            db.MemberStreakPauses.Add(new MemberStreakPause { TenantId = other.Club.TenantId, UserId = mine.Sam, StartedAt = DateTimeOffset.UtcNow, CreatedAt = DateTimeOffset.UtcNow });
            db.PlayCelebrations.Add(new PlayCelebration { TenantId = other.Club.TenantId, UserId = mine.Sam, Kind = "badge", DedupeKey = "badge:x", BadgeKey = "sessions_100", CreatedAt = DateTimeOffset.UtcNow });
            db.MemberPlayProfiles.Add(new MemberPlayProfile { TenantId = other.Club.TenantId, UserId = mine.Sam, MonthlyGoalMinutes = 600, CreatedAt = DateTimeOffset.UtcNow, UpdatedAt = DateTimeOffset.UtcNow });
        });

        var sam = mine.Client(f, mine.Sam);
        var game = await MyGameAsync(sam);
        Assert.False(game.GetProperty("pause").GetProperty("active").GetBoolean());
        Assert.Equal(System.Text.Json.JsonValueKind.Null, game.GetProperty("ring").ValueKind);
        Assert.DoesNotContain(game.GetProperty("badges").EnumerateArray(), b => b.GetProperty("earned").GetBoolean());
        Assert.Empty((await (await sam.GetAsync("/api/v1/me/play/celebrations")).JsonAsync()).GetProperty("items").EnumerateArray());
        Assert.Equal("pause_not_active", (await (await sam.DeleteAsync("/api/v1/me/play/pause")).JsonAsync()).GetProperty("error").GetString());

        // A booking in this club; the worker's pass stamps each club's rows with its own tenant.
        await mine.GameAsync(f, DateTimeOffset.UtcNow.AddHours(-2).Storable(), mine.Organiser, [mine.Sam]);
        await PlayKit.TickAsync(f, DateTimeOffset.UtcNow);
        var rows = await PlayersClub.ReadAsync(f, db => db.MemberBadges.IgnoreQueryFilters().Where(b => b.UserId == mine.Sam).ToListAsync());
        Assert.Contains(rows, b => b.TenantId == mine.TenantId && b.BadgeKey == BadgeCatalogue.FirstSession);
        Assert.DoesNotContain(rows, b => b.TenantId == other.Club.TenantId && b.BadgeKey == BadgeCatalogue.FirstSession);
        Assert.DoesNotContain(await PlayersClub.ReadAsync(f, db => db.MemberBadges.IgnoreQueryFilters().Where(b => b.UserId == other.Club.Sam).ToListAsync()),
            b => b.TenantId == mine.TenantId);
    }
}
