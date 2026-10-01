using System.Net;
using System.Net.Http.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Services;
using static Crusaders.Mainframe.Tests.Play.PlayKit;

namespace Crusaders.Mainframe.Tests.Play;

/// <summary>
/// IDOR (<c>docs/specs/play.md</c> §6, §10): this club's ids, for a booking the caller is not a
/// player of — a bystander, an invited-but-not-accepted member, an admin on the member routes —
/// are 404 on every result route, never 403, and change nothing.
/// </summary>
public sealed class PlayIdorHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private TestWebAppFactory CreateFactory() => pg.SharedHost;

    [SkippableFact]
    public async Task A_non_player_of_this_club_gets_404_on_every_result_route_and_nothing_changes()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "id-routes");
        var booking = await club.GameAsync(f, DateTimeOffset.UtcNow.AddHours(-2).Storable(), club.Organiser, [club.Sam]);
        await club.InsertSeatAsync(f, booking, 3, club.Jo, ParticipantStatus.Invited, 0);
        var created = await (await RecordAsync(club.Client(f, club.Organiser), booking, [U(club.Organiser)], [U(club.Sam)])).JsonAsync();
        var version = created.GetProperty("version").GetInt32();
        var before = (await ResultRowAsync(f, booking))!;

        foreach (var outsider in new[] { club.Client(f, club.Bystander), club.Client(f, club.Jo), club.Client(f, club.Admin, admin: true) })
        {
            Assert.Equal(HttpStatusCode.NotFound, (await outsider.GetAsync($"/api/v1/bookings/{booking}/result")).StatusCode);
            Assert.Equal(HttpStatusCode.NotFound, (await RecordAsync(outsider, booking, [U(club.Bystander)], [U(club.Sam)])).StatusCode);
            Assert.Equal(HttpStatusCode.NotFound, (await outsider.PutAsJsonAsync($"/api/v1/bookings/{booking}/result", new
            {
                expectedVersion = version, format = "best_of_5", sideA = new[] { U(club.Organiser) }, sideB = new[] { U(club.Sam) }, games = ThreeOne,
            })).StatusCode);
            foreach (var action in new[] { "confirm", "dispute", "withdraw" })
            {
                var response = await ActAsync(outsider, booking, action, version);
                Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
                Assert.Equal("booking_not_found", (await response.JsonAsync()).GetProperty("error").GetString());
            }
        }

        var after = (await ResultRowAsync(f, booking))!;
        Assert.Equal((before.Status, before.Version, before.SubmittedByUserId), (after.Status, after.Version, after.SubmittedByUserId));
        Assert.Equal(HttpStatusCode.NotFound, (await club.Client(f, club.Organiser).GetAsync($"/api/v1/bookings/{Guid.NewGuid()}/result")).StatusCode);
    }

    /// <summary>A replayed key names a row of the caller's own; another member's key is theirs to reuse and names nothing of anybody else's.</summary>
    [SkippableFact]
    public async Task An_idempotency_key_is_the_callers_own_and_cannot_fetch_another_members_result()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "id-key");
        var theirs = await club.GameAsync(f, DateTimeOffset.UtcNow.AddHours(-2).Storable(), club.Organiser, [club.Sam]);
        await RecordAsync(club.Client(f, club.Organiser), theirs, [U(club.Organiser)], [U(club.Sam)], key: "shared-key");

        var mine = await club.GameAsync(f, DateTimeOffset.UtcNow.AddHours(-5).Storable(), club.Alex, [club.Jo]);
        var response = await RecordAsync(club.Client(f, club.Alex), mine, [U(club.Alex)], [U(club.Jo)], key: "shared-key");
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        Assert.Equal(mine, (await response.JsonAsync()).GetProperty("booking_id").GetGuid());

        // The same key replayed by the Organiser on a different booking is refused, not answered with the first.
        var reused = await RecordAsync(club.Client(f, club.Organiser), mine, [U(club.Organiser)], [U(club.Sam)], key: "shared-key");
        Assert.Equal(HttpStatusCode.BadRequest, reused.StatusCode);
    }
}
