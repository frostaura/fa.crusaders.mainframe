using System.Globalization;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Webhooks;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 15, lane BE15b — the Night and the member's wallet CSV:
/// <list type="bullet">
/// <item>E15-3 / J15-4: the club's seat acts — settle outside, collect, add — wrote no audit row and
/// reached nobody's Night; an admin's removal reached the partner's Night but not the organiser's;
/// a partner's Night had no row for the no-show, the outage or the reversal on the game they paid
/// into; and every share row read "A share of a split booking moved: N" with no direction or cause.</item>
/// <item>E15-9 / J15-7: the rows name the organiser or the partner rather than a role.</item>
/// <item>E15-10 / J15-10: the member's wallet CSV had no counterparty, cause, actor, rand or given, and
/// printed internal references (<c>adjust:&lt;tenant&gt;:…</c>, <c>share:&lt;seat&gt;:2:in</c>).</item>
/// </list>
/// </summary>
public sealed class R15NightAndCsvHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private sealed record Game(PlayersClub Club, WebApplicationFactory<Program> App, Guid BookingId, Dictionary<Guid, Guid> SeatOf);

    private async Task<Game> GameAsync(string prefix, int partners, int partnerFloat = 50)
    {
        var app = CapturingMail.On(pg.SharedHost, new CapturingMail());
        var club = await PlayersClub.SeedAsync(app, prefix);
        var who = new[] { club.Sam, club.Alex }.Take(partners).ToArray();
        foreach (var p in who) await club.CreditAsync(app, p, partnerFloat);
        await club.CreditAsync(app, club.Organiser, 100);
        var bookingId = await club.InsertBookingAsync(app, PlayersClub.Tomorrow(8).AddDays(2));
        (await club.Client(app, club.Organiser).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players",
            new { players = who.Select(p => (object)new { userId = p }).ToArray() })).EnsureSuccessStatusCode();
        var seatOf = new Dictionary<Guid, Guid>();
        foreach (var seat in await club.SeatsAsync(app, bookingId))
        {
            if (seat.Seat == 1 || seat.UserId is not { } user) continue;
            seatOf[user] = seat.Id;
            // With nothing to pay with, the member's own accept is refused (402): the club says yes for them, consenting to nothing.
            var accept = partnerFloat > 0
                ? club.Client(app, user).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players/{seat.Id}/accept", new { expectedShareMinutes = seat.ShareMinutes })
                : club.Client(app, club.Admin, admin: true).PostAsJsonAsync($"/api/v1/admin/bookings/{bookingId}/players/{seat.Id}/accept", new { reason = "Playing tonight" });
            (await accept).EnsureSuccessStatusCode();
        }
        return new Game(club, app, bookingId, seatOf);
    }

    private static HttpClient Admin(Game g) => g.Club.Client(g.App, g.Club.Admin, admin: true);

    private static async Task<List<JsonElement>> NightAsync(Game g, Guid user) => await NightAsync(g.Club, g.App, user);

    private static async Task<List<JsonElement>> NightAsync(PlayersClub club, WebApplicationFactory<Program> app, Guid user)
    {
        var body = await club.Client(app, club.Admin, admin: true).GetFromJsonAsync<JsonElement>($"/api/v1/admin/members/{user}/trace");
        return [.. body.GetProperty("events").EnumerateArray()];
    }

    private static string Kind(JsonElement e) => e.GetProperty("kind").GetString()!;
    private static string Headline(JsonElement e) => e.GetProperty("headline").GetString()!;
    private static bool Own(JsonElement e) => e.GetProperty("amount_minutes").ValueKind == JsonValueKind.Number;

    private static Task<List<AuditLog>> AuditAsync(Game g, string action) =>
        PlayersClub.ReadAsync(g.App, db => db.AuditLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == g.Club.TenantId && a.Action == action).ToListAsync());

    private async Task<int> ShareOfAsync(Game g, Guid partner) =>
        (await g.Club.SeatsAsync(g.App, g.BookingId)).Single(s => s.Id == g.SeatOf[partner]).ShareMinutes;

    /// <summary>The newest own share row on a member's Night.</summary>
    private static JsonElement LastOwnShare(List<JsonElement> night) =>
        night.Last(e => Kind(e) == TraceKinds.WalletShareMoved && Own(e));

    /// <summary>The newest share row on a member's Night that is somebody else's half.</summary>
    private static JsonElement LastTwinShare(List<JsonElement> night) =>
        night.Last(e => Kind(e) == TraceKinds.WalletShareMoved && !Own(e));

    // ------------------------------------------------------------------ settle outside

    [SkippableTheory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task The_clubs_settle_outside_is_on_the_record_and_on_all_three_Nights(int partners)
    {
        Skip.IfNot(pg.Available, Skipped);
        var g = await GameAsync($"r15nso{partners}", partners);
        var share = await ShareOfAsync(g, g.Club.Sam);

        (await Admin(g).PostAsJsonAsync($"/api/v1/admin/bookings/{g.BookingId}/players/{g.SeatOf[g.Club.Sam]}/settle-outside",
            new { reason = "Paid cash" })).EnsureSuccessStatusCode();

        var audit = Assert.Single(await AuditAsync(g, "players.settled_outside"));
        Assert.Equal(g.Club.Admin, audit.ActorUserId);
        Assert.Equal(g.Club.Sam, audit.SubjectUserId);
        var details = JsonDocument.Parse(audit.DetailsJson!).RootElement;
        Assert.Equal(g.Club.Organiser, details.GetProperty("organiser_user_id").GetGuid());
        Assert.Equal(g.SeatOf[g.Club.Sam], details.GetProperty("participant_id").GetGuid());

        var sam = await NightAsync(g, g.Club.Sam);
        Assert.Equal("Ada Admin recorded their share of Olive Organiser's game on Court 1 as paid by hand",
            Headline(Assert.Single(sam, e => Kind(e) == "booking.share_settled_outside")));
        Assert.Equal($"{share} minutes of their share of Court 1 came back from Olive Organiser — the club recorded their share as paid by hand",
            Headline(LastOwnShare(sam)));

        var olive = await NightAsync(g, g.Club.Organiser);
        Assert.Equal("Ada Admin recorded Sam Partner's share of their game on Court 1 as paid by hand",
            Headline(Assert.Single(olive, e => Kind(e) == "booking.partner_share_settled_outside")));
        Assert.Equal($"{share} minutes went back to Sam Partner for their share of Court 1 — the club recorded Sam Partner's share as paid by hand",
            Headline(LastOwnShare(olive)));

        Assert.Equal("Recorded Sam Partner's share of Olive Organiser's game on Court 1 as paid by hand",
            Headline(Assert.Single(await NightAsync(g, g.Club.Admin), e => Kind(e) == "booking.settled_share_outside")));
    }

    // ------------------------------------------------------------------ collect

    [SkippableTheory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task The_clubs_collect_is_on_the_record_and_on_all_three_Nights(int partners)
    {
        Skip.IfNot(pg.Available, Skipped);
        var g = await GameAsync($"r15ncol{partners}", partners, partnerFloat: 0);
        var share = await ShareOfAsync(g, g.Club.Sam);

        (await Admin(g).PostAsJsonAsync($"/api/v1/admin/bookings/{g.BookingId}/players/{g.SeatOf[g.Club.Sam]}/collect",
            new { reason = "Bar tab", allowNegativeBalance = true })).EnsureSuccessStatusCode();

        var audit = Assert.Single(await AuditAsync(g, "players.share_collected"));
        Assert.Equal(g.Club.Admin, audit.ActorUserId);
        Assert.Equal(g.Club.Sam, audit.SubjectUserId);
        Assert.Equal(share, JsonDocument.Parse(audit.DetailsJson!).RootElement.GetProperty("collected_minutes").GetInt32());

        var sam = await NightAsync(g, g.Club.Sam);
        Assert.Equal($"Ada Admin collected {share} minutes from them for their share of Olive Organiser's game on Court 1",
            Headline(Assert.Single(sam, e => Kind(e) == "booking.share_collected")));
        Assert.Equal($"Paid Olive Organiser {share} minutes for their share of Court 1 — the club collected it", Headline(LastOwnShare(sam)));

        var olive = await NightAsync(g, g.Club.Organiser);
        Assert.Equal($"Ada Admin collected Sam Partner's share of their game on Court 1: {share} minutes",
            Headline(Assert.Single(olive, e => Kind(e) == "booking.partner_share_collected")));
        Assert.Equal($"Sam Partner paid them {share} minutes for their share of Court 1 — the club collected it", Headline(LastOwnShare(olive)));

        Assert.Equal($"Collected {share} minutes from Sam Partner for their share of Olive Organiser's game on Court 1",
            Headline(Assert.Single(await NightAsync(g, g.Club.Admin), e => Kind(e) == "booking.collected_share")));
    }

    // ------------------------------------------------------------------ the club adds a player

    [SkippableTheory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task The_clubs_add_is_on_the_record_and_on_all_three_Nights(bool accepted)
    {
        Skip.IfNot(pg.Available, Skipped);
        var g = await GameAsync($"r15nadd{(accepted ? "a" : "i")}", 1);

        (await Admin(g).PostAsJsonAsync($"/api/v1/admin/bookings/{g.BookingId}/players",
            new { userId = g.Club.Jo, accepted, reason = "Phoned in" })).EnsureSuccessStatusCode();

        var audit = Assert.Single(await AuditAsync(g, "players.added_by_club"));
        Assert.Equal(g.Club.Admin, audit.ActorUserId);
        Assert.Equal(g.Club.Jo, audit.SubjectUserId);
        Assert.Equal(accepted, JsonDocument.Parse(audit.DetailsJson!).RootElement.GetProperty("accepted").GetBoolean());

        var (verb, prep) = accepted ? ("put", "in") : ("added", "to");
        Assert.Equal($"Ada Admin {verb} them {prep} Olive Organiser's game on Court 1",
            Headline(Assert.Single(await NightAsync(g, g.Club.Jo), e => Kind(e) == "booking.added_to_game")));
        Assert.Equal($"Ada Admin {verb} Jo Partner {prep} their game on Court 1",
            Headline(Assert.Single(await NightAsync(g, g.Club.Organiser), e => Kind(e) == "booking.club_added_player")));
        Assert.Equal($"{(accepted ? "Put" : "Added")} Jo Partner {prep} Olive Organiser's game on Court 1",
            Headline(Assert.Single(await NightAsync(g, g.Club.Admin), e => Kind(e) == "booking.added_player")));
    }

    // ------------------------------------------------------------------ an admin's removal on the organiser's Night

    [SkippableTheory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task The_clubs_removal_is_on_the_organisers_Night_and_the_share_rows_say_so(int partners)
    {
        Skip.IfNot(pg.Available, Skipped);
        var g = await GameAsync($"r15nrm{partners}", partners);
        var share = await ShareOfAsync(g, g.Club.Sam);

        (await Admin(g).PostAsJsonAsync($"/api/v1/admin/bookings/{g.BookingId}/players/{g.SeatOf[g.Club.Sam]}/remove",
            new { reason = "Double booked" })).EnsureSuccessStatusCode();

        var olive = await NightAsync(g, g.Club.Organiser);
        Assert.Equal("Ada Admin took Sam Partner off their game on Court 1",
            Headline(Assert.Single(olive, e => Kind(e) == "booking.club_took_player_off")));
        Assert.DoesNotContain(olive, e => Kind(e) == TraceKinds.BookingTakenOff);
        Assert.Equal($"{share} minutes went back to Sam Partner for their share of Court 1 — the club took Sam Partner off the game",
            Headline(LastOwnShare(olive)));

        var sam = await NightAsync(g, g.Club.Sam);
        Assert.Equal($"{share} minutes of their share of Court 1 came back from Olive Organiser — the club took them off the game",
            Headline(LastOwnShare(sam)));
        // The other half, named: Olive's wallet, on Sam's Night.
        Assert.Equal($"{share} minutes went back from Olive Organiser for the share of Court 1 — the club took Sam Partner off the game",
            Headline(LastTwinShare(sam)));
    }

    // ------------------------------------------------------------------ the organiser's acts, on the share rows

    [SkippableTheory]
    [InlineData(1, "remove")]
    [InlineData(2, "remove")]
    [InlineData(1, "split")]
    [InlineData(2, "split")]
    [InlineData(1, "cancel")]
    [InlineData(2, "cancel")]
    [InlineData(2, "withdraw")]
    public async Task Every_share_row_says_which_way_it_went_and_why(int partners, string act)
    {
        Skip.IfNot(pg.Available, Skipped);
        var g = await GameAsync($"r15nsh{partners}{act[..2]}", partners);
        var olive = g.Club.Client(g.App, g.Club.Organiser);
        var seat = g.SeatOf[g.Club.Sam];
        var task = act switch
        {
            "remove" => olive.DeleteAsync($"/api/v1/bookings/{g.BookingId}/players/{seat}"),
            "cancel" => olive.PostAsync($"/api/v1/bookings/{g.BookingId}/cancel", null),
            "withdraw" => g.Club.Client(g.App, g.Club.Sam).PostAsync($"/api/v1/bookings/{g.BookingId}/players/{seat}/withdraw", null),
            _ => SplitAsync(g, olive),
        };
        (await task).EnsureSuccessStatusCode();

        var sam = await NightAsync(g, g.Club.Sam);
        var oliveNight = await NightAsync(g, g.Club.Organiser);
        var shareRows = sam.Concat(oliveNight).Where(e => Kind(e) == TraceKinds.WalletShareMoved).ToList();
        Assert.NotEmpty(shareRows);
        Assert.All(shareRows, e => Assert.DoesNotContain("A share of a split booking moved", Headline(e), StringComparison.Ordinal));

        var (samWhy, oliveWhy) = act switch
        {
            "remove" => ("Olive Organiser took them off the game", "they took Sam Partner off the game"),
            "split" => ("Olive Organiser lowered their share", "they lowered Sam Partner's share"),
            "cancel" => ("the game was cancelled", "the game was cancelled"),
            // R16 E16-4: the organiser's row names who withdrew — "they" on THEIR Night was Olive.
            _ => ("they withdrew from the game", "Sam Partner withdrew from the game"),
        };
        Assert.EndsWith($" — {samWhy}", Headline(LastOwnShare(sam)), StringComparison.Ordinal);
        Assert.EndsWith($" — {oliveWhy}", Headline(oliveNight.Last(e => Kind(e) == TraceKinds.WalletShareMoved && Own(e)
            && Headline(e).Contains("Sam Partner", StringComparison.Ordinal))), StringComparison.Ordinal);
        // The payment that came before it reads as one too.
        Assert.Contains(sam, e => Kind(e) == TraceKinds.WalletShareMoved && Own(e)
            && Headline(e).StartsWith("Paid Olive Organiser ", StringComparison.Ordinal) && Headline(e).EndsWith(" for their share of Court 1", StringComparison.Ordinal));
    }

    private static Task<HttpResponseMessage> SplitAsync(Game g, HttpClient olive)
    {
        return Task.Run(async () =>
        {
            var organiserSeat = (await g.Club.SeatsAsync(g.App, g.BookingId)).Single(s => s.Seat == 1).Id;
            return await olive.PutAsJsonAsync($"/api/v1/bookings/{g.BookingId}/split", new
            {
                mode = "ratio",
                seats = new object[] { new { participantId = organiserSeat, weight = 3 } }
                    .Concat(g.SeatOf.Values.Select(s => (object)new { participantId = s, weight = 1 })).ToArray(),
            });
        });
    }

    // ------------------------------------------------------------------ a partner's Night: no-show, outage, reversal

    [SkippableTheory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task A_partners_Night_says_the_game_was_swept_and_then_reversed(bool dark)
    {
        Skip.IfNot(pg.Available, Skipped);
        var start = DateTimeOffset.UtcNow.AddMinutes(-10).Storable();
        var app = CapturingMail.On(pg.SharedHost, new CapturingMail());
        var club = await PlayersClub.SeedAsync(app, dark ? "r15pno" : "r15pnn");
        if (dark)
        {
            await club.WriteAsync(app, db => db.Devices.Add(new Device
            {
                TenantId = club.TenantId,
                DeviceCode = $"box-r15pn{dark}",
                Name = "Box",
                Kind = DeviceKind.CourtBox,
                MacAddress = Guid.NewGuid().ToString("N")[..12],
                CourtNumbers = [1],
                AutoRegistered = false,
                CreatedAt = DateTimeOffset.UtcNow.AddDays(-3),
                LastSeenAt = DateTimeOffset.UtcNow.AddDays(-1),
            }));
        }
        await club.CreditAsync(app, club.Sam, 50);
        var bookingId = await club.InsertBookingAsync(app, start);
        await club.CreditAsync(app, club.Organiser, 32);
        (await club.Client(app, club.Organiser).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players",
            new { players = new object[] { new { userId = club.Sam } } })).EnsureSuccessStatusCode();
        var seat = (await club.SeatsAsync(app, bookingId)).Single(s => s.Seat == 2);
        (await club.Client(app, club.Sam).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players/{seat.Id}/accept",
            new { expectedShareMinutes = seat.ShareMinutes })).EnsureSuccessStatusCode();
        await new NoShowWorker(app.Services, app.Services.GetRequiredService<IEventBus>(), NullLogger<NoShowWorker>.Instance)
            .TickAsync(DateTimeOffset.UtcNow, default);
        await app.Services.GetRequiredService<ShareHook>().AfterSettlementAsync(club.TenantId, club.Slug, [bookingId], default);

        var swept = await NightAsync(club, app, club.Sam);
        Assert.Equal(dark
                ? "The club refunded Olive Organiser's game on Court 1 in full — its box was offline"
                : "The club's automatic check marked Olive Organiser's game on Court 1 as a no-show",
            Headline(Assert.Single(swept, e => Kind(e) == "booking.game_no_show")));
        Assert.EndsWith(dark
                ? " — the court's box was offline, so the club refunded the session"
                : " — nobody checked in, so the club settled it as a no-show",
            Headline(LastOwnShare(swept)), StringComparison.Ordinal);

        await club.InClubAsync(app, async sp =>
        {
            var row = await sp.GetRequiredService<MainframeDbContext>().Bookings.FirstAsync(b => b.Id == bookingId);
            return await sp.GetRequiredService<BookingService>().ReverseNoShowAsync(
                row, start.AddMinutes(2).Storable(), Guid.Empty, default, scan: new ReversalScan(club.Organiser, "member_code"));
        });
        await app.Services.GetRequiredService<ShareHook>().AfterSettlementAsync(club.TenantId, club.Slug, [bookingId], default);

        var reversed = await NightAsync(club, app, club.Sam);
        Assert.Equal($"Olive Organiser's check-in reached the club late — the {(dark ? "outage refund" : "no-show")} on Olive Organiser's game on Court 1 was reversed",
            Headline(Assert.Single(reversed, e => Kind(e) == "booking.game_no_show_reversed")));
        var again = LastOwnShare(reversed);
        Assert.StartsWith("Paid Olive Organiser ", Headline(again), StringComparison.Ordinal);
        Assert.EndsWith(" for their share of Court 1 — the session was attended after all", Headline(again), StringComparison.Ordinal);

        // The organiser's own Night keeps its own words for both, once.
        var olive = await NightAsync(club, app, club.Organiser);
        Assert.Single(olive, e => Kind(e) == TraceKinds.BookingNoShow);
        Assert.DoesNotContain(olive, e => Kind(e) == "booking.game_no_show");
    }

    // ------------------------------------------------------------------ E15-10: the member's wallet CSV

    [SkippableFact]
    public async Task The_member_wallet_csv_names_the_other_side_the_cause_and_the_rand_and_hides_internal_references()
    {
        Skip.IfNot(pg.Available, Skipped);
        var g = await GameAsync("r15csv", 2);
        var tenant = g.Club.TenantId;
        await g.Club.WriteAsync(g.App, db =>
        {
            db.LedgerEntries.Add(new LedgerEntry
            {
                TenantId = tenant,
                UserId = g.Club.Sam,
                Type = LedgerEntryType.AdminTopUp,
                AmountMinutes = 60,
                ZarPaid = 0m,
                ActorUserId = g.Club.Admin,
                Reason = "Free hour for helping",
                ExternalReference = $"desk:{tenant:N}:give",
            });
            db.LedgerEntries.Add(new LedgerEntry
            {
                TenantId = tenant,
                UserId = g.Club.Sam,
                Type = LedgerEntryType.AdminTopUp,
                AmountMinutes = 60,
                ZarPaid = 150m,
                ActorUserId = g.Club.Admin,
                Reason = "Cash at the desk",
                ExternalReference = $"desk:{tenant:N}:sale",
            });
            db.LedgerEntries.Add(new LedgerEntry
            {
                TenantId = tenant,
                UserId = g.Club.Sam,
                Type = LedgerEntryType.AdminAdjustment,
                AmountMinutes = 5,
                ActorUserId = g.Club.Admin,
                Reason = "Goodwill",
                ExternalReference = $"adjust:{tenant:N}:goodwill",
            });
        });
        (await g.Club.Client(g.App, g.Club.Organiser).DeleteAsync($"/api/v1/bookings/{g.BookingId}/players/{g.SeatOf[g.Club.Sam]}"))
            .EnsureSuccessStatusCode();

        var from = DateTimeOffset.UtcNow.AddDays(-1).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        var to = DateTimeOffset.UtcNow.AddDays(1).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        var response = await g.Club.Client(g.App, g.Club.Sam).GetAsync($"/api/v1/reports/me/wallet.csv?from={from}&to={to}");
        response.EnsureSuccessStatusCode();
        var lines = (await response.Content.ReadAsStringAsync()).Split('\n', StringSplitOptions.RemoveEmptyEntries).Select(l => l.TrimEnd('\r')).ToList();

        Assert.Equal("created_at,type,amount_minutes,reason,counterparty,cause,done_by,given,zar_paid,court,booking_starts_at,related_booking_id", lines[0]);
        var all = string.Join('\n', lines);
        Assert.DoesNotContain("share:", all, StringComparison.Ordinal);
        Assert.DoesNotContain("adjust:", all, StringComparison.Ordinal);
        Assert.DoesNotContain("desk:", all, StringComparison.Ordinal);
        Assert.DoesNotContain(tenant.ToString("N"), all, StringComparison.Ordinal);

        static string[] Cells(string line) => line.Split(',');
        var paid = Cells(lines.First(l => l.Contains(",ShareTransfer,-", StringComparison.Ordinal)));
        Assert.Equal("Olive Organiser", paid[4]);
        Assert.Equal("share_paid", paid[5]);
        Assert.Equal("Court 1", paid[9]);
        var back = Cells(lines.Last(l => l.Contains(",ShareTransfer,", StringComparison.Ordinal) && !l.Contains(",ShareTransfer,-", StringComparison.Ordinal)));
        Assert.Equal("Olive Organiser", back[4]);
        Assert.Equal("organiser_removed", back[5]);
        Assert.Equal("Olive Organiser", back[6]);

        var give = Cells(lines.Single(l => l.Contains("Free hour for helping", StringComparison.Ordinal)));
        Assert.Equal("yes", give[7]);
        Assert.Equal("0.00", give[8]);
        Assert.Equal("The club", give[6]);
        var sale = Cells(lines.Single(l => l.Contains("Cash at the desk", StringComparison.Ordinal)));
        Assert.Equal("", sale[7]);
        Assert.Equal("150.00", sale[8]);
        var goodwill = Cells(lines.Single(l => l.Contains("Goodwill", StringComparison.Ordinal)));
        Assert.Equal("The club", goodwill[6]);
        Assert.Equal("Club treasury", goodwill[4]);
    }
}
