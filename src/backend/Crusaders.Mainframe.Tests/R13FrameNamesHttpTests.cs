using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Services.Realtime;
using Crusaders.Mainframe.Api.Webhooks;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 13, contract C13-7 (FC13's ask): the club-cancel toast could not name the partners
/// (X13-2) — each <c>share_transfer</c> part now carries <c>counterparty_name</c>, on the cancel frames
/// and on the sweep's — and a member taken off a game could not be told which court their share came
/// back from (J13-4): the frame carries <c>court_name</c> and <c>booking_starts_at</c>.
/// </summary>
public sealed class R13FrameNamesHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private static List<JsonElement> Frames(System.Threading.Channels.Channel<RealtimeMessage> wallet)
    {
        var frames = new List<JsonElement>();
        while (wallet.Reader.TryRead(out var frame))
        {
            if (frame.Event == LedgerService.BalanceEvent) frames.Add(JsonDocument.Parse(frame.JsonPayload).RootElement.Clone());
        }
        return [.. frames.Where(f => f.GetProperty("reason").GetString() != LedgerService.SetAsideReason)];
    }

    private static List<string?> ShareNames(JsonElement frame) =>
        [.. frame.GetProperty("parts").EnumerateArray()
            .Where(p => p.GetProperty("reason").GetString() == "share_transfer")
            .Select(p => p.GetProperty("counterparty_name").GetString())];

    /// <summary>Olive's 32-minute court at <paramref name="startsAt"/>, split with Sam (and Alex), each accepted.</summary>
    private static async Task<(PlayersClub Club, Guid BookingId, Dictionary<Guid, Guid> Seats)> GameAsync(
        WebApplicationFactory<Program> app, string prefix, int partners, DateTimeOffset startsAt)
    {
        var club = await PlayersClub.SeedAsync(app, prefix);
        var who = new[] { club.Sam, club.Alex }.Take(partners).ToArray();
        foreach (var p in who) await club.CreditAsync(app, p, 50);
        await club.CreditAsync(app, club.Organiser, 100);
        var bookingId = await club.InsertBookingAsync(app, startsAt);
        (await club.Client(app, club.Organiser).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players",
            new { players = who.Select(p => (object)new { userId = p }).ToArray() })).EnsureSuccessStatusCode();
        var seats = new Dictionary<Guid, Guid>();
        foreach (var seat in (await club.SeatsAsync(app, bookingId)).Where(s => s.Seat > 1))
        {
            seats[seat.UserId!.Value] = seat.Id;
            (await club.Client(app, seat.UserId!.Value).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players/{seat.Id}/accept",
                new { expectedShareMinutes = seat.ShareMinutes })).EnsureSuccessStatusCode();
        }
        return (club, bookingId, seats);
    }

    [SkippableTheory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task The_club_cancel_frame_names_each_partner_on_their_share_part(int partners)
    {
        Skip.IfNot(pg.Available, Skipped);
        var app = pg.SharedHost;
        var (club, bookingId, _) = await GameAsync(app, $"r13cnnames{partners}", partners, DateTimeOffset.UtcNow.AddDays(3).Storable());
        var olive = app.Services.GetRequiredService<IRealtimeBus>().Subscribe(RealtimeTopic.Wallet(club.TenantId, club.Organiser));

        (await club.Client(app, club.Admin, admin: true)
            .PostAsJsonAsync($"/api/v1/admin/bookings/{bookingId}/cancel", new { reason = "Court resurfacing" })).EnsureSuccessStatusCode();

        var frame = Assert.Single(Frames(olive));
        var expected = new string?[] { "Sam Partner", "Alex Partner" }.Take(partners).Order().ToList();
        Assert.Equal(expected, ShareNames(frame).Order().ToList());
        Assert.Equal(JsonValueKind.Null, frame.GetProperty("parts")[0].GetProperty("counterparty_name").ValueKind);   // the refund row
        Assert.Equal("Court 1", frame.GetProperty("court_name").GetString());
    }

    [SkippableFact]
    public async Task The_sweep_frame_names_the_partner_on_the_share_part()
    {
        Skip.IfNot(pg.Available, Skipped);
        var app = pg.SharedHost;
        var (club, _, _) = await GameAsync(app, "r13swnames", 2, DateTimeOffset.UtcNow.AddMinutes(-10).Storable());
        var olive = app.Services.GetRequiredService<IRealtimeBus>().Subscribe(RealtimeTopic.Wallet(club.TenantId, club.Organiser));

        await new NoShowWorker(app.Services, app.Services.GetRequiredService<IEventBus>(), NullLogger<NoShowWorker>.Instance)
            .TickAsync(DateTimeOffset.UtcNow, default);

        var frame = Assert.Single(Frames(olive));
        Assert.Equal(new string?[] { "Alex Partner", "Sam Partner" }, ShareNames(frame).Order().ToList());
    }

    /// <summary>J13-4: the member the club took off reads which court their share came back from.</summary>
    [SkippableFact]
    public async Task A_member_taken_off_is_told_the_court_and_start_on_their_frame()
    {
        Skip.IfNot(pg.Available, Skipped);
        var app = pg.SharedHost;
        var start = DateTimeOffset.UtcNow.AddDays(3).Storable();
        var (club, bookingId, seats) = await GameAsync(app, "r13rmcourt", 1, start);
        var sam = app.Services.GetRequiredService<IRealtimeBus>().Subscribe(RealtimeTopic.Wallet(club.TenantId, club.Sam));

        (await club.Client(app, club.Admin, admin: true).PostAsJsonAsync(
            $"/api/v1/admin/bookings/{bookingId}/players/{seats[club.Sam]}/remove", new { reason = "Double booked" })).EnsureSuccessStatusCode();

        var frame = Assert.Single(Frames(sam));
        Assert.Equal(WalletShareCauses.ClubRemoved, frame.GetProperty("share_cause").GetString());
        Assert.Equal("Court 1", frame.GetProperty("court_name").GetString());
        Assert.Equal(start, frame.GetProperty("booking_starts_at").GetDateTimeOffset());
        Assert.Equal(new string?[] { "Olive Organiser" }, ShareNames(frame));
    }
}
