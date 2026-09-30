using System.Net;
using System.Net.Http.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Services;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using static Crusaders.Mainframe.Tests.Play.PlayKit;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 2, C8: member mail held by quiet hours is re-derived from CURRENT state when it is
/// released — dropped if obsolete, re-rendered otherwise, coalesced per (member, booking, kind),
/// in the order the events happened. Each of the reviewer's three stale mails is reproduced here
/// through the real endpoints: a confirm link for a withdrawn 3–0, an invite to a game cancelled
/// before morning, and "your share is now 16.00" beside the share that replaced it.
/// </summary>
public sealed class R2MailReleaseHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private TestWebAppFactory CreateFactory() => new() { ConnectionString = pg.ConnectionString };

    /// <summary>A players club whose quiet hours started an hour ago and end two hours from now.</summary>
    private static Task<PlayersClub> QuietClubAsync(WebApplicationFactory<Program> f, string prefix)
    {
        var minute = (DateTimeOffset.UtcNow.Hour * 60) + DateTimeOffset.UtcNow.Minute;
        var start = (minute + 1440 - 60) % 1440;
        var end = (minute + 120) % 1440;
        return PlayersClub.SeedAsync(f, prefix, PlayersClub.Settings.Replace(
            "\"member_quiet_start_minute\":0,\"member_quiet_end_minute\":0",
            $"\"member_quiet_start_minute\":{start},\"member_quiet_end_minute\":{end}"));
    }

    private static Task<List<AdminNotification>> MemberOutboxAsync(WebApplicationFactory<Program> f, PlayersClub club, Guid userId) =>
        PlayersClub.ReadAsync(f, db => db.AdminNotifications.IgnoreQueryFilters()
            .Where(n => n.TenantId == club.TenantId && n.Audience == NotificationAudience.Member && n.RecipientUserId == userId)
            .OrderBy(n => n.CreatedAt).ToListAsync());

    /// <summary>The instant quiet hours end — when everything they held falls due.</summary>
    private static async Task<DateTimeOffset> ReleaseAtAsync(WebApplicationFactory<Program> f, PlayersClub club)
    {
        var held = await PlayersClub.ReadAsync(f, db => db.AdminNotifications.IgnoreQueryFilters()
            .Where(n => n.TenantId == club.TenantId && n.Audience == NotificationAudience.Member && n.State == AdminNotificationState.Pending)
            .MaxAsync(n => (DateTimeOffset?)n.DueAt));
        Assert.True(held > DateTimeOffset.UtcNow.AddMinutes(100), $"nothing held by quiet hours (due {held:O})");
        return held!.Value;
    }

    private static async Task DeliverAsync(WebApplicationFactory<Program> f, DateTimeOffset at)
    {
        for (var i = 0; i < 50 && await PeopleClub.DeliverAdminNoticesAsync(f, at) > 0; i++) { }
    }

    private static List<EmailMessage> To(CapturingMail mail, string handle) =>
        mail.Sent.Where(m => m.To.StartsWith(handle + "@", StringComparison.Ordinal)).ToList();

    // ------------------------------------------------------------------ the result ask

    [SkippableFact]
    public async Task A_held_confirm_mail_for_a_withdrawn_result_is_dropped()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var factory = CreateFactory();
        var mail = new CapturingMail();
        var f = CapturingMail.On(factory, mail);
        var club = await QuietClubAsync(f, "r2rel-wd");
        var booking = await club.GameAsync(f, DateTimeOffset.UtcNow.AddHours(-2).Storable(), club.Organiser, [club.Sam]);
        var olive = club.Client(f, club.Organiser);
        var v = (await (await RecordAsync(olive, booking, [U(club.Organiser)], [U(club.Sam)], G((11, 1), (11, 2), (11, 3)))).JsonAsync())
            .GetProperty("version").GetInt32();
        var release = await ReleaseAtAsync(f, club);
        Assert.True((await ActAsync(olive, booking, "withdraw", v)).IsSuccessStatusCode);

        await DeliverAsync(f, release);

        Assert.Empty(To(mail, "sam.partner"));
        var row = Assert.Single(await MemberOutboxAsync(f, club, club.Sam));
        Assert.Equal(AdminNotificationState.Suppressed, row.State);
        Assert.Equal($"dropped: {MemberMailRelease.ResultNotPending}", row.LastError);
    }

    [SkippableFact]
    public async Task A_held_confirm_mail_shows_the_result_recorded_after_the_one_it_was_staged_for()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var factory = CreateFactory();
        var mail = new CapturingMail();
        var f = CapturingMail.On(factory, mail);
        var club = await QuietClubAsync(f, "r2rel-rr");
        var booking = await club.GameAsync(f, DateTimeOffset.UtcNow.AddHours(-2).Storable(), club.Organiser, [club.Sam]);
        var olive = club.Client(f, club.Organiser);
        var v = (await (await RecordAsync(olive, booking, [U(club.Organiser)], [U(club.Sam)], G((11, 1), (11, 2), (11, 3)))).JsonAsync())
            .GetProperty("version").GetInt32();
        var release = await ReleaseAtAsync(f, club);
        Assert.True((await ActAsync(olive, booking, "withdraw", v)).IsSuccessStatusCode);
        Assert.True((await RecordAsync(olive, booking, [U(club.Organiser)], [U(club.Sam)])).IsSuccessStatusCode);

        await DeliverAsync(f, release);

        var sent = Assert.Single(To(mail, "sam.partner"));
        var text = MailText.Unwrap(sent.PlainBody);
        Assert.Contains("Olive Organiser 3–1 Sam Partner (11–7, 9–11, 11–5, 11–8)", text);
        Assert.DoesNotContain("11–1", text);
    }

    /// <summary>
    /// A dropped ask frees its one-mail-per-(booking, member) key: a result recorded afresh after
    /// the release is mailed, rather than silently never asked because a mail that never left
    /// "used up" the booking.
    /// </summary>
    [SkippableFact]
    public async Task A_result_recorded_after_a_dropped_ask_is_still_mailed()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var factory = CreateFactory();
        var mail = new CapturingMail();
        var f = CapturingMail.On(factory, mail);
        var club = await QuietClubAsync(f, "r2rel-again");
        var booking = await club.GameAsync(f, DateTimeOffset.UtcNow.AddHours(-2).Storable(), club.Organiser, [club.Sam]);
        var olive = club.Client(f, club.Organiser);
        var v = (await (await RecordAsync(olive, booking, [U(club.Organiser)], [U(club.Sam)], G((11, 1), (11, 2), (11, 3)))).JsonAsync())
            .GetProperty("version").GetInt32();
        var release = await ReleaseAtAsync(f, club);
        Assert.True((await ActAsync(olive, booking, "withdraw", v)).IsSuccessStatusCode);
        await DeliverAsync(f, release);
        Assert.Empty(To(mail, "sam.partner"));

        Assert.True((await RecordAsync(olive, booking, [U(club.Organiser)], [U(club.Sam)])).IsSuccessStatusCode);
        await DeliverAsync(f, await ReleaseAtAsync(f, club));

        var sent = Assert.Single(To(mail, "sam.partner"));
        Assert.Contains("3–1", MailText.Unwrap(sent.PlainBody));
    }

    // ------------------------------------------------------------------ the invite

    [SkippableFact]
    public async Task A_held_invite_to_a_game_cancelled_before_morning_is_dropped_and_the_cancellation_goes_at_once()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var factory = CreateFactory();
        var mail = new CapturingMail();
        var f = CapturingMail.On(factory, mail);
        var club = await QuietClubAsync(f, "r2rel-cx");
        await club.CreditAsync(f, club.Organiser, 100m);
        var (bookingId, _) = await club.BookWithPlayersAsync(f, [new { userId = club.Sam }]);
        var release = await ReleaseAtAsync(f, club);

        var cancel = await club.Client(f, club.Organiser).PostAsync($"/api/v1/bookings/{bookingId}/cancel", null);
        Assert.Equal(HttpStatusCode.OK, cancel.StatusCode);
        await DeliverAsync(f, DateTimeOffset.UtcNow);
        var atOnce = Assert.Single(To(mail, "sam.partner"));
        Assert.StartsWith("Game cancelled", atOnce.Subject);

        await DeliverAsync(f, release);

        Assert.Single(To(mail, "sam.partner"));
        var invite = Assert.Single(await MemberOutboxAsync(f, club, club.Sam), n => n.Kind == MemberEventCatalogue.Invited);
        Assert.Equal(AdminNotificationState.Suppressed, invite.State);
        Assert.Equal($"dropped: {MemberMailRelease.GameOff}", invite.LastError);
    }

    [SkippableFact]
    public async Task A_held_invite_that_was_declined_before_morning_is_dropped()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var factory = CreateFactory();
        var mail = new CapturingMail();
        var f = CapturingMail.On(factory, mail);
        var club = await QuietClubAsync(f, "r2rel-dec");
        await club.CreditAsync(f, club.Organiser, 100m);
        var (bookingId, body) = await club.BookWithPlayersAsync(f, [new { userId = club.Sam }]);
        var release = await ReleaseAtAsync(f, club);
        var decline = await club.Client(f, club.Sam)
            .PostAsync($"/api/v1/bookings/{bookingId}/players/{PlayersClub.SeatOf(body, 2)}/decline", null);
        Assert.True(decline.IsSuccessStatusCode, await decline.Content.ReadAsStringAsync());

        await DeliverAsync(f, release);

        Assert.Empty(To(mail, "sam.partner"));
        Assert.Equal($"dropped: {MemberMailRelease.InviteClosed}",
            Assert.Single(await MemberOutboxAsync(f, club, club.Sam), n => n.Kind == MemberEventCatalogue.Invited).LastError);
    }

    // ------------------------------------------------------------------ the share figure

    /// <summary>
    /// Two re-splits in the night: the partner hears ONE "your share has changed", with the share
    /// as it is at release — and the invite that went before it (order kept) quotes that share
    /// too, not the one it was staged with.
    /// </summary>
    [SkippableFact]
    public async Task Two_held_share_changes_become_one_mail_with_the_share_as_it_is_at_release()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var factory = CreateFactory();
        var mail = new CapturingMail();
        var f = CapturingMail.On(factory, mail);
        var club = await QuietClubAsync(f, "r2rel-split");
        await club.CreditAsync(f, club.Organiser, 100m);
        var (bookingId, body) = await club.BookWithPlayersAsync(f, [new { userId = club.Sam }, new { userId = club.Alex }]);
        var sam = PlayersClub.SeatOf(body, 2);
        var organiser = club.Client(f, club.Organiser);
        foreach (var amount in new[] { 16m, 4m })
        {
            var split = await organiser.PutAsJsonAsync($"/api/v1/bookings/{bookingId}/split",
                new { mode = "amount", seats = new[] { new { participantId = sam, amount } } });
            Assert.Equal(HttpStatusCode.OK, split.StatusCode);
            await Task.Delay(5); // two saves, two instants — the later is the one kept
        }
        Assert.Equal(2, (await MemberOutboxAsync(f, club, club.Sam)).Count(n => n.Kind == MemberEventCatalogue.GameChanged));

        await DeliverAsync(f, await ReleaseAtAsync(f, club));

        var sent = To(mail, "sam.partner");
        Assert.Equal(2, sent.Count);
        Assert.Contains("invited you to play", sent[0].Subject);
        Assert.StartsWith("Your share has changed", sent[1].Subject);
        var four = MoneyFormat.Credits(4m);
        Assert.Contains(four, MailText.Unwrap(sent[0].PlainBody));
        Assert.Contains($"Your share now: {four}", MailText.Unwrap(sent[1].PlainBody).Replace("\n", " "));
        Assert.DoesNotContain(MoneyFormat.Credits(16m), string.Join(" ", sent.Select(m => MailText.Unwrap(m.PlainBody))));
        var changes = (await MemberOutboxAsync(f, club, club.Sam)).Where(n => n.Kind == MemberEventCatalogue.GameChanged).ToList();
        Assert.Equal($"dropped: {MemberMailRelease.Superseded}", changes[0].LastError);
        Assert.Equal(AdminNotificationState.Sent, changes[1].State);
    }

    /// <summary>
    /// Everything quiet hours held falls due at one instant; it leaves in the order it happened.
    /// Five invites to five games, one after another: the member reads them in that order.
    /// </summary>
    [SkippableFact]
    public async Task A_night_of_held_mail_is_released_in_the_order_it_happened()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var factory = CreateFactory();
        var mail = new CapturingMail();
        var f = CapturingMail.On(factory, mail);
        var club = await QuietClubAsync(f, "r2rel-order");
        await club.CreditAsync(f, club.Organiser, 500m);
        var hours = new[] { 8, 9, 10, 11, 12 };
        foreach (var hour in hours)
        {
            await club.BookWithPlayersAsync(f, [new { userId = club.Sam }], at: PlayersClub.Tomorrow(hour).AddDays(hour - 8));
            await Task.Delay(5);
        }

        await DeliverAsync(f, await ReleaseAtAsync(f, club));

        var sent = To(mail, "sam.partner");
        Assert.Equal(hours.Length, sent.Count);
        Assert.Equal(hours.Select(h => $"{h:00}:00").ToList(), sent.Select(m => HourIn(MailText.Unwrap(m.PlainBody))).ToList());
    }

    private static string HourIn(string text) => System.Text.RegularExpressions.Regex.Match(text, @"\d\d:\d\d").Value;

    // ------------------------------------------------------------------ the smaller kinds, staged directly

    [SkippableFact]
    public async Task A_held_reminder_for_a_share_since_paid_and_a_waiting_return_since_posted_are_dropped()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var factory = CreateFactory();
        var mail = new CapturingMail();
        var f = CapturingMail.On(factory, mail);
        var club = await QuietClubAsync(f, "r2rel-paid");
        await club.CreditAsync(f, club.Organiser, 100m);
        await club.CreditAsync(f, club.Sam, 100m);
        var (bookingId, body) = await club.BookWithPlayersAsync(f, [new { userId = club.Sam }]);
        var seat = PlayersClub.SeatOf(body, 2);
        var accept = await club.Client(f, club.Sam).PostAsJsonAsync(
            $"/api/v1/bookings/{bookingId}/players/{seat}/accept", new { expectedShareCredits = 16m });
        Assert.True(accept.IsSuccessStatusCode, await accept.Content.ReadAsStringAsync());

        await club.InClubAsync(f, async sp =>
        {
            var db = sp.GetRequiredService<Api.Persistence.MainframeDbContext>();
            var settings = await sp.GetRequiredService<TenantSettingsAccessor>().GetAsync(default);
            var booking = await db.Bookings.FirstAsync(b => b.Id == bookingId);
            var row = await db.BookingParticipants.FirstAsync(p => p.Id == seat);
            MemberNotices.Stage(db, club.TenantId, await PlayerNotices.ReminderAsync(db, booking, row, settings, new ReminderKey(true, "r2-reminder"), default), settings);
            MemberNotices.Stage(db, club.TenantId, new MemberNotice(club.Sam, MemberEventCatalogue.ReturnWaiting, "r2-return",
                new ReturnWaitingPayload(bookingId, "Olive", "Court 1", "Thu 1 Oct, 08:00", 4m, false, seat), "waiting", null, bookingId), settings);
            return await db.SaveChangesAsync();
        });

        await DeliverAsync(f, await ReleaseAtAsync(f, club));

        Assert.DoesNotContain(To(mail, "sam.partner"), m => m.Subject.Contains("waiting for your answer") || m.Subject.Contains("on its way back"));
        var rows = await MemberOutboxAsync(f, club, club.Sam);
        Assert.Equal($"dropped: {MemberMailRelease.SharePaid}", Assert.Single(rows, n => n.Kind == MemberEventCatalogue.Reminder).LastError);
        Assert.Equal($"dropped: {MemberMailRelease.ReturnPosted}", Assert.Single(rows, n => n.Kind == MemberEventCatalogue.ReturnWaiting).LastError);
    }

    /// <summary>
    /// The rule has two sides: a mail that is still true still goes. A held invite whose game is
    /// on and whose seat is still open is sent — and a receipt (an urgent kind) is never judged.
    /// </summary>
    [SkippableFact]
    public async Task A_held_invite_that_is_still_open_is_sent_at_release()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var factory = CreateFactory();
        var mail = new CapturingMail();
        var f = CapturingMail.On(factory, mail);
        var club = await QuietClubAsync(f, "r2rel-open");
        await club.CreditAsync(f, club.Organiser, 100m);
        await club.BookWithPlayersAsync(f, [new { userId = club.Sam }]);
        var release = await ReleaseAtAsync(f, club);

        await DeliverAsync(f, release.AddMinutes(-1));
        Assert.Empty(To(mail, "sam.partner"));
        await DeliverAsync(f, release);

        var invite = Assert.Single(To(mail, "sam.partner"));
        Assert.Contains("invited you to play", invite.Subject);
        Assert.Contains(MoneyFormat.Credits(16m), MailText.Unwrap(invite.PlainBody));
    }
}
