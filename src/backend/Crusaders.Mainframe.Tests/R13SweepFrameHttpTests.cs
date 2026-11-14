using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Services.Realtime;
using Crusaders.Mainframe.Api.Webhooks;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 13, E13-5 (contract C13-2, extending R12 C1) and E13-3 (C13-5). The no-show / outage
/// sweep and a late check-in's reversal on a SHARED booking reached the organiser as two frames
/// 50–250 ms apart — the settlement, then the share following it — and the phone toasted twice. One
/// action is one frame per member: the settlement's reason, the net delta, every row in
/// <c>parts</c>, the share's <c>share_cause</c>. And the outage reversal's stored reason said "the
/// member was checked in after all" when it was the partner who scanned.
/// </summary>
public sealed class R13SweepFrameHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private sealed record Rig(PlayersClub Club, WebApplicationFactory<Program> App, Guid BookingId, DateTimeOffset Start, Guid[] Partners)
    {
        public required System.Threading.Channels.Channel<RealtimeMessage> Olive { get; init; }
        public required System.Threading.Channels.Channel<RealtimeMessage> Sam { get; init; }
    }

    /// <summary>The named <c>balance</c> frames a wallet received since the last read, set-aside-only frames excepted.</summary>
    private static List<JsonElement> Frames(System.Threading.Channels.Channel<RealtimeMessage> wallet)
    {
        var frames = new List<JsonElement>();
        while (wallet.Reader.TryRead(out var frame))
        {
            if (frame.Event == LedgerService.BalanceEvent) frames.Add(JsonDocument.Parse(frame.JsonPayload).RootElement.Clone());
        }
        return [.. frames.Where(f => f.GetProperty("reason").GetString() != LedgerService.SetAsideReason)];
    }

    private static List<(string? Reason, int Minutes)> Parts(JsonElement frame) =>
        [.. frame.GetProperty("parts").EnumerateArray().Select(p => (p.GetProperty("reason").GetString(), p.GetProperty("delta_minutes").GetInt32()))];

    /// <summary>
    /// Olive's 32-minute court, started ten minutes ago, split with <paramref name="partners"/> (each
    /// accepted and paid); <paramref name="dark"/>: its only box silent for a day (an outage refund).
    /// Both wallets are subscribed after the accepts and before the sweep.
    /// </summary>
    private async Task<Rig> SharedPastAsync(string prefix, bool dark, int partners)
    {
        var app = pg.SharedHost;
        var club = await PlayersClub.SeedAsync(app, prefix);
        if (dark)
        {
            await club.WriteAsync(app, db => db.Devices.Add(new Device
            {
                TenantId = club.TenantId,
                DeviceCode = $"box-{prefix}",
                Name = "Box",
                Kind = DeviceKind.CourtBox,
                MacAddress = Guid.NewGuid().ToString("N")[..12],
                CourtNumbers = [1],
                AutoRegistered = false,
                CreatedAt = DateTimeOffset.UtcNow.AddDays(-3),
                LastSeenAt = DateTimeOffset.UtcNow.AddDays(-1),
            }));
        }
        var who = new[] { club.Sam, club.Alex }.Take(partners).ToArray();
        foreach (var p in who) await club.CreditAsync(app, p, 50);
        var start = DateTimeOffset.UtcNow.AddMinutes(-10).Storable();
        var bookingId = await club.InsertBookingAsync(app, start);
        await club.CreditAsync(app, club.Organiser, 32);

        var added = await club.Client(app, club.Organiser).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players",
            new { players = who.Select(p => (object)new { userId = p }).ToArray() });
        added.EnsureSuccessStatusCode();
        var seats = (await added.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("participants").EnumerateArray()
            .Select(s => s.GetProperty("participant_id").GetGuid()).ToList();
        foreach (var seat in seats)
        {
            var row = (await club.SeatsAsync(app, bookingId)).Single(s => s.Id == seat);
            (await club.Client(app, row.UserId!.Value).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players/{seat}/accept",
                new { expectedShareMinutes = row.ShareMinutes })).EnsureSuccessStatusCode();
        }

        var bus = app.Services.GetRequiredService<IRealtimeBus>();
        return new Rig(club, app, bookingId, start, who)
        {
            Olive = bus.Subscribe(RealtimeTopic.Wallet(club.TenantId, club.Organiser)),
            Sam = bus.Subscribe(RealtimeTopic.Wallet(club.TenantId, club.Sam)),
        };
    }

    private static async Task SweepAsync(Rig r)
    {
        await new NoShowWorker(r.App.Services, r.App.Services.GetRequiredService<IEventBus>(), NullLogger<NoShowWorker>.Instance)
            .TickAsync(DateTimeOffset.UtcNow, default);
        var swept = await PlayersClub.ReadAsync(r.App, db => db.Bookings.IgnoreQueryFilters().FirstAsync(b => b.Id == r.BookingId));
        Assert.Equal(BookingStatus.NoShow, swept.Status);
    }

    /// <summary>
    /// The box's queued scan arrives — as the device route runs it: the reversal, then the batch's own
    /// share hook afterwards (which must find nothing left to tell).
    /// </summary>
    private static async Task ReverseAsync(Rig r, Guid scanner)
    {
        var result = await r.Club.InClubAsync(r.App, async sp =>
        {
            var row = await sp.GetRequiredService<MainframeDbContext>().Bookings.FirstAsync(b => b.Id == r.BookingId);
            return await sp.GetRequiredService<BookingService>().ReverseNoShowAsync(
                row, r.Start.AddMinutes(2).Storable(), Guid.Empty, default, scan: new ReversalScan(scanner, "member_code"));
        });
        Assert.IsType<NoShowReversalResult.Ok>(result);
        await r.App.Services.GetRequiredService<ShareHook>().AfterSettlementAsync(r.Club.TenantId, r.Club.Slug, [r.BookingId], default);
    }

    [SkippableTheory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task A_no_show_sweep_on_a_shared_booking_is_one_frame_for_the_organiser(int partners)
    {
        Skip.IfNot(pg.Available, Skipped);
        var r = await SharedPastAsync($"r13swns{partners}", dark: false, partners);

        await SweepAsync(r);

        var frame = Assert.Single(Frames(r.Olive));
        Assert.Equal(WalletStreamReasons.NoShowSettled, frame.GetProperty("reason").GetString());
        var parts = Parts(frame);
        Assert.Equal(("cancellation_refund", 32), parts[0]);
        Assert.Equal("penalty", parts[1].Reason);
        var shares = parts.Skip(2).ToList();
        Assert.Equal(partners, shares.Count);
        Assert.All(shares, s => Assert.True(s.Reason == "share_transfer" && s.Minutes < 0, $"{s}"));
        Assert.Equal(parts.Sum(p => p.Minutes), frame.GetProperty("delta_minutes").GetInt32());
        Assert.Equal(WalletShareCauses.NoShow, frame.GetProperty("share_cause").GetString());
        Assert.Equal(JsonValueKind.Null, frame.GetProperty("cancelled_by").ValueKind);

        // The partner's own wallet moved once, as before.
        var sam = Assert.Single(Frames(r.Sam));
        Assert.Equal(WalletShareCauses.NoShow, sam.GetProperty("share_cause").GetString());
    }

    [SkippableFact]
    public async Task An_outage_refund_on_a_shared_booking_is_one_frame_for_the_organiser()
    {
        Skip.IfNot(pg.Available, Skipped);
        var r = await SharedPastAsync("r13swout", dark: true, partners: 1);

        await SweepAsync(r);

        var frame = Assert.Single(Frames(r.Olive));
        Assert.Equal(WalletStreamReasons.OutageRefund, frame.GetProperty("reason").GetString());
        Assert.Equal([("cancellation_refund", 32), ("share_transfer", -16)], Parts(frame));
        Assert.Equal(16, frame.GetProperty("delta_minutes").GetInt32());
        Assert.Equal(WalletShareCauses.OutageRefund, frame.GetProperty("share_cause").GetString());
    }

    [SkippableTheory]
    [InlineData(true, 1)]
    [InlineData(false, 1)]
    [InlineData(true, 2)]
    public async Task A_partners_late_check_in_reversing_the_sweep_is_one_frame_for_the_organiser(bool dark, int partners)
    {
        Skip.IfNot(pg.Available, Skipped);
        var r = await SharedPastAsync($"r13rv{(dark ? "o" : "n")}{partners}", dark, partners);
        await SweepAsync(r);
        Frames(r.Olive);
        Frames(r.Sam);

        await ReverseAsync(r, r.Club.Sam);

        var frame = Assert.Single(Frames(r.Olive));
        Assert.Equal(dark ? WalletStreamReasons.OutageRefundReversed : WalletStreamReasons.NoShowReversed, frame.GetProperty("reason").GetString());
        var parts = Parts(frame);
        Assert.Equal(("cancellation_refund", -32), parts[0]);
        var shares = parts.Where(p => p.Reason == "share_transfer").ToList();
        Assert.Equal(partners, shares.Count);
        Assert.All(shares, s => Assert.True(s.Minutes > 0, $"{s}"));
        Assert.Equal(parts.Sum(p => p.Minutes), frame.GetProperty("delta_minutes").GetInt32());
        Assert.Equal(WalletShareCauses.Attended, frame.GetProperty("share_cause").GetString());
        Assert.Equal("Sam Partner", frame.GetProperty("checked_in_by_name").GetString());
        Assert.Single(Frames(r.Sam));
    }

    /// <summary>E13-3 (C13-5): the stored line names the partner who scanned; the organiser's own scan keeps "the member".</summary>
    [SkippableTheory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task The_outage_reversals_stored_reason_names_who_checked_in(bool partnerScanned)
    {
        Skip.IfNot(pg.Available, Skipped);
        var r = await SharedPastAsync(partnerScanned ? "r13rsnp" : "r13rsno", dark: true, partners: 1);
        await SweepAsync(r);

        await ReverseAsync(r, partnerScanned ? r.Club.Sam : r.Club.Organiser);

        var reversal = await PlayersClub.ReadAsync(r.App, db => db.LedgerEntries.IgnoreQueryFilters()
            .SingleAsync(l => l.RelatedBookingId == r.BookingId && l.ExternalReference == BookingService.NoShowReversalReference(r.BookingId, "refund")));
        Assert.Equal(
            partnerScanned
                ? "Outage refund reversed — Sam Partner checked in after all"
                : "Outage refund reversed — the member was checked in after all",
            reversal.Reason);
    }
}
