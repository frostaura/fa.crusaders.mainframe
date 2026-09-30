using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The P11 adversarial review's findings, each pinned by the probe that proved it (D11–D13), on
/// Postgres. Every test here failed on the code as first shipped.
///
/// <para>
/// The club's court is 8 credits a slice; the standard game is four slices — 32 credits.
/// </para>
/// </summary>
public sealed class PlayersReviewHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private TestWebAppFactory CreateFactory() => pg.SharedHost;

    private static async Task<JsonElement> JsonAsync(HttpResponseMessage response) =>
        await response.Content.ReadFromJsonAsync<JsonElement>();

    private static string? Error(JsonElement body) => body.TryGetProperty("error", out var e) ? e.GetString() : null;

    private static Task<HttpResponseMessage> AcceptAsync(PlayersClub club, TestWebAppFactory f, Guid who, Guid bookingId, Guid seat, decimal expected) =>
        club.Client(f, who).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players/{seat}/accept", new { expectedShareCredits = expected });

    private static Task<HttpResponseMessage> AcceptLinkAsync(PlayersClub club, TestWebAppFactory f, Guid who, string token, decimal expected) =>
        club.Client(f, who).PostAsJsonAsync($"/api/v1/invites/{token}/accept", new { expectedShareCredits = expected });

    private static async Task<Guid> AddPartnerAsync(PlayersClub club, TestWebAppFactory f, Guid bookingId, object player, string? splitMode = null)
    {
        var response = await club.Client(f, club.Organiser).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players",
            new { players = new[] { player }, splitMode });
        var body = await JsonAsync(response);
        Assert.True(response.IsSuccessStatusCode, body.ToString());
        return body.GetProperty("participants")[0].GetProperty("participant_id").GetGuid();
    }

    /// <summary>A second court the organiser tries to buy, two days out, so no daily cap is in the way.</summary>
    private static Task<HttpResponseMessage> SpendAsync(PlayersClub club, TestWebAppFactory f, int slices) =>
        club.Client(f, club.Organiser).PostAsJsonAsync("/api/v1/bookings",
            new { courtId = club.CourtId, startsAt = PlayersClub.Tomorrow(8).AddDays(1), sliceCount = slices });

    // ------------------------------------------------------------------ 1. the link is the only way into an open seat

    /// <summary>
    /// An open link seat is claimed only through its link. The seat route answers the same 404 as
    /// a seat that names nothing — before and after the organiser rotates the link — so a leaked
    /// participant id (it is in every detail view) is not a way round a revoked token.
    /// </summary>
    [SkippableFact]
    public async Task An_open_link_seat_is_claimed_only_through_its_link()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "rvlink");
        await club.CreditAsync(f, club.Organiser, 100m);
        await club.CreditAsync(f, club.Sam, 50m);
        var (bookingId, body) = await club.BookWithPlayersAsync(f, [new { link = true }]);
        var seat = PlayersClub.SeatOf(body, 2);

        var bySeat = await AcceptAsync(club, f, club.Sam, bookingId, seat, 16m);
        Assert.Equal(HttpStatusCode.NotFound, bySeat.StatusCode);
        Assert.Equal("invite_not_found", Error(await JsonAsync(bySeat)));

        var rotated = await JsonAsync(await club.Client(f, club.Organiser).PostAsync($"/api/v1/bookings/{bookingId}/players/{seat}/link", null));
        Assert.Equal(HttpStatusCode.NotFound, (await AcceptAsync(club, f, club.Sam, bookingId, seat, 16m)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await AcceptLinkAsync(club, f, club.Sam, PlayersClub.TokenOf(body, 2)!, 16m)).StatusCode);
        Assert.Empty(await club.SharesAsync(f, bookingId));

        var byLink = await AcceptLinkAsync(club, f, club.Sam, rotated.GetProperty("invite_token").GetString()!, 16m);
        Assert.Equal(HttpStatusCode.OK, byLink.StatusCode);
        Assert.Equal(34m, await PlayersClub.BalanceAsync(f, club.Sam));
    }

    // ------------------------------------------------------------------ 2. a dead seat is no seat

    /// <summary>
    /// Only a LIVE seat makes a member a player of a booking. Declined, withdrawn and removed
    /// members read it as anybody else does — a 404 — and a removed member cannot claim their way
    /// back in through an open link.
    /// </summary>
    [SkippableFact]
    public async Task A_member_off_the_booking_no_longer_sees_it_and_a_removed_one_cannot_rejoin()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "rvdead");
        await club.CreditAsync(f, club.Organiser, 100m);
        await club.CreditAsync(f, club.Alex, 50m);
        await club.CreditAsync(f, club.Jo, 50m);
        var (bookingId, body) = await club.BookWithPlayersAsync(f, [new { userId = club.Sam }, new { userId = club.Alex }, new { userId = club.Jo }]);
        var (sam, alex, jo) = (PlayersClub.SeatOf(body, 2), PlayersClub.SeatOf(body, 3), PlayersClub.SeatOf(body, 4));
        var detail = $"/api/v1/bookings/{bookingId}";
        Assert.Equal(HttpStatusCode.OK, (await club.Client(f, club.Sam).GetAsync(detail)).StatusCode);

        Assert.Equal(HttpStatusCode.OK, (await club.Client(f, club.Sam).PostAsync($"{detail}/players/{sam}/decline", null)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await AcceptAsync(club, f, club.Alex, bookingId, alex, 10m)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await club.Client(f, club.Alex).PostAsync($"{detail}/players/{alex}/withdraw", null)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await club.Client(f, club.Organiser).DeleteAsync($"{detail}/players/{jo}")).StatusCode);

        foreach (var gone in new[] { club.Sam, club.Alex, club.Jo })
        {
            var read = await club.Client(f, gone).GetAsync(detail);
            Assert.Equal(HttpStatusCode.NotFound, read.StatusCode);
        }

        // An open seat goes up; Jo, who was taken off, finds the link and tries to take it.
        var link = await club.Client(f, club.Organiser).PostAsJsonAsync($"{detail}/players", new { players = new object[] { new { link = true } } });
        var token = (await JsonAsync(link)).GetProperty("participants")[0].GetProperty("invite_token").GetString()!;
        var claim = await AcceptLinkAsync(club, f, club.Jo, token, 10m);
        Assert.Equal(HttpStatusCode.Conflict, claim.StatusCode);
        Assert.Equal(PlayerErrors.PreviouslyRemoved, Error(await JsonAsync(claim)));
        Assert.DoesNotContain(await club.SeatsAsync(f, bookingId), s => s.UserId == club.Jo && s.IsLive);
        Assert.Equal(50m, await PlayersClub.BalanceAsync(f, club.Jo));
    }

    // ------------------------------------------------------------------ 3. shares received are held

    /// <summary>
    /// Every way a share can come BACK to a partner, after the organiser tried to spend it. The
    /// credits a share brings in are held until the share deadline, so the second court is refused
    /// and the return is always covered: the organiser never ends below zero.
    /// </summary>
    [SkippableTheory]
    [InlineData("withdraw")]
    [InlineData("lower")]
    [InlineData("remove")]
    [InlineData("resplit_on_add")]
    [InlineData("settle_outside")]
    [InlineData("late_cancel")]
    public async Task A_share_the_organiser_received_is_held_so_giving_it_back_never_overdraws_them(string scenario)
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, $"rvhold{scenario.Length}");
        await club.CreditAsync(f, club.Sam, 50m);
        await club.CreditAsync(f, club.Organiser, 32m);

        Guid bookingId, seat;
        decimal received;
        if (scenario == "late_cancel")
        {
            // Ten minutes out — inside the 15-minute penalty window. Sam pays the whole court.
            bookingId = await club.InsertBookingAsync(f, DateTimeOffset.UtcNow.AddMinutes(10));
            seat = await AddPartnerAsync(club, f, bookingId, new { userId = club.Sam, amount = 32m }, "amount");
            received = 32m;
        }
        else
        {
            var lower = scenario == "lower";
            var (id, body) = await club.BookWithPlayersAsync(f,
                [lower ? new { userId = club.Sam, amount = 24m } : (object)new { userId = club.Sam }], lower ? "amount" : "equal");
            (bookingId, seat, received) = (id, PlayersClub.SeatOf(body, 2), lower ? 24m : 16m);
        }

        Assert.Equal(HttpStatusCode.OK, (await AcceptAsync(club, f, club.Sam, bookingId, seat, received)).StatusCode);
        Assert.Equal(received, await PlayersClub.BalanceAsync(f, club.Organiser));

        // The wallet says so, and says until when.
        var wallet = await JsonAsync(await club.Client(f, club.Organiser).GetAsync("/api/v1/wallet"));
        Assert.Equal(received, wallet.GetProperty("held_credits").GetDecimal());
        Assert.Equal(0m, wallet.GetProperty("spendable_credits").GetDecimal());
        Assert.NotEqual(JsonValueKind.Null, wallet.GetProperty("held_until").ValueKind);

        // The organiser tries to spend what came in.
        var spend = await SpendAsync(club, f, (int)(received / 8m));
        Assert.Equal(HttpStatusCode.PaymentRequired, spend.StatusCode);

        var organiser = club.Client(f, club.Organiser);
        var path = $"/api/v1/bookings/{bookingId}";
        var giveBack = scenario switch
        {
            "withdraw" => await club.Client(f, club.Sam).PostAsync($"{path}/players/{seat}/withdraw", null),
            "lower" => await organiser.PutAsJsonAsync($"{path}/split", new { mode = "amount", seats = new[] { new { participantId = seat, amount = 8m } } }),
            "remove" => await organiser.DeleteAsync($"{path}/players/{seat}"),
            "resplit_on_add" => await organiser.PostAsJsonAsync($"{path}/players", new { players = new object[] { new { userId = club.Alex } } }),
            "settle_outside" => await club.Client(f, club.Admin, admin: true)
                .PostAsJsonAsync($"/api/v1/admin/bookings/{bookingId}/players/{seat}/settle-outside", new { reason = "Paid cash" }),
            _ => await club.Client(f, club.Admin, admin: true).PostAsJsonAsync($"/api/v1/admin/bookings/{bookingId}/cancel", new { }),
        };
        Assert.True(giveBack.IsSuccessStatusCode, await giveBack.Content.ReadAsStringAsync());

        Assert.True(await PlayersClub.BalanceAsync(f, club.Organiser) >= 0m, $"{scenario}: the organiser was overdrawn");
        Assert.True(await PlayersClub.BalanceAsync(f, club.Sam) >= 0m);
    }

    // ------------------------------------------------------------------ 4. a lapsed share is never collected

    /// <summary>
    /// An accepted partner who could not pay by the deadline lapses; the organiser's cover stands.
    /// Topping up later does not reopen it — the sweep, which still reconciles the booking for a
    /// week, collects nothing. Only an admin's explicit collect can.
    /// </summary>
    [SkippableFact]
    public async Task A_share_that_lapsed_unpaid_is_never_collected_by_the_sweep()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "rvlapse");
        var start = DateTimeOffset.UtcNow.AddHours(-50);
        var bookingId = await club.InsertBookingAsync(f, start);
        await club.WriteAsync(f, db => db.Bookings.IgnoreQueryFilters().First(b => b.Id == bookingId).Status = BookingStatus.Completed);
        await club.InsertSeatAsync(f, bookingId, 1, club.Organiser, ParticipantStatus.Accepted, 16m);
        var seat = await club.InsertSeatAsync(f, bookingId, 2, club.Sam, ParticipantStatus.Accepted, 16m, start.AddDays(-1));
        await club.WriteAsync(f, db => db.BookingParticipants.IgnoreQueryFilters().First(p => p.Id == seat).ConsentedCredits = 16m);

        async Task SweepAsync() => await club.InClubAsync(f, async sp =>
        {
            await sp.GetRequiredService<ShareSweep>().SweepAsync(DateTimeOffset.UtcNow, default);
            return 0;
        });

        await SweepAsync();
        Assert.NotNull((await club.SeatsAsync(f, bookingId)).Single(s => s.Id == seat).LapsedAt);

        await club.CreditAsync(f, club.Sam, 50m);
        await SweepAsync();
        var moves = await club.InClubAsync(f, sp => sp.GetRequiredService<ShareLedger>().ReconcileAsync(bookingId, default));

        Assert.Empty(moves);
        Assert.Empty(await club.SharesAsync(f, bookingId));
        Assert.Equal(50m, await PlayersClub.BalanceAsync(f, club.Sam));

        // The admin's explicit collect is the one way past it — and it logs what it moved.
        var collect = await club.Client(f, club.Admin, admin: true).PostAsJsonAsync(
            $"/api/v1/admin/bookings/{bookingId}/players/{seat}/collect", new { reason = "Agreed at the desk", allowNegativeBalance = true });
        Assert.Equal(HttpStatusCode.OK, collect.StatusCode);
        Assert.Equal(16m, (await JsonAsync(collect)).GetProperty("collected_credits").GetDecimal());
        Assert.Equal(34m, await PlayersClub.BalanceAsync(f, club.Sam));
    }

    // ------------------------------------------------------------------ 5. consent is to the figure the partner saw

    /// <summary>
    /// An accept names the share the partner saw. A share raised between the sheet and the tap is
    /// refused with the current figure, and nothing moves; an accept that names no figure is refused.
    /// </summary>
    [SkippableFact]
    public async Task An_accept_consents_only_to_the_share_the_partner_saw()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "rvconsent");
        await club.CreditAsync(f, club.Organiser, 100m);
        await club.CreditAsync(f, club.Sam, 50m);
        await club.CreditAsync(f, club.Jo, 50m);
        var (bookingId, body) = await club.BookWithPlayersAsync(f, [new { userId = club.Sam }, new { link = true }]);
        var sam = PlayersClub.SeatOf(body, 2);
        Assert.Equal(10m, (await club.SeatsAsync(f, bookingId)).Single(s => s.Id == sam).ShareCredits);

        // The organiser raises Sam's share while Sam is looking at 10.
        Assert.Equal(HttpStatusCode.OK, (await club.Client(f, club.Organiser).PutAsJsonAsync($"/api/v1/bookings/{bookingId}/split",
            new { mode = "amount", seats = new[] { new { participantId = sam, amount = 20m } } })).StatusCode);

        var stale = await AcceptAsync(club, f, club.Sam, bookingId, sam, 10m);
        Assert.Equal(HttpStatusCode.Conflict, stale.StatusCode);
        var refusal = await JsonAsync(stale);
        Assert.Equal(PlayerErrors.ShareChanged, Error(refusal));
        Assert.Equal(20m, refusal.GetProperty("share_credits").GetDecimal());
        Assert.Equal(ParticipantStatus.Invited, (await club.SeatsAsync(f, bookingId)).Single(s => s.Id == sam).Status);
        Assert.Empty(await club.SharesAsync(f, bookingId));

        var none = await club.Client(f, club.Sam).PostAsync($"/api/v1/bookings/{bookingId}/players/{sam}/accept", null);
        Assert.Equal(HttpStatusCode.BadRequest, none.StatusCode);
        Assert.Equal(PlayerErrors.ExpectedShareRequired, Error(await JsonAsync(none)));

        Assert.Equal(HttpStatusCode.OK, (await AcceptAsync(club, f, club.Sam, bookingId, sam, 20m)).StatusCode);
        Assert.Equal(30m, await PlayersClub.BalanceAsync(f, club.Sam));

        // The link route asks the same question.
        var linkShare = (await club.SeatsAsync(f, bookingId)).Single(s => s.Seat == 3).ShareCredits;
        var linkStale = await AcceptLinkAsync(club, f, club.Jo, PlayersClub.TokenOf(body, 3)!, linkShare - 1m);
        Assert.Equal(HttpStatusCode.Conflict, linkStale.StatusCode);
        Assert.Equal(PlayerErrors.ShareChanged, Error(await JsonAsync(linkStale)));
        Assert.Equal(50m, await PlayersClub.BalanceAsync(f, club.Jo));
    }

    // ------------------------------------------------------------------ 6. a bulk with players is all or nothing

    [SkippableFact]
    public async Task A_bulk_whose_split_cannot_work_on_any_item_books_nothing()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "rvbulk");
        await club.CreditAsync(f, club.Organiser, 100m);
        var member = club.Client(f, club.Organiser);

        // 20 credits fits the first court (32) and not the second (8).
        var priced = await member.PostAsJsonAsync("/api/v1/bookings/bulk", new
        {
            idempotencyKey = Guid.NewGuid().ToString("N"),
            items = new[]
            {
                new { courtId = club.CourtId, startsAt = PlayersClub.Tomorrow(8), sliceCount = 4 },
                new { courtId = club.CourtId, startsAt = PlayersClub.Tomorrow(12), sliceCount = 1 },
            },
            players = new object[] { new { userId = club.Sam, amount = 20m } },
            splitMode = "amount",
        });
        Assert.Equal(HttpStatusCode.BadRequest, priced.StatusCode);
        Assert.Equal(SplitCalculator.ExceedsPrice, Error(await JsonAsync(priced)));

        // A malformed player is refused even when the first item cannot be priced at all.
        var shaped = await member.PostAsJsonAsync("/api/v1/bookings/bulk", new
        {
            idempotencyKey = Guid.NewGuid().ToString("N"),
            items = new[]
            {
                new { courtId = club.CourtId, startsAt = PlayersClub.Tomorrow(8).AddDays(-3), sliceCount = 4 },
                new { courtId = club.CourtId, startsAt = PlayersClub.Tomorrow(14), sliceCount = 4 },
            },
            players = new object[] { new { userId = club.Sam, guestName = "Both at once" } },
        });
        Assert.Equal(HttpStatusCode.BadRequest, shaped.StatusCode);
        Assert.Equal(PlayerErrors.InvalidPlayer, Error(await JsonAsync(shaped)));

        Assert.Equal(0, await PlayersClub.ReadAsync(f, db => db.Bookings.IgnoreQueryFilters().CountAsync(b => b.TenantId == club.TenantId)));
        Assert.Equal(100m, await PlayersClub.BalanceAsync(f, club.Organiser));
    }

    // ------------------------------------------------------------------ 7. no invite loop

    /// <summary>
    /// A member who said no, or was taken off, is not invited again by the organiser (an admin
    /// still can); the club caps invites per booking; and an invite repeated inside the reminder
    /// cadence reaches the inbox without mailing the member again.
    /// </summary>
    [SkippableFact]
    public async Task An_organiser_cannot_mail_a_member_in_a_loop()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "rvloop",
            PlayersClub.Settings.Replace("}", ",\"player_invites_per_booking\":4}"));
        await club.CreditAsync(f, club.Organiser, 100m);
        var (bookingId, body) = await club.BookWithPlayersAsync(f, [new { userId = club.Sam }, new { userId = club.Alex }]);
        var organiser = club.Client(f, club.Organiser);
        var path = $"/api/v1/bookings/{bookingId}/players";

        Assert.Equal(HttpStatusCode.OK, (await club.Client(f, club.Sam).PostAsync($"{path}/{PlayersClub.SeatOf(body, 2)}/decline", null)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await organiser.DeleteAsync($"{path}/{PlayersClub.SeatOf(body, 3)}")).StatusCode);

        var again = await organiser.PostAsJsonAsync(path, new { players = new object[] { new { userId = club.Sam } } });
        Assert.Equal(HttpStatusCode.Conflict, again.StatusCode);
        Assert.Equal(PlayerErrors.PreviouslyDeclined, Error(await JsonAsync(again)));
        var back = await organiser.PostAsJsonAsync(path, new { players = new object[] { new { userId = club.Alex } } });
        Assert.Equal(HttpStatusCode.Conflict, back.StatusCode);
        Assert.Equal(PlayerErrors.PreviouslyRemoved, Error(await JsonAsync(back)));

        // The desk can put Alex back — and Alex's inbox says so without a second mail inside the cadence.
        var admin = club.Client(f, club.Admin, admin: true);
        Assert.Equal(HttpStatusCode.OK, (await admin.PostAsJsonAsync($"/api/v1/admin/bookings/{bookingId}/players", new { userId = club.Alex, reason = "Phoned" })).StatusCode);
        // The desk's re-add is told as the club's (players.club_seat, review round 1 B8) under the same loop rule.
        var alexMail = await PlayersClub.ReadAsync(f, db => db.AdminNotifications.IgnoreQueryFilters()
            .CountAsync(n => n.TenantId == club.TenantId && n.RecipientUserId == club.Alex
                             && (n.Kind == MemberEventCatalogue.Invited || n.Kind == MemberEventCatalogue.ClubSeat)));
        var alexInbox = await PlayersClub.ReadAsync(f, db => db.MemberNotifications.IgnoreQueryFilters()
            .CountAsync(n => n.TenantId == club.TenantId && n.UserId == club.Alex
                             && (n.Kind == MemberEventCatalogue.Invited || n.Kind == MemberEventCatalogue.ClubSeat)));
        Assert.Equal(1, alexMail);
        Assert.Equal(2, alexInbox);

        // Four invites made on this booking (Sam, Alex, Alex again): one more is allowed, then none.
        Assert.Equal(HttpStatusCode.OK, (await organiser.PostAsJsonAsync(path, new { players = new object[] { new { link = true } } })).StatusCode);
        var capped = await organiser.PostAsJsonAsync(path, new { players = new object[] { new { userId = club.Jo } } });
        Assert.Equal(HttpStatusCode.Conflict, capped.StatusCode);
        var refusal = await JsonAsync(capped);
        Assert.Equal(PlayerErrors.InviteLimit, Error(refusal));
        Assert.Equal(4, refusal.GetProperty("limit").GetInt32());
    }

    [SkippableFact]
    public async Task The_invite_cap_is_a_bounded_club_setting()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "rvcapset");
        var admin = club.Client(f, club.Admin, admin: true);
        var shown = await JsonAsync(await admin.GetAsync("/api/v1/admin/settings"));
        Assert.Equal(8, shown.GetProperty("player_invites_per_booking").GetInt32());

        Dictionary<string, object?> Body(int value) => new()
        {
            ["sliceMinutes"] = shown.GetProperty("slice_minutes").GetInt32(),
            ["slicePriceCredits"] = shown.GetProperty("slice_price_credits").GetDecimal(),
            ["advanceBookingDays"] = shown.GetProperty("advance_booking_days").GetInt32(),
            ["dayStartMinute"] = shown.GetProperty("day_start_minute").GetInt32(),
            ["dayEndMinute"] = shown.GetProperty("day_end_minute").GetInt32(),
            ["penaltyPct"] = shown.GetProperty("penalty_pct").GetDecimal(),
            ["graceWindowMinutes"] = shown.GetProperty("grace_window_minutes").GetInt32(),
            ["penaltyWindowMinutes"] = shown.GetProperty("penalty_window_minutes").GetInt32(),
            ["player_invites_per_booking"] = value,
        };
        foreach (var bad in new[] { 3, 21 })
        {
            var response = await admin.PutAsJsonAsync("/api/v1/admin/settings", Body(bad));
            Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
            Assert.Equal("player_invites_per_booking_out_of_range", Error(await JsonAsync(response)));
        }
        Assert.True((await admin.PutAsJsonAsync("/api/v1/admin/settings", Body(12))).IsSuccessStatusCode);
        Assert.Equal(12, (await JsonAsync(await admin.GetAsync("/api/v1/admin/settings"))).GetProperty("player_invites_per_booking").GetInt32());
    }

    // ------------------------------------------------------------------ 8. a lost race is not a stale yes

    /// <summary>
    /// The loser of an accept race is answered from the winner's row — a 200 only if the consent
    /// on it still covers the share. Here the share rose after the winner accepted.
    /// </summary>
    [SkippableFact]
    public async Task A_lost_accept_race_is_not_a_yes_to_a_share_that_has_since_risen()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "rvrace");
        await club.CreditAsync(f, club.Organiser, 100m);
        await club.CreditAsync(f, club.Sam, 50m);
        var (bookingId, body) = await club.BookWithPlayersAsync(f, [new { userId = club.Sam }]);
        var sam = PlayersClub.SeatOf(body, 2);
        Assert.Equal(HttpStatusCode.OK, (await AcceptAsync(club, f, club.Sam, bookingId, sam, 16m)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await club.Client(f, club.Organiser).PutAsJsonAsync($"/api/v1/bookings/{bookingId}/split",
            new { mode = "amount", seats = new[] { new { participantId = sam, amount = 24m } } })).StatusCode);

        var answer = await club.InClubAsync(f, sp => sp.GetRequiredService<PlayersService>().AlreadyAnsweredAsync(sam, club.Sam, default));

        Assert.Equal(409, answer.StatusCode);
    }

    // ------------------------------------------------------------------ 9. the collect's record is what moved

    /// <summary>
    /// An admin collect that cannot post (a reference already taken — the sabotage stands in for
    /// any failure between the record and the money) leaves no change-log line, no consent and no
    /// money: the record and the movement are one save.
    /// </summary>
    [SkippableFact]
    public async Task An_admin_collect_that_moves_nothing_records_nothing()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "rvcollect");
        await club.CreditAsync(f, club.Organiser, 100m);
        await club.CreditAsync(f, club.Sam, 50m);
        var (bookingId, body) = await club.BookWithPlayersAsync(f, [new { userId = club.Sam }]);
        var sam = PlayersClub.SeatOf(body, 2);
        var admin = club.Client(f, club.Admin, admin: true);
        var path = $"/api/v1/admin/bookings/{bookingId}/players/{sam}";
        Assert.Equal(HttpStatusCode.OK, (await admin.PostAsJsonAsync($"{path}/accept", new { reason = "Playing" })).StatusCode);

        await club.WriteAsync(f, db => db.LedgerEntries.Add(new LedgerEntry
        {
            TenantId = club.TenantId, UserId = club.Bystander, Type = LedgerEntryType.AdminAdjustment, AmountCredits = 0m,
            ActorUserId = club.Admin, ExternalReference = ShareLedger.Reference(sam, 1, "in"),
        }));

        var collect = await admin.PostAsJsonAsync($"{path}/collect", new { reason = "Owed", allowNegativeBalance = true });

        Assert.False(collect.IsSuccessStatusCode);
        Assert.False(await PlayersClub.ReadAsync(f, db => db.AdminChangeLogs.IgnoreQueryFilters()
            .AnyAsync(a => a.TenantId == club.TenantId && a.Action == AdminChangeActions.BookingShareCollected)));
        Assert.Equal(0m, (await club.SeatsAsync(f, bookingId)).Single(s => s.Id == sam).ConsentedCredits);
        Assert.Equal(50m, await PlayersClub.BalanceAsync(f, club.Sam));
    }

    // ------------------------------------------------------------------ 10. settle-outside is for a seat that was taken

    [SkippableFact]
    public async Task Settling_outside_needs_a_seat_the_member_accepted()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "rvsettle");
        await club.CreditAsync(f, club.Organiser, 100m);
        var (bookingId, body) = await club.BookWithPlayersAsync(f, [new { userId = club.Sam }]);
        var sam = PlayersClub.SeatOf(body, 2);

        var settle = await club.Client(f, club.Admin, admin: true)
            .PostAsJsonAsync($"/api/v1/admin/bookings/{bookingId}/players/{sam}/settle-outside", new { reason = "Cash" });

        Assert.Equal(HttpStatusCode.Conflict, settle.StatusCode);
        Assert.Equal(PlayerErrors.NotAccepted, Error(await JsonAsync(settle)));
        var seat = (await club.SeatsAsync(f, bookingId)).Single(s => s.Id == sam);
        Assert.Equal(ParticipantStatus.Invited, seat.Status);
        Assert.Null(seat.SettledOutsideAt);
    }

    // ------------------------------------------------------------------ 11. no lapse mail for a game that never happened

    [SkippableFact]
    public async Task An_invite_on_a_cancelled_game_lapses_without_a_word()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "rvquiet");
        var start = DateTimeOffset.UtcNow.AddHours(-50);
        var bookingId = await club.InsertBookingAsync(f, start);
        await club.WriteAsync(f, db => db.Bookings.IgnoreQueryFilters().First(b => b.Id == bookingId).Status = BookingStatus.Cancelled);
        await club.InsertSeatAsync(f, bookingId, 1, club.Organiser, ParticipantStatus.Accepted, 16m);
        var seat = await club.InsertSeatAsync(f, bookingId, 2, club.Sam, ParticipantStatus.Invited, 16m, start.AddDays(-1));

        await club.InClubAsync(f, async sp =>
        {
            await sp.GetRequiredService<ShareSweep>().SweepAsync(DateTimeOffset.UtcNow, default);
            return 0;
        });

        Assert.Equal(ParticipantStatus.Lapsed, (await club.SeatsAsync(f, bookingId)).Single(s => s.Id == seat).Status);
        Assert.False(await PlayersClub.ReadAsync(f, db => db.MemberNotifications.IgnoreQueryFilters()
            .AnyAsync(n => n.TenantId == club.TenantId && n.Kind == MemberEventCatalogue.Lapsed)));
    }

    // ------------------------------------------------------------------ 12. an old booking's adjustment moves its shares

    /// <summary>
    /// A desk adjustment naming a booking moves the organiser's <c>Owed</c>; the shares follow at
    /// the call site, however old the booking — the minute sweep only looks back a week.
    /// </summary>
    [SkippableFact]
    public async Task An_adjustment_naming_an_old_booking_reconciles_its_shares_at_once()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "rvadjust");
        var bookingId = await club.InsertBookingAsync(f, DateTimeOffset.UtcNow.AddDays(-30));
        await club.WriteAsync(f, db => db.Bookings.IgnoreQueryFilters().First(b => b.Id == bookingId).Status = BookingStatus.Completed);
        await club.InsertSeatAsync(f, bookingId, 1, club.Organiser, ParticipantStatus.Accepted, 16m);
        var sam = await club.InsertSeatAsync(f, bookingId, 2, club.Sam, ParticipantStatus.Accepted, 16m);
        await club.WriteAsync(f, db =>
        {
            db.BookingParticipants.IgnoreQueryFilters().First(p => p.Id == sam).ConsentedCredits = 16m;
            foreach (var posting in ShareLedger.Pair(new Booking { Id = bookingId }, new ShareMove(sam, club.Sam, club.Organiser, 16m, 1), club.Sam))
            {
                db.LedgerEntries.Add(new LedgerEntry
                {
                    TenantId = club.TenantId, UserId = posting.UserId, Type = posting.Type, AmountCredits = posting.AmountCredits,
                    ActorUserId = posting.ActorUserId, RelatedBookingId = bookingId, ExternalReference = posting.ExternalReference,
                });
            }
        });
        Assert.Equal(-16m, await PlayersClub.BalanceAsync(f, club.Sam));

        var adjust = await club.Client(f, club.Admin, admin: true).PostAsJsonAsync($"/api/v1/admin/credit/{club.Organiser}/adjust", new
        {
            amountCredits = 32m, reason = "Court was flooded", relatedBookingId = bookingId, reasonCode = "goodwill",
        });

        Assert.True(adjust.IsSuccessStatusCode, await adjust.Content.ReadAsStringAsync());
        Assert.Equal(0m, await PlayersClub.BalanceAsync(f, club.Sam));
    }
}
