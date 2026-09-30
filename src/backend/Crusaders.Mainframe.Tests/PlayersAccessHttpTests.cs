using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Workers;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// D11–D13 at the HTTP boundary, on Postgres: who may see a booking's players, the tenancy of
/// every new table, the opt-in directory, the member inbox and its mail, admin god mode, and the
/// settings and preferences the feature added.
/// </summary>
public sealed class PlayersAccessHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private TestWebAppFactory CreateFactory() => pg.SharedHost;

    private static async Task<JsonElement> JsonAsync(HttpResponseMessage response) =>
        await response.Content.ReadFromJsonAsync<JsonElement>();

    private static string? Error(JsonElement body) => body.TryGetProperty("error", out var e) ? e.GetString() : null;

    private static async Task<(PlayersClub Club, Guid BookingId, JsonElement Body)> GameAsync(TestWebAppFactory f, string prefix)
    {
        var club = await PlayersClub.SeedAsync(f, prefix);
        await club.CreditAsync(f, club.Organiser, 100m);
        await club.CreditAsync(f, club.Sam, 50m);
        var (bookingId, body) = await club.BookWithPlayersAsync(f, [new { userId = club.Sam }, new { guestName = "Uncle Bob" }]);
        return (club, bookingId, body);
    }

    private static async Task FindableAsync(PlayersClub club, TestWebAppFactory f, Guid who, bool findable = true) =>
        Assert.Equal(HttpStatusCode.OK, (await club.Client(f, who).PutAsJsonAsync("/api/v1/me/preferences", new { findable })).StatusCode);

    // ------------------------------------------------------------------ the booking detail

    [SkippableFact]
    public async Task The_organiser_and_the_players_see_the_booking_and_nobody_else_does()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var (club, bookingId, _) = await GameAsync(f, "pldetail");
        var path = $"/api/v1/bookings/{bookingId}";

        var organiser = await JsonAsync(await club.Client(f, club.Organiser).GetAsync(path));
        Assert.Equal("organiser", organiser.GetProperty("viewer").GetProperty("role").GetString());
        var players = organiser.GetProperty("players").EnumerateArray().ToList();
        Assert.Equal(3, players.Count);
        Assert.Equal(["organiser", "member", "guest"], players.Select(p => p.GetProperty("kind").GetString()));
        Assert.Equal(["A", "A", "B"], players.Select(p => p.GetProperty("team").GetString()));
        Assert.Equal("Uncle Bob", players[2].GetProperty("name").GetString());
        Assert.Equal(0m, players[2].GetProperty("share_credits").GetDecimal());
        Assert.Equal(16m, players[1].GetProperty("share_credits").GetDecimal());
        Assert.True(organiser.GetProperty("permissions").GetProperty("can_invite").GetBoolean());
        Assert.Equal(32m, organiser.GetProperty("money").GetProperty("price_credits").GetDecimal());

        // Photo and name only: nothing that identifies a member beyond what the grid shows.
        var member = players[1].EnumerateObject().Select(p => p.Name).ToList();
        Assert.DoesNotContain("email", member);
        Assert.DoesNotContain("@", organiser.GetRawText());

        var sam = await JsonAsync(await club.Client(f, club.Sam).GetAsync(path));
        Assert.Equal("player", sam.GetProperty("viewer").GetProperty("role").GetString());
        Assert.True(sam.GetProperty("permissions").GetProperty("can_accept").GetBoolean());

        // IDOR: another member of the same club with the id in hand gets a 404, not a 403.
        var stranger = await club.Client(f, club.Bystander).GetAsync(path);
        Assert.Equal(HttpStatusCode.NotFound, stranger.StatusCode);

        var admin = await JsonAsync(await club.Client(f, club.Admin, admin: true).GetAsync(path));
        Assert.Equal("admin", admin.GetProperty("viewer").GetProperty("role").GetString());
    }

    [SkippableFact]
    public async Task A_booking_nobody_added_players_to_is_just_the_booker()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "plsolo");
        var bookingId = await club.InsertBookingAsync(f, PlayersClub.Tomorrow());

        var view = await JsonAsync(await club.Client(f, club.Organiser).GetAsync($"/api/v1/bookings/{bookingId}"));

        var players = view.GetProperty("players").EnumerateArray().ToList();
        var only = Assert.Single(players);
        Assert.Equal("organiser", only.GetProperty("kind").GetString());
        Assert.Equal(32m, only.GetProperty("share_credits").GetDecimal());
        Assert.False(view.GetProperty("money").GetProperty("is_split").GetBoolean());
        Assert.Empty(await club.SeatsAsync(f, bookingId));
    }

    /// <summary>Everything an organiser can do to a booking is a 404 in anybody else's hands — the id proves nothing.</summary>
    [SkippableFact]
    public async Task Only_the_organiser_can_change_the_players()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var (club, bookingId, body) = await GameAsync(f, "plidor");
        var samSeat = PlayersClub.SeatOf(body, 2);
        var sam = club.Client(f, club.Sam);
        var bea = club.Client(f, club.Bystander);

        Assert.Equal(HttpStatusCode.NotFound, (await bea.PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players", new { players = new[] { new { userId = club.Jo } } })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await sam.DeleteAsync($"/api/v1/bookings/{bookingId}/players/{samSeat}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await bea.PutAsJsonAsync($"/api/v1/bookings/{bookingId}/split", new { mode = "equal" })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await bea.PostAsync($"/api/v1/bookings/{bookingId}/players/{samSeat}/nudge", null)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await bea.PostAsync($"/api/v1/bookings/{bookingId}/players/{samSeat}/link", null)).StatusCode);

        // A seat addressed to Sam cannot be accepted, declined or withdrawn from by anybody else.
        Assert.Equal(HttpStatusCode.NotFound, (await bea.PostAsync($"/api/v1/bookings/{bookingId}/players/{samSeat}/accept", null)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await bea.PostAsync($"/api/v1/bookings/{bookingId}/players/{samSeat}/decline", null)).StatusCode);
        // Nor through a different booking's path.
        var other = await club.InsertBookingAsync(f, PlayersClub.Tomorrow(12));
        Assert.Equal(HttpStatusCode.NotFound, (await sam.PostAsync($"/api/v1/bookings/{other}/players/{samSeat}/accept", null)).StatusCode);

        Assert.Equal(ParticipantStatus.Invited, (await club.SeatsAsync(f, bookingId)).Single(s => s.Id == samSeat).Status);
    }

    // ------------------------------------------------------------------ tenancy of every new table

    /// <summary>
    /// A second club in the same database: its bookings, seats, links, inbox lines, favourites and
    /// findable members are invisible and untouchable from the first, through every route.
    /// </summary>
    [SkippableFact]
    public async Task Nothing_of_one_club_reaches_another()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var (home, _, _) = await GameAsync(f, "plxhome");
        var (away, awayBooking, awayBody) = await GameAsync(f, "plxaway");
        var awaySeat = PlayersClub.SeatOf(awayBody, 2);
        var awayLink = await JsonAsync(await away.Client(f, away.Organiser).PostAsync($"/api/v1/bookings/{awayBooking}/players/{awaySeat}/link", null));
        var token = awayLink.GetProperty("invite_token").GetString();
        await FindableAsync(away, f, away.Jo);
        await away.Client(f, away.Sam).PutAsync($"/api/v1/me/partners/favourites/{away.Jo}", null);

        var me = home.Client(f, home.Sam);
        Assert.Equal(HttpStatusCode.NotFound, (await me.GetAsync($"/api/v1/bookings/{awayBooking}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await me.PostAsync($"/api/v1/bookings/{awayBooking}/players/{awaySeat}/accept", null)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await me.GetAsync($"/api/v1/invites/{token}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await me.PostAsync($"/api/v1/invites/{token}/accept", null)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await me.PutAsync($"/api/v1/me/partners/favourites/{away.Jo}", null)).StatusCode);

        // An organiser cannot invite another club's member by id.
        var invite = await home.Client(f, home.Organiser).PostAsJsonAsync("/api/v1/bookings", new
        {
            courtId = home.CourtId, startsAt = PlayersClub.Tomorrow(14).AddDays(1), sliceCount = 1, players = new[] { new { userId = away.Jo } },
        });
        Assert.Equal(HttpStatusCode.NotFound, invite.StatusCode);
        Assert.Equal(PlayerErrors.MemberNotFound, Error(await JsonAsync(invite)));

        var directory = await JsonAsync(await me.GetAsync("/api/v1/members/directory?q=Jo"));
        Assert.Empty(directory.GetProperty("items").EnumerateArray());

        var inbox = await JsonAsync(await me.GetAsync("/api/v1/me/notifications"));
        Assert.All(inbox.GetProperty("items").EnumerateArray(), n => Assert.NotEqual(awayBooking, n.GetProperty("booking_id").GetGuid()));
        var awayLine = await PlayersClub.ReadAsync(f, db => db.MemberNotifications.IgnoreQueryFilters().FirstAsync(n => n.UserId == away.Sam));
        Assert.Equal(HttpStatusCode.NotFound, (await me.PostAsync($"/api/v1/me/notifications/{awayLine.Id}/read", null)).StatusCode);

        Assert.Empty((await JsonAsync(await me.GetAsync("/api/v1/me/partners/favourites"))).GetProperty("items").EnumerateArray());
        Assert.Equal(0, (await JsonAsync(await me.GetAsync("/api/v1/me/invites"))).GetProperty("items").EnumerateArray()
            .Count(i => i.GetProperty("booking_id").GetGuid() == awayBooking));

        // The query filters themselves: a context in the home club sees none of the away rows.
        var leaked = await home.InClubAsync(f, async sp =>
        {
            var db = sp.GetRequiredService<Api.Persistence.MainframeDbContext>();
            return await db.BookingParticipants.CountAsync(p => p.BookingId == awayBooking)
                   + await db.MemberNotifications.CountAsync(n => n.UserId == away.Sam)
                   + await db.PartnerFavourites.CountAsync(x => x.UserId == away.Sam);
        });
        Assert.Equal(0, leaked);
    }

    // ------------------------------------------------------------------ D13 — the directory

    [SkippableFact]
    public async Task The_directory_finds_only_members_who_opted_in_and_says_only_their_name_and_photo()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "pldir");
        await FindableAsync(club, f, club.Sam);
        await FindableAsync(club, f, club.Alex);
        await FindableAsync(club, f, club.Jo, findable: false);
        // Findable, but suspended: gone from the directory without anybody touching the flag.
        await FindableAsync(club, f, club.Bystander);
        await club.WriteAsync(f, db => db.Memberships.IgnoreQueryFilters().First(m => m.UserId == club.Bystander).Status = MembershipStatus.Suspended);

        var me = club.Client(f, club.Organiser);
        var found = await JsonAsync(await me.GetAsync("/api/v1/members/directory?q=partner"));
        var items = found.GetProperty("items").EnumerateArray().ToList();
        Assert.Equal(new[] { club.Alex, club.Sam }.Order(), items.Select(i => i.GetProperty("user_id").GetGuid()).Order());
        Assert.All(items, i => Assert.Equal(["user_id", "name", "photo_url"], i.EnumerateObject().Select(p => p.Name)));

        Assert.Empty((await JsonAsync(await me.GetAsync("/api/v1/members/directory?q=Bea"))).GetProperty("items").EnumerateArray());
        Assert.Empty((await JsonAsync(await club.Client(f, club.Sam).GetAsync("/api/v1/members/directory?q=Sam"))).GetProperty("items").EnumerateArray());
        Assert.Equal("query_too_short", Error(await JsonAsync(await me.GetAsync("/api/v1/members/directory?q=S"))));
        // A LIKE wildcard is a literal, not a way to list the club.
        Assert.Empty((await JsonAsync(await me.GetAsync("/api/v1/members/directory?q=%25%25"))).GetProperty("items").EnumerateArray());
    }

    [SkippableFact]
    public async Task The_directory_is_rate_limited_per_member_by_the_clubs_setting()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "pldirrl", PlayersClub.Settings.Replace("}", ""","directory_searches_per_minute":5}"""));
        var me = club.Client(f, club.Organiser);

        for (var i = 0; i < 5; i++) Assert.Equal(HttpStatusCode.OK, (await me.GetAsync("/api/v1/members/directory?q=partner")).StatusCode);
        var sixth = await me.GetAsync("/api/v1/members/directory?q=partner");

        Assert.Equal(HttpStatusCode.TooManyRequests, sixth.StatusCode);
        Assert.Equal("directory_rate_limited", Error(await JsonAsync(sixth)));
        // Another member's budget is their own.
        Assert.Equal(HttpStatusCode.OK, (await club.Client(f, club.Sam).GetAsync("/api/v1/members/directory?q=partner")).StatusCode);
    }

    // ------------------------------------------------------------------ partners

    [SkippableFact]
    public async Task Recent_partners_come_from_accepted_games_and_favourites_are_private_and_idempotent()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var (club, bookingId, body) = await GameAsync(f, "plrecent");
        var organiser = club.Client(f, club.Organiser);

        Assert.Empty((await JsonAsync(await organiser.GetAsync("/api/v1/me/partners/recent"))).GetProperty("items").EnumerateArray());
        await club.Client(f, club.Sam).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players/{PlayersClub.SeatOf(body, 2)}/accept",
            new { expectedShareCredits = 32m });

        // Accepted, but not played yet: a game still ahead is not "played with" (review round 1, B11).
        Assert.Empty((await JsonAsync(await organiser.GetAsync("/api/v1/me/partners/recent"))).GetProperty("items").EnumerateArray());

        // Its time comes and nobody scans in: still not played.
        await club.WriteAsync(f, db =>
        {
            var b = db.Bookings.IgnoreQueryFilters().Single(x => x.Id == bookingId);
            var length = b.EndsAt - b.StartsAt;
            b.StartsAt = DateTimeOffset.UtcNow.AddHours(-1);
            b.EndsAt = b.StartsAt + length;
        });
        Assert.Empty((await JsonAsync(await organiser.GetAsync("/api/v1/me/partners/recent"))).GetProperty("items").EnumerateArray());

        // The box checked it in: now they played together.
        await club.WriteAsync(f, db =>
        {
            var b = db.Bookings.IgnoreQueryFilters().Single(x => x.Id == bookingId);
            b.CheckedInAt = b.StartsAt.AddMinutes(1);
        });

        var recent = (await JsonAsync(await organiser.GetAsync("/api/v1/me/partners/recent"))).GetProperty("items").EnumerateArray().ToList();
        Assert.Equal(club.Sam, Assert.Single(recent).GetProperty("user_id").GetGuid());
        Assert.Equal(club.Organiser, Assert.Single((await JsonAsync(await club.Client(f, club.Sam).GetAsync("/api/v1/me/partners/recent")))
            .GetProperty("items").EnumerateArray()).GetProperty("user_id").GetGuid());

        Assert.Equal(HttpStatusCode.OK, (await organiser.PutAsync($"/api/v1/me/partners/favourites/{club.Jo}", null)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await organiser.PutAsync($"/api/v1/me/partners/favourites/{club.Jo}", null)).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await organiser.PutAsync($"/api/v1/me/partners/favourites/{club.Organiser}", null)).StatusCode);
        Assert.Single((await JsonAsync(await organiser.GetAsync("/api/v1/me/partners/favourites"))).GetProperty("items").EnumerateArray());
        Assert.Empty((await JsonAsync(await club.Client(f, club.Jo).GetAsync("/api/v1/me/partners/favourites"))).GetProperty("items").EnumerateArray());

        await organiser.DeleteAsync($"/api/v1/me/partners/favourites/{club.Jo}");
        Assert.Empty((await JsonAsync(await organiser.GetAsync("/api/v1/me/partners/favourites"))).GetProperty("items").EnumerateArray());
    }

    // ------------------------------------------------------------------ inbox and mail

    [SkippableFact]
    public async Task A_member_reads_their_own_inbox_and_the_mail_goes_to_them_alone()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var factory = CreateFactory();
        var mail = new CapturingMail();
        var f = CapturingMail.On(factory, mail);
        var club = await PlayersClub.SeedAsync(f, "plinbox");
        await club.CreditAsync(f, club.Organiser, 100m);
        await club.BookWithPlayersAsync(f, [new { userId = club.Sam }]);
        var sam = club.Client(f, club.Sam);

        Assert.Equal(1, (await JsonAsync(await sam.GetAsync("/api/v1/me/notifications/unread-count"))).GetProperty("unread_count").GetInt32());
        var list = await JsonAsync(await sam.GetAsync("/api/v1/me/notifications"));
        var line = Assert.Single(list.GetProperty("items").EnumerateArray());
        Assert.Equal(MemberEventCatalogue.Invited, line.GetProperty("kind").GetString());
        Assert.StartsWith("/invites/", line.GetProperty("link").GetString());

        // The organiser cannot mark Sam's line read; Sam can.
        var id = line.GetProperty("id").GetGuid();
        Assert.Equal(HttpStatusCode.NotFound, (await club.Client(f, club.Organiser).PostAsync($"/api/v1/me/notifications/{id}/read", null)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await sam.PostAsync($"/api/v1/me/notifications/{id}/read", null)).StatusCode);
        Assert.Equal(0, (await JsonAsync(await sam.GetAsync("/api/v1/me/notifications/unread-count"))).GetProperty("unread_count").GetInt32());

        // Delivered by the same outbox the admin notices use, to Sam and nobody else.
        for (var i = 0; i < 200 && await PendingAsync(f, club) > 0; i++) await PeopleClub.DeliverAdminNoticesAsync(f);
        // The organiser's own booking confirmation is BookingService's, sent directly; the players
        // mail is the outbox's. Sam gets exactly the invite, and nobody else gets a players mail.
        var ours = mail.Sent.Where(m => m.To.EndsWith($"@{club.Slug}.review.test", StringComparison.Ordinal)).ToList();
        var invite = Assert.Single(ours, m => m.To.StartsWith("sam.partner@", StringComparison.Ordinal));
        Assert.DoesNotContain(ours, m => m.Subject.Contains("invited you", StringComparison.Ordinal) && m != invite);
        Assert.Contains("invited you to play", invite.Subject);

        // And it is not on the administrators' feed.
        var feed = await JsonAsync(await club.Client(f, club.Admin, admin: true).GetAsync("/api/v1/admin/notifications"));
        Assert.DoesNotContain(feed.GetProperty("items").EnumerateArray(), n => n.GetProperty("kind").GetString()!.StartsWith("players.", StringComparison.Ordinal));
    }

    [SkippableFact]
    public async Task Non_urgent_member_mail_waits_for_quiet_hours_to_end()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var factory = CreateFactory();
        var mail = new CapturingMail();
        var f = CapturingMail.On(factory, mail);
        // Quiet all day except the minute before midnight: whatever the hour, it is quiet now.
        var now = DateTimeOffset.UtcNow;
        var start = (now.Hour * 60) + now.Minute - 1;
        var settings = PlayersClub.Settings.Replace("\"member_quiet_start_minute\":0,\"member_quiet_end_minute\":0",
            $"\"member_quiet_start_minute\":{(start + 1440) % 1440},\"member_quiet_end_minute\":{(start + 1439) % 1440}");
        var club = await PlayersClub.SeedAsync(f, "plquiet", settings);
        await club.CreditAsync(f, club.Organiser, 100m);
        await club.BookWithPlayersAsync(f, [new { userId = club.Sam }]);

        await PeopleClub.DeliverAdminNoticesAsync(f);

        Assert.DoesNotContain(mail.Sent, m => m.To.StartsWith($"sam.partner@{club.Slug}", StringComparison.Ordinal));
        var row = await PlayersClub.ReadAsync(f, db => db.AdminNotifications.IgnoreQueryFilters().SingleAsync(n => n.TenantId == club.TenantId));
        Assert.True(row.DueAt > now.AddHours(20), $"due {row.DueAt:O}, now {now:O}");
        // The inbox line is there at once: quiet hours withhold the interruption, not the record.
        Assert.Equal(1, (await JsonAsync(await club.Client(f, club.Sam).GetAsync("/api/v1/me/notifications/unread-count"))).GetProperty("unread_count").GetInt32());
    }

    private static Task<int> PendingAsync(Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactory<Program> f, PlayersClub club) =>
        PlayersClub.ReadAsync(f, db => db.AdminNotifications.IgnoreQueryFilters()
            .CountAsync(n => n.TenantId == club.TenantId && n.State == AdminNotificationState.Pending));

    [SkippableFact]
    public async Task A_nudge_is_limited_per_day_and_reminders_follow_the_clubs_cadence()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var (club, bookingId, body) = await GameAsync(f, "plnudge");
        var samSeat = PlayersClub.SeatOf(body, 2);
        var organiser = club.Client(f, club.Organiser);

        Assert.Equal(HttpStatusCode.OK, (await organiser.PostAsync($"/api/v1/bookings/{bookingId}/players/{samSeat}/nudge", null)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await organiser.PostAsync($"/api/v1/bookings/{bookingId}/players/{samSeat}/nudge", null)).StatusCode);
        var third = await organiser.PostAsync($"/api/v1/bookings/{bookingId}/players/{samSeat}/nudge", null);
        Assert.Equal(HttpStatusCode.TooManyRequests, third.StatusCode);
        Assert.Equal(PlayerErrors.NudgeLimit, Error(await JsonAsync(third)));

        // The club's own reminders: none until a cadence has passed since the invite, then one per cadence, at most two.
        var worker = f.Services.GetRequiredService<ShareWorker>();
        async Task<int> RemindersAsync() => await PlayersClub.ReadAsync(f, db => db.MemberNotifications.IgnoreQueryFilters()
            .CountAsync(n => n.UserId == club.Sam && n.Kind == MemberEventCatalogue.Reminder && n.DedupeKey.StartsWith("reminder:")));
        var now = DateTimeOffset.UtcNow;
        await worker.TickAsync(now, default);
        Assert.Equal(0, await RemindersAsync());
        await worker.TickAsync(now.AddHours(25), default);
        await worker.TickAsync(now.AddHours(26), default);
        Assert.Equal(1, await RemindersAsync());
        await worker.TickAsync(now.AddHours(50), default);
        Assert.Equal(2, await RemindersAsync());
        // The deadline is at least 57 hours out (tomorrow's game ends, plus 48): still open, but the club has said it twice.
        await worker.TickAsync(now.AddHours(56), default);
        Assert.Equal(2, await RemindersAsync());
    }

    // ------------------------------------------------------------------ admin god mode

    [SkippableFact]
    public async Task An_admin_never_debits_a_partner_by_implication()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var (club, bookingId, body) = await GameAsync(f, "plgod");
        var samSeat = PlayersClub.SeatOf(body, 2);
        var admin = club.Client(f, club.Admin, admin: true);
        var path = $"/api/v1/admin/bookings/{bookingId}/players/{samSeat}";

        Assert.Equal(PlayerErrors.ReasonRequired, Error(await JsonAsync(await admin.PostAsJsonAsync($"{path}/accept", new { }))));
        Assert.Equal(HttpStatusCode.OK, (await admin.PostAsJsonAsync($"{path}/accept", new { reason = "Told the desk he is playing" })).StatusCode);
        Assert.Equal(ParticipantStatus.Accepted, (await club.SeatsAsync(f, bookingId)).Single(s => s.Id == samSeat).Status);
        Assert.Empty(await club.SharesAsync(f, bookingId));
        Assert.Equal(50m, await PlayersClub.BalanceAsync(f, club.Sam));

        // Collect only by name, with a reason — and then even below zero.
        await club.WriteAsync(f, db => db.LedgerEntries.Add(new LedgerEntry
        {
            TenantId = club.TenantId, UserId = club.Sam, Type = LedgerEntryType.AdminAdjustment, AmountCredits = -45m, ActorUserId = club.Admin,
        }));
        Assert.Equal(PlayerErrors.OverdraftNotAuthorised, Error(await JsonAsync(await admin.PostAsJsonAsync($"{path}/collect", new { reason = "Owed" }))));
        var collect = await admin.PostAsJsonAsync($"{path}/collect", new { reason = "Paid in cash, took it off the wallet", allowNegativeBalance = true });
        Assert.Equal(HttpStatusCode.OK, collect.StatusCode);
        Assert.Equal(5m - 16m, await PlayersClub.BalanceAsync(f, club.Sam));

        // Settled outside the app after all: what was collected in the app goes back.
        Assert.Equal(HttpStatusCode.OK, (await admin.PostAsJsonAsync($"{path}/settle-outside", new { reason = "Cash at the desk" })).StatusCode);
        Assert.Equal(5m, await PlayersClub.BalanceAsync(f, club.Sam));

        var actions = await PlayersClub.ReadAsync(f, db => db.AdminChangeLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == club.TenantId).Select(a => a.Action).ToListAsync());
        Assert.Contains(AdminChangeActions.BookingPlayerAcceptedOnBehalf, actions);
        Assert.Contains(AdminChangeActions.BookingShareCollected, actions);
        Assert.Contains(AdminChangeActions.BookingShareSettledOutside, actions);

        // A member cannot reach any of it.
        Assert.Equal(HttpStatusCode.Forbidden, (await club.Client(f, club.Sam).PostAsJsonAsync($"{path}/collect", new { reason = "x", allowNegativeBalance = true })).StatusCode);
    }

    [SkippableFact]
    public async Task An_admin_adds_and_removes_players_on_the_record()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var (club, bookingId, _) = await GameAsync(f, "plgodadd");
        var admin = club.Client(f, club.Admin, admin: true);

        var add = await admin.PostAsJsonAsync($"/api/v1/admin/bookings/{bookingId}/players", new { userId = club.Jo, reason = "Phoned in" });
        Assert.Equal(HttpStatusCode.OK, add.StatusCode);
        var jo = (await club.SeatsAsync(f, bookingId)).Single(s => s.UserId == club.Jo);
        Assert.Equal(club.Admin, jo.InvitedByUserId);

        Assert.Equal(PlayerErrors.ReasonRequired, Error(await JsonAsync(await admin.PostAsJsonAsync($"/api/v1/admin/bookings/{bookingId}/players/{jo.Id}/remove", new { }))));
        Assert.Equal(HttpStatusCode.OK, (await admin.PostAsJsonAsync($"/api/v1/admin/bookings/{bookingId}/players/{jo.Id}/remove", new { reason = "Changed his mind" })).StatusCode);

        var actions = await PlayersClub.ReadAsync(f, db => db.AdminChangeLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == club.TenantId).Select(a => a.Action).ToListAsync());
        Assert.Contains(AdminChangeActions.BookingPlayerAdded, actions);
        Assert.Contains(AdminChangeActions.BookingPlayerRemoved, actions);
    }

    // ------------------------------------------------------------------ preferences and settings

    [SkippableFact]
    public async Task Every_social_flag_is_off_until_the_member_turns_it_on()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "plprefs");
        var me = club.Client(f, club.Sam);

        var defaults = await JsonAsync(await me.GetAsync("/api/v1/me/preferences"));
        Assert.False(defaults.GetProperty("findable").GetBoolean());
        Assert.False(defaults.GetProperty("show_in_leaderboards").GetBoolean());
        Assert.False(defaults.GetProperty("share_results").GetBoolean());

        var saved = await JsonAsync(await me.PutAsJsonAsync("/api/v1/me/preferences",
            new Dictionary<string, object> { ["findable_in_directory"] = true, ["show_on_leaderboards"] = true, ["share_results"] = true }));
        Assert.True(saved.GetProperty("findable").GetBoolean());
        Assert.True(saved.GetProperty("show_in_leaderboards").GetBoolean());
        Assert.True(saved.GetProperty("share_results").GetBoolean());
    }

    [SkippableFact]
    public async Task The_players_settings_are_bounded_on_the_put_and_rendered_from_the_clamped_values()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "plsettings");
        var admin = club.Client(f, club.Admin, admin: true);

        var settings = await JsonAsync(await admin.GetAsync("/api/v1/admin/settings"));
        Assert.Equal(48, settings.GetProperty("share_lapse_hours").GetInt32());
        Assert.Equal(90, settings.GetProperty("recent_partner_days").GetInt32());

        var shown = await JsonAsync(await admin.GetAsync("/api/v1/admin/settings"));
        Dictionary<string, object?> Body(string key, int value) => new()
        {
            ["sliceMinutes"] = shown.GetProperty("slice_minutes").GetInt32(),
            ["slicePriceCredits"] = shown.GetProperty("slice_price_credits").GetDecimal(),
            ["advanceBookingDays"] = shown.GetProperty("advance_booking_days").GetInt32(),
            ["dayStartMinute"] = shown.GetProperty("day_start_minute").GetInt32(),
            ["dayEndMinute"] = shown.GetProperty("day_end_minute").GetInt32(),
            ["penaltyPct"] = shown.GetProperty("penalty_pct").GetDecimal(),
            ["graceWindowMinutes"] = shown.GetProperty("grace_window_minutes").GetInt32(),
            ["penaltyWindowMinutes"] = shown.GetProperty("penalty_window_minutes").GetInt32(),
            [key] = value,
        };

        foreach (var (key, value) in new (string, int)[]
                 {
                     ("share_lapse_hours", 0), ("share_lapse_hours", 169), ("share_reminder_hours", 5), ("share_reminder_max", 11),
                     ("player_nudge_limit", -1), ("directory_searches_per_minute", 4), ("member_quiet_start_minute", 1440),
                     ("member_quiet_end_minute", -1), ("recent_partner_days", 366), ("member_notification_retention_days", 6),
                 })
        {
            var response = await admin.PutAsJsonAsync("/api/v1/admin/settings", Body(key, value));
            Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
            Assert.Equal($"{key}_out_of_range", Error(await JsonAsync(response)));
        }

        var save = await admin.PutAsJsonAsync("/api/v1/admin/settings", Body("share_lapse_hours", 24));
        Assert.True(save.IsSuccessStatusCode, await save.Content.ReadAsStringAsync());
        Assert.Equal(24, (await JsonAsync(await admin.GetAsync("/api/v1/admin/settings"))).GetProperty("share_lapse_hours").GetInt32());
    }
}
