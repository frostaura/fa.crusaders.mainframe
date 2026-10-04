using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Services.Realtime;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 12, X12-1 (contract C1). The club cancelling a shared booking — or the organiser
/// cancelling on another device — moved the organiser's minutes in two units of work 70 ms apart:
/// <c>cancellation_refund</c> +32, then the share going back to the partner −16. The phone toasted
/// twice. One action is ONE frame: the primary reason, the net delta, every row in <c>parts</c>,
/// and <c>cancelled_by</c> saying whether the club or the member cancelled.
/// </summary>
public sealed class R12CancelFrameHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private sealed record Rig(PlayersClub Club, WebApplicationFactory<Program> App, Guid BookingId);

    /// <summary>Olive's 32-minute court three days out, split with Sam, who has paid his 16.</summary>
    private async Task<Rig> SharedAsync(string prefix)
    {
        var app = pg.SharedHost;
        var club = await PlayersClub.SeedAsync(app, prefix);
        await club.CreditAsync(app, club.Sam, 50);
        var bookingId = await club.InsertBookingAsync(app, DateTimeOffset.UtcNow.AddDays(3).Storable());
        var added = await club.Client(app, club.Organiser).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players",
            new { players = new object[] { new { userId = club.Sam } } });
        added.EnsureSuccessStatusCode();
        var seat = (await added.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("participants")[0].GetProperty("participant_id").GetGuid();
        var shown = (await club.SeatsAsync(app, bookingId)).Single(s => s.Id == seat).ShareMinutes;
        (await club.Client(app, club.Sam).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players/{seat}/accept",
            new { expectedShareMinutes = shown })).EnsureSuccessStatusCode();
        return new Rig(club, app, bookingId);
    }

    private static List<JsonElement> BalanceFrames(System.Threading.Channels.Channel<RealtimeMessage> wallet)
    {
        var frames = new List<JsonElement>();
        while (wallet.Reader.TryRead(out var frame))
        {
            if (frame.Event == LedgerService.BalanceEvent) frames.Add(JsonDocument.Parse(frame.JsonPayload).RootElement.Clone());
        }
        // A frame that only moved what is set aside carries no minutes and is not a movement.
        return [.. frames.Where(f => f.GetProperty("reason").GetString() != LedgerService.SetAsideReason)];
    }

    private static void OneFrameWithBothRows(List<JsonElement> frames, string cancelledBy)
    {
        var frame = Assert.Single(frames);
        Assert.Equal("cancellation_refund", frame.GetProperty("reason").GetString());
        Assert.Equal(16, frame.GetProperty("delta_minutes").GetInt32());
        var parts = frame.GetProperty("parts").EnumerateArray()
            .Select(p => (p.GetProperty("reason").GetString(), p.GetProperty("delta_minutes").GetInt32())).ToList();
        Assert.Equal([("cancellation_refund", 32), ("share_transfer", -16)], parts);
        Assert.Equal(cancelledBy, frame.GetProperty("cancelled_by").GetString());
    }

    [SkippableFact]
    public async Task The_club_cancelling_a_shared_booking_is_one_frame_for_the_organiser_saying_the_club_did_it()
    {
        Skip.IfNot(pg.Available, Skipped);
        var r = await SharedAsync("r12clubcan");
        var bus = r.App.Services.GetRequiredService<IRealtimeBus>();
        var olive = bus.Subscribe(RealtimeTopic.Wallet(r.Club.TenantId, r.Club.Organiser));
        var sam = bus.Subscribe(RealtimeTopic.Wallet(r.Club.TenantId, r.Club.Sam));

        (await r.Club.Client(r.App, r.Club.Admin, admin: true)
            .PostAsJsonAsync($"/api/v1/admin/bookings/{r.BookingId}/cancel", new { reason = "Court resurfacing" })).EnsureSuccessStatusCode();

        OneFrameWithBothRows(BalanceFrames(olive), WalletCancelledBy.Club);
        var partner = Assert.Single(BalanceFrames(sam));
        Assert.Equal(16, partner.GetProperty("delta_minutes").GetInt32());
        Assert.Equal(WalletShareCauses.BookingCancelled, partner.GetProperty("share_cause").GetString());
        Assert.Equal(WalletCancelledBy.Club, partner.GetProperty("cancelled_by").GetString());
    }

    [SkippableFact]
    public async Task The_organiser_cancelling_on_another_device_is_one_frame_saying_they_did_it()
    {
        Skip.IfNot(pg.Available, Skipped);
        var r = await SharedAsync("r12owncan");
        var olive = r.App.Services.GetRequiredService<IRealtimeBus>().Subscribe(RealtimeTopic.Wallet(r.Club.TenantId, r.Club.Organiser));

        (await r.Club.Client(r.App, r.Club.Organiser).PostAsync($"/api/v1/bookings/{r.BookingId}/cancel", null)).EnsureSuccessStatusCode();

        OneFrameWithBothRows(BalanceFrames(olive), WalletCancelledBy.Member);
    }

    /// <summary>A movement that is no cancellation says nobody cancelled.</summary>
    [SkippableFact]
    public async Task A_movement_that_is_not_a_cancellation_carries_a_null_cancelled_by()
    {
        Skip.IfNot(pg.Available, Skipped);
        var app = pg.SharedHost;
        var club = await PlayersClub.SeedAsync(app, "r12nocan");
        var olive = app.Services.GetRequiredService<IRealtimeBus>().Subscribe(RealtimeTopic.Wallet(club.TenantId, club.Organiser));

        (await club.Client(app, club.Admin, admin: true).PostAsJsonAsync($"/api/v1/admin/minutes/{club.Organiser}/adjust",
            new { amountMinutes = 5, reason = "Goodwill", idempotencyKey = Guid.NewGuid().ToString() })).EnsureSuccessStatusCode();

        var frame = Assert.Single(BalanceFrames(olive));
        Assert.Equal(JsonValueKind.Null, frame.GetProperty("cancelled_by").ValueKind);
    }
}
