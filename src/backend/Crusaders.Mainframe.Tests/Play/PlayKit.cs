using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Workers;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests.Play;

/// <summary>
/// Fixtures for the play suites (D14): games written straight to the table at any instant, the box's
/// check-in stamped through the app's own context (so the save-level marker staging runs exactly as
/// a real check-in's does), and the result routes as a member's client calls them.
/// </summary>
public static class PlayKit
{
    public const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    /// <summary>A UTC club with quiet hours off (<see cref="PlayersClub.Settings"/>), plus any extra settings keys.</summary>
    public static Task<PlayersClub> SeedAsync(WebApplicationFactory<Program> f, string prefix, string? extra = null, string timezone = "UTC")
    {
        var settings = PlayersClub.Settings.Replace("\"timezone\":\"UTC\"", $"\"timezone\":\"{timezone}\"");
        if (extra is not null) settings = settings.TrimEnd('}') + "," + extra + "}";
        return PlayersClub.SeedAsync(f, prefix, settings);
    }

    /// <summary>
    /// A booking by <paramref name="organiser"/> at <paramref name="startsAt"/> with accepted member
    /// seats for <paramref name="partners"/> (seats 2, 3, 4 in order), checked in at the box when
    /// <paramref name="checkIn"/>.
    /// </summary>
    public static async Task<Guid> GameAsync(
        this PlayersClub club, WebApplicationFactory<Program> f, DateTimeOffset startsAt, Guid organiser, IReadOnlyList<Guid> partners,
        bool checkIn = true)
    {
        var bookingId = await club.InsertBookingAsync(f, startsAt, organiser: organiser);
        if (partners.Count > 0)
        {
            await club.InsertSeatAsync(f, bookingId, 1, organiser, ParticipantStatus.Accepted, 0);
            for (var i = 0; i < partners.Count; i++) await club.InsertSeatAsync(f, bookingId, i + 2, partners[i], ParticipantStatus.Accepted, 0);
        }
        if (checkIn) await club.CheckInAsync(f, bookingId, startsAt.AddMinutes(2));
        return bookingId;
    }

    /// <summary>The box's check-in, through the app's context: the booking's own <c>CheckedInAt</c>.</summary>
    public static Task CheckInAsync(this PlayersClub club, WebApplicationFactory<Program> f, Guid bookingId, DateTimeOffset at) =>
        club.InClubAsync(f, async sp =>
        {
            var db = sp.GetRequiredService<MainframeDbContext>();
            (await db.Bookings.FirstAsync(b => b.Id == bookingId)).CheckedInAt = at.Storable();
            return await db.SaveChangesAsync();
        });

    /// <summary>A guest seat on the booking.</summary>
    public static async Task<Guid> GuestAsync(this PlayersClub club, WebApplicationFactory<Program> f, Guid bookingId, int seat, string name)
    {
        var row = new BookingParticipant
        {
            TenantId = club.TenantId, BookingId = bookingId, Seat = seat, GuestName = name, Status = ParticipantStatus.Accepted,
            InvitedAt = DateTimeOffset.UtcNow, CreatedAt = DateTimeOffset.UtcNow, UpdatedAt = DateTimeOffset.UtcNow,
        };
        await club.WriteAsync(f, db => db.BookingParticipants.Add(row));
        return row.Id;
    }

    public static string U(Guid userId) => $"u:{userId}";

    public static object[] G(params (int A, int B)[] games) => games.Select(g => (object)new { a = g.A, b = g.B }).ToArray();

    /// <summary>A 3–1 best of five, side a winning.</summary>
    public static readonly object[] ThreeOne = G((11, 7), (9, 11), (11, 5), (11, 8));

    public static Task<HttpResponseMessage> RecordAsync(
        HttpClient client, Guid bookingId, string[] sideA, string[] sideB, object[]? games = null, string? key = null, string format = "best_of_5") =>
        client.PostAsJsonAsync($"/api/v1/bookings/{bookingId}/result", new
        {
            idempotencyKey = key ?? Guid.NewGuid().ToString("N"), format, sideA, sideB, games = games ?? ThreeOne,
        });

