using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Services.Realtime;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 14, lane BE14b (contract r14-contract-BE14b):
/// <list type="bullet">
/// <item>X14-2 / E14-1: <c>share_returned</c> covered an organiser's removal and a split change as
/// well as a withdrawal, so the partner was toasted "you withdrew from the game" when Olive had taken
/// them off or lowered their share. Now <c>organiser_removed</c> / <c>split_changed</c>, and
/// <c>share_returned</c> only for a withdrawal.</item>
/// <item>E14-2: the share rows of an organiser's removal, a split change, a member cancel and a club
/// cancel carried the club's system as actor while the refund beside them named the human. The
/// acting person is now the rows' actor, the frame's <c>actor_name</c> names a player who did it,
/// and the removal and the split change write their own audit rows.</item>
/// </list>
/// </summary>
public sealed class R14ShareCausesHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";
    private const string Returned = "Share of a split booking returned";

    private sealed record Game(
        PlayersClub Club, WebApplicationFactory<Program> App, CapturingMail Mail, Guid BookingId, Dictionary<Guid, Guid> SeatOf,
        Dictionary<Guid, System.Threading.Channels.Channel<RealtimeMessage>> Wallets);

    /// <summary>Olive's 32-minute court three days out, with Sam (and, for two, Alex) accepted and paid; every wallet listened to after.</summary>
    private async Task<Game> GameAsync(string prefix, int partners)
    {
        var mail = new CapturingMail();
        var app = CapturingMail.On(pg.SharedHost, mail);
        var club = await PlayersClub.SeedAsync(app, prefix);
        var who = new[] { club.Sam, club.Alex }.Take(partners).ToArray();
        foreach (var p in who) await club.CreditAsync(app, p, 50);
        await club.CreditAsync(app, club.Organiser, 100);
        var bookingId = await club.InsertBookingAsync(app, DateTimeOffset.UtcNow.AddDays(3).Storable());
        (await club.Client(app, club.Organiser).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players",
            new { players = who.Select(p => (object)new { userId = p }).ToArray() })).EnsureSuccessStatusCode();
        var seatOf = new Dictionary<Guid, Guid>();
        foreach (var seat in await club.SeatsAsync(app, bookingId))
        {
            if (seat.Seat == 1 || seat.UserId is not { } user) continue;
            seatOf[user] = seat.Id;
            (await club.Client(app, user).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players/{seat.Id}/accept",
                new { expectedShareMinutes = seat.ShareMinutes })).EnsureSuccessStatusCode();
        }
        for (var i = 0; i < 50 && await PeopleClub.DeliverAdminNoticesAsync(app) > 0; i++) { }
        mail.Sent.Clear();
        var bus = app.Services.GetRequiredService<IRealtimeBus>();
        var wallets = new[] { club.Organiser, club.Sam, club.Alex }
            .ToDictionary(u => u, u => bus.Subscribe(RealtimeTopic.Wallet(club.TenantId, u)));
        return new Game(club, app, mail, bookingId, seatOf, wallets);
    }

    /// <summary>The share frames one member's wallet heard since the game was set up.</summary>
    private static List<JsonElement> ShareFrames(Game g, Guid user)
    {
        var frames = new List<JsonElement>();
        while (g.Wallets[user].Reader.TryRead(out var frame))
        {
            if (frame.Event != LedgerService.BalanceEvent) continue;
            var json = JsonDocument.Parse(frame.JsonPayload).RootElement.Clone();
            if (json.TryGetProperty("share_cause", out var cause) && cause.ValueKind == JsonValueKind.String) frames.Add(json);
        }
        return frames;
    }

    private static string? Text(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static async Task<List<LedgerEntry>> ReturnsAsync(Game g, Guid seat) =>
        [.. (await g.Club.SharesAsync(g.App, g.BookingId))
            .Where(l => l.Reason == Returned && l.ExternalReference!.StartsWith(ShareLedger.Prefix(seat), StringComparison.Ordinal))];

    private static Task<List<AuditLog>> AuditAsync(Game g, string action) =>
        PlayersClub.ReadAsync(g.App, db => db.AuditLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == g.Club.TenantId && a.Action == action).OrderBy(a => a.CreatedAt).ToListAsync());

    private static Task<List<MemberNotification>> InboxAsync(Game g, Guid user) =>
        PlayersClub.ReadAsync(g.App, db => db.MemberNotifications.IgnoreQueryFilters()
            .Where(n => n.UserId == user && n.BookingId == g.BookingId && n.Kind == MemberEventCatalogue.ShareMoved)
            .OrderBy(n => n.CreatedAt).ToListAsync());

    // ------------------------------------------------------------------ the organiser takes a partner off

    [SkippableTheory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task The_organisers_removal_is_said_as_theirs_on_the_frames_the_rows_the_record_and_the_receipts(int partners)
    {
        Skip.IfNot(pg.Available, Skipped);
        var g = await GameAsync($"r14orgrm{partners}", partners);
        var seat = g.SeatOf[g.Club.Sam];
        var paid = (await g.Club.SeatsAsync(g.App, g.BookingId)).Single(s => s.Id == seat).ShareMinutes;
        foreach (var u in g.Wallets.Keys) ShareFrames(g, u);

        (await g.Club.Client(g.App, g.Club.Organiser).DeleteAsync($"/api/v1/bookings/{g.BookingId}/players/{seat}")).EnsureSuccessStatusCode();

        var sam = Assert.Single(ShareFrames(g, g.Club.Sam));
        Assert.Equal("organiser_removed", Text(sam, "share_cause"));
        Assert.Equal("Olive Organiser", Text(sam, "actor_name"));
        var olive = Assert.Single(ShareFrames(g, g.Club.Organiser));
        Assert.Equal("organiser_removed", Text(olive, "share_cause"));
        Assert.Null(Text(olive, "actor_name"));   // her own act

        var rows = await ReturnsAsync(g, seat);
        Assert.Equal(2, rows.Count);
        Assert.All(rows, l => Assert.Equal(g.Club.Organiser, l.ActorUserId));

        var audit = Assert.Single(await AuditAsync(g, "players.removed"));
        Assert.Equal(g.Club.Organiser, audit.ActorUserId);
        Assert.Equal(g.Club.Sam, audit.SubjectUserId);
        var details = JsonDocument.Parse(audit.DetailsJson!).RootElement;
        Assert.Equal(g.BookingId, details.GetProperty("booking_id").GetGuid());
        Assert.Equal(seat, details.GetProperty("participant_id").GetGuid());
        Assert.Equal(g.Club.Organiser, details.GetProperty("organiser_user_id").GetGuid());
        Assert.False(details.GetProperty("by_club").GetBoolean());

        var samLine = Assert.Single(await InboxAsync(g, g.Club.Sam), n => n.Headline.Contains("came back", StringComparison.Ordinal));
        Assert.StartsWith($"{paid} minutes of your share came back — Olive Organiser took you off Court 1, ", samLine.Headline, StringComparison.Ordinal);
        var oliveLine = Assert.Single(await InboxAsync(g, g.Club.Organiser), n => n.Headline.Contains("went back", StringComparison.Ordinal));
        Assert.StartsWith($"{paid} minutes went back to Sam Partner — you took them off Court 1, ", oliveLine.Headline, StringComparison.Ordinal);
        Assert.DoesNotContain("withdrew", samLine.Headline + oliveLine.Headline, StringComparison.Ordinal);

        if (partners == 2)
        {
            // Alex is still on the game and nothing of his moved.
            Assert.Empty(ShareFrames(g, g.Club.Alex));
            Assert.Empty(await ReturnsAsync(g, g.SeatOf[g.Club.Alex]));
        }
    }

    [SkippableFact]
    public async Task The_clubs_removal_stays_the_clubs_and_names_the_admin_on_the_rows_only()
    {
        Skip.IfNot(pg.Available, Skipped);
        var g = await GameAsync("r14admrm", 2);
        var seat = g.SeatOf[g.Club.Sam];
        ShareFrames(g, g.Club.Sam);

        (await g.Club.Client(g.App, g.Club.Admin, admin: true).PostAsJsonAsync(
            $"/api/v1/admin/bookings/{g.BookingId}/players/{seat}/remove", new { reason = "Double booked" })).EnsureSuccessStatusCode();

        var sam = Assert.Single(ShareFrames(g, g.Club.Sam));
        Assert.Equal(WalletShareCauses.ClubRemoved, Text(sam, "share_cause"));
        Assert.Null(Text(sam, "actor_name"));   // members are told "the club", never the admin's name
        Assert.All(await ReturnsAsync(g, seat), l => Assert.Equal(g.Club.Admin, l.ActorUserId));

        var audit = Assert.Single(await AuditAsync(g, "players.removed"));
        Assert.Equal(g.Club.Admin, audit.ActorUserId);
        Assert.Equal(g.Club.Sam, audit.SubjectUserId);
        Assert.True(JsonDocument.Parse(audit.DetailsJson!).RootElement.GetProperty("by_club").GetBoolean());
    }

    // ------------------------------------------------------------------ the organiser lowers a share

    [SkippableTheory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task A_lowered_share_is_said_as_the_organisers_split_change(int partners)
    {
        Skip.IfNot(pg.Available, Skipped);
        var g = await GameAsync($"r14split{partners}", partners);
        var organiserSeat = (await g.Club.SeatsAsync(g.App, g.BookingId)).Single(s => s.Seat == 1).Id;
        foreach (var u in g.Wallets.Keys) ShareFrames(g, u);
        var before = (await g.Club.SeatsAsync(g.App, g.BookingId)).ToDictionary(s => s.Id, s => s.ShareMinutes);

        // Olive takes the lion's share: 3 to every partner's 1.
        (await g.Club.Client(g.App, g.Club.Organiser).PutAsJsonAsync($"/api/v1/bookings/{g.BookingId}/split", new
        {
            mode = "ratio",
            seats = new object[] { new { participantId = organiserSeat, weight = 3 } }
                .Concat(g.SeatOf.Values.Select(s => (object)new { participantId = s, weight = 1 })).ToArray(),
        })).EnsureSuccessStatusCode();

        var after = (await g.Club.SeatsAsync(g.App, g.BookingId)).ToDictionary(s => s.Id, s => s.ShareMinutes);
        foreach (var (partner, seat) in g.SeatOf)
        {
            Assert.True(after[seat] < before[seat]);
            var frame = Assert.Single(ShareFrames(g, partner));
            Assert.Equal("split_changed", Text(frame, "share_cause"));
            Assert.Equal("Olive Organiser", Text(frame, "actor_name"));
            var rows = await ReturnsAsync(g, seat);
            Assert.Equal(2, rows.Count);
            Assert.All(rows, l => Assert.Equal(g.Club.Organiser, l.ActorUserId));
            var line = Assert.Single(await InboxAsync(g, partner), n => n.Headline.Contains("came back", StringComparison.Ordinal));
            Assert.StartsWith($"{before[seat] - after[seat]} minutes of your share came back — Olive Organiser lowered your share of Court 1, ",
                line.Headline, StringComparison.Ordinal);
        }
        Assert.All(ShareFrames(g, g.Club.Organiser), f =>
        {
            Assert.Equal("split_changed", Text(f, "share_cause"));
            Assert.Null(Text(f, "actor_name"));
        });

        var audit = await AuditAsync(g, "players.split_changed");
        Assert.Equal(partners, audit.Count);
        Assert.All(audit, a => Assert.Equal(g.Club.Organiser, a.ActorUserId));
        Assert.Equal(g.SeatOf.Keys.Order().ToList(), audit.Select(a => a.SubjectUserId!.Value).Order().ToList());
        var sams = JsonDocument.Parse(audit.Single(a => a.SubjectUserId == g.Club.Sam).DetailsJson!).RootElement;
        Assert.Equal(after[g.SeatOf[g.Club.Sam]], sams.GetProperty("share_minutes").GetInt32());
        Assert.Equal(before[g.SeatOf[g.Club.Sam]], sams.GetProperty("previous_share_minutes").GetInt32());
    }

    // ------------------------------------------------------------------ a withdrawal keeps share_returned

    [SkippableFact]
    public async Task A_withdrawal_alone_is_share_returned_and_names_the_partner_to_the_organiser()
    {
        Skip.IfNot(pg.Available, Skipped);
        var g = await GameAsync("r14wd", 2);
        var seat = g.SeatOf[g.Club.Sam];
        foreach (var u in g.Wallets.Keys) ShareFrames(g, u);

        (await g.Club.Client(g.App, g.Club.Sam).PostAsync($"/api/v1/bookings/{g.BookingId}/players/{seat}/withdraw", null)).EnsureSuccessStatusCode();

        var sam = Assert.Single(ShareFrames(g, g.Club.Sam));
        Assert.Equal(WalletShareCauses.ShareReturned, Text(sam, "share_cause"));
        Assert.Null(Text(sam, "actor_name"));
        var olive = Assert.Single(ShareFrames(g, g.Club.Organiser));
        Assert.Equal(WalletShareCauses.ShareReturned, Text(olive, "share_cause"));
        Assert.Equal("Sam Partner", Text(olive, "actor_name"));
    }

    // ------------------------------------------------------------------ a cancellation's shares name who cancelled

    [SkippableTheory]
    [InlineData(1, false, false)]
    [InlineData(2, false, false)]
    [InlineData(1, true, false)]
    [InlineData(2, true, false)]
    [InlineData(1, false, true)]
    [InlineData(2, false, true)]
    public async Task A_cancellations_share_rows_name_who_cancelled_like_the_refund_beside_them(int partners, bool byClub, bool late)
    {
        Skip.IfNot(pg.Available, Skipped);
        var g = await GameAsync($"r14cn{partners}{(byClub ? "c" : "m")}{(late ? "l" : "")}", partners);
        if (late)
        {
            // Inside the 15-minute penalty window: the organiser's late cancel keeps a penalty, and the shares still go back.
            await g.Club.WriteAsync(g.App, db =>
            {
                var b = db.Bookings.IgnoreQueryFilters().First(x => x.Id == g.BookingId);
                b.StartsAt = DateTimeOffset.UtcNow.AddMinutes(10).Storable();
                b.EndsAt = b.StartsAt.AddMinutes(32);
            });
        }
        foreach (var u in g.Wallets.Keys) ShareFrames(g, u);

        var cancel = byClub
            ? g.Club.Client(g.App, g.Club.Admin, admin: true).PostAsJsonAsync($"/api/v1/admin/bookings/{g.BookingId}/cancel", new { reason = "Court resurfacing" })
            : g.Club.Client(g.App, g.Club.Organiser).PostAsync($"/api/v1/bookings/{g.BookingId}/cancel", null);
        (await cancel).EnsureSuccessStatusCode();

        var actor = byClub ? g.Club.Admin : g.Club.Organiser;
        var refund = await PlayersClub.ReadAsync(g.App, db => db.LedgerEntries.IgnoreQueryFilters()
            .SingleAsync(l => l.RelatedBookingId == g.BookingId && l.Type == LedgerEntryType.CancellationRefund));
        Assert.Equal(actor, refund.ActorUserId);
        if (late)
        {
            Assert.True(await PlayersClub.ReadAsync(g.App, db => db.LedgerEntries.IgnoreQueryFilters()
                .AnyAsync(l => l.RelatedBookingId == g.BookingId && l.Type == LedgerEntryType.LateCancellationPenalty)));
        }
        foreach (var (partner, seat) in g.SeatOf)
        {
            var rows = await ReturnsAsync(g, seat);
            Assert.Equal(2, rows.Count);
            Assert.All(rows, l => Assert.Equal(actor, l.ActorUserId));
            var frame = Assert.Single(ShareFrames(g, partner));
            Assert.Equal(WalletShareCauses.BookingCancelled, Text(frame, "share_cause"));
            Assert.Equal(byClub ? null : "Olive Organiser", Text(frame, "actor_name"));
        }

        // The partner's own record of it, for their Night.
        var told = await AuditAsync(g, "players.game_cancelled");
        Assert.Equal(g.SeatOf.Keys.Order().ToList(), told.Select(a => a.SubjectUserId!.Value).Order().ToList());
        Assert.All(told, a => Assert.Equal(actor, a.ActorUserId));
    }
}