    public static Task<HttpResponseMessage> ActAsync(HttpClient client, Guid bookingId, string action, int version, string? note = null) =>
        client.PostAsJsonAsync($"/api/v1/bookings/{bookingId}/result/{action}", new { expectedVersion = version, note });

    public static async Task<JsonElement> JsonAsync(this HttpResponseMessage response) =>
        await response.Content.ReadFromJsonAsync<JsonElement>();

    public static async Task<JsonElement> ReadResultAsync(HttpClient client, Guid bookingId)
    {
        var response = await client.GetAsync($"/api/v1/bookings/{bookingId}/result");
        Assert.True(response.IsSuccessStatusCode, $"GET result: {(int)response.StatusCode} {await response.Content.ReadAsStringAsync()}");
        return await response.JsonAsync();
    }

    public static async Task<JsonElement> MyGameAsync(HttpClient client)
    {
        var response = await client.GetAsync("/api/v1/me/play");
        Assert.True(response.IsSuccessStatusCode, $"GET /me/play: {(int)response.StatusCode}");
        return await response.JsonAsync();
    }

    public static Task<MatchResult?> ResultRowAsync(WebApplicationFactory<Program> f, Guid bookingId) =>
        PlayersClub.ReadAsync(f, db => db.MatchResults.IgnoreQueryFilters().Include(r => r.Players)
            .Where(r => r.BookingId == bookingId).OrderByDescending(r => r.CreatedAt).FirstOrDefaultAsync());

    public static Task SetDueAsync(this PlayersClub club, WebApplicationFactory<Program> f, Guid resultId, DateTimeOffset due) =>
        club.WriteAsync(f, db => db.MatchResults.IgnoreQueryFilters().First(r => r.Id == resultId).ConfirmDueAt = due.Storable());

    public static Task TickAsync(WebApplicationFactory<Program> f, DateTimeOffset now) =>
        f.Services.GetRequiredService<PlayWorker>().TickAsync(now, CancellationToken.None);

    public static Task<List<MemberBadge>> BadgesAsync(WebApplicationFactory<Program> f, Guid userId) =>
        PlayersClub.ReadAsync(f, db => db.MemberBadges.IgnoreQueryFilters().Where(b => b.UserId == userId).ToListAsync());

    public static Task<List<PlayCelebration>> CelebrationsAsync(WebApplicationFactory<Program> f, Guid userId) =>
        PlayersClub.ReadAsync(f, db => db.PlayCelebrations.IgnoreQueryFilters().Where(c => c.UserId == userId).ToListAsync());

    public static Task<List<MemberNotification>> InboxAsync(WebApplicationFactory<Program> f, Guid userId, string? kindPrefix = "play.") =>
        PlayersClub.ReadAsync(f, db => db.MemberNotifications.IgnoreQueryFilters()
            .Where(n => n.UserId == userId && (kindPrefix == null || n.Kind.StartsWith(kindPrefix))).OrderBy(n => n.CreatedAt).ToListAsync());

    public static Task<List<AdminNotification>> OutboxAsync(WebApplicationFactory<Program> f, Guid userId, string kind) =>
        PlayersClub.ReadAsync(f, db => db.AdminNotifications.IgnoreQueryFilters()
            .Where(n => n.RecipientUserId == userId && n.Kind == kind).ToListAsync());

    public static Task<DateTimeOffset?> MarkerAsync(WebApplicationFactory<Program> f, Guid bookingId) =>
        PlayersClub.ReadAsync(f, db => db.Bookings.IgnoreQueryFilters().Where(b => b.Id == bookingId).Select(b => b.PlayRecomputeDueAt).FirstAsync());

    public static Task ClearMarkerAsync(WebApplicationFactory<Program> f, Guid bookingId) =>
        PlayersClub.ReadAsync(f, db => db.Bookings.IgnoreQueryFilters().Where(b => b.Id == bookingId)
            .ExecuteUpdateAsync(u => u.SetProperty(b => b.PlayRecomputeDueAt, (DateTimeOffset?)null)));
}
