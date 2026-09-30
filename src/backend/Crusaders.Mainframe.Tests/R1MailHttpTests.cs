using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Services;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 1, the mail half of lane B: a share received said "added to your balance" with
/// no word that it is held (B12); a share the CLUB collected told the partner "You paid your
/// share" and nothing about going below zero, and being added to a game or accepted into one by
/// the club was told to nobody (B8); the booking mail told members to use a PIN they were never
/// given (B13).
/// </summary>
public sealed class R1MailHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private static async Task DeliverAsync(WebApplicationFactory<Program> f, PlayersClub club)
    {
        for (var i = 0; i < 200; i++)
        {
            var pending = await PlayersClub.ReadAsync(f, db => db.AdminNotifications.IgnoreQueryFilters()
                .CountAsync(n => n.TenantId == club.TenantId && n.State == AdminNotificationState.Pending));
            if (pending == 0) return;
            await PeopleClub.DeliverAdminNoticesAsync(f);
        }
    }

    private static List<EmailMessage> To(CapturingMail mail, PlayersClub club, string handle) =>
        [.. mail.Sent.Where(m => m.To.StartsWith($"{handle}@{club.Slug}.review.test", StringComparison.Ordinal))];

    /// <summary>The plain part with its wrapping undone — prose is matched against a flowed text part otherwise (memory/gotchas.md).</summary>
    private static string Body(EmailMessage m) => System.Text.RegularExpressions.Regex.Replace(m.PlainBody ?? m.HtmlBody, @"\s+", " ");

    [SkippableFact]
    public async Task A_share_received_says_it_is_held_and_until_when()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var factory = pg.SharedHost;
        var mail = new CapturingMail();
        var f = CapturingMail.On(factory, mail);
        var club = await PlayersClub.SeedAsync(f, "r1held");
        await club.CreditAsync(f, club.Organiser, 100m);
        await club.CreditAsync(f, club.Sam, 100m);
        var (bookingId, body) = await club.BookWithPlayersAsync(f, [new { userId = club.Sam }]);
        var seat = PlayersClub.SeatOf(body, 2);
        var shown = (await club.SeatsAsync(f, bookingId)).Single(s => s.Id == seat).ShareCredits;
        Assert.True((await club.Client(f, club.Sam).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players/{seat}/accept", new { expectedShareCredits = shown })).IsSuccessStatusCode);
        await DeliverAsync(f, club);

        var received = Assert.Single(To(mail, club, "olive.organiser"), m => m.Subject.Contains("paid their share", StringComparison.Ordinal));
        Assert.Contains("Held until", Body(received));
        Assert.Contains("in case a share has to go back", Body(received));
        var deadline = await PlayersClub.ReadAsync(f, db => db.Bookings.IgnoreQueryFilters().Where(b => b.Id == bookingId).Select(b => b.ShareDeadlineAt).FirstAsync());
        Assert.Contains(deadline!.Value.ToUniversalTime().ToString(ClubDate.Format, System.Globalization.CultureInfo.InvariantCulture), Body(received));

        // The partner's side is a plain receipt: nothing of theirs is held.
        var paid = Assert.Single(To(mail, club, "sam.partner"), m => m.Subject.StartsWith("Share paid", StringComparison.Ordinal));
        Assert.DoesNotContain("Held until", Body(paid));
    }

    [SkippableFact]
    public async Task The_club_accepting_and_collecting_for_a_member_is_told_to_them_as_the_clubs_doing()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var factory = pg.SharedHost;
        var mail = new CapturingMail();
        var f = CapturingMail.On(factory, mail);
        var club = await PlayersClub.SeedAsync(f, "r1clubdid");
        await club.CreditAsync(f, club.Organiser, 100m);
        var (bookingId, body) = await club.BookWithPlayersAsync(f, [new { userId = club.Sam }]);
        var seat = PlayersClub.SeatOf(body, 2);
        var admin = club.Client(f, club.Admin, admin: true);
        await DeliverAsync(f, club);
        mail.Sent.Clear();

        var accepted = await admin.PostAsJsonAsync($"/api/v1/admin/bookings/{bookingId}/players/{seat}/accept", new { reason = "Told us at the desk" });
        Assert.True(accepted.IsSuccessStatusCode, await accepted.Content.ReadAsStringAsync());
        var collected = await admin.PostAsJsonAsync($"/api/v1/admin/bookings/{bookingId}/players/{seat}/collect",
            new { reason = "Plays tonight, pays later", allowNegativeBalance = true });
        Assert.True(collected.IsSuccessStatusCode, await collected.Content.ReadAsStringAsync());
        await DeliverAsync(f, club);

        var sam = To(mail, club, "sam.partner");
        var inGame = Assert.Single(sam, m => m.Subject.StartsWith("The club put you in", StringComparison.Ordinal));
        Assert.Contains("until you accept it yourself", Body(inGame));
        var taken = Assert.Single(sam, m => m.Subject.StartsWith("The club collected your share", StringComparison.Ordinal));
        Assert.Contains("The club collected", Body(taken));
        Assert.Contains("below zero", Body(taken));
        Assert.DoesNotContain(sam, m => m.Subject.StartsWith("Share paid", StringComparison.Ordinal));

        var olive = Assert.Single(To(mail, club, "olive.organiser"), m => m.Subject.Contains("paid their share", StringComparison.Ordinal));
        Assert.Contains("The club collected", Body(olive));

        // The inbox says it too.
        var inbox = await club.Client(f, club.Sam).GetFromJsonAsync<JsonElement>("/api/v1/me/notifications");
        var kinds = inbox.GetProperty("items").EnumerateArray().Select(i => i.GetProperty("kind").GetString()).ToList();
        Assert.Contains(MemberEventCatalogue.ClubSeat, kinds);
    }

    [SkippableFact]
    public async Task A_member_the_club_adds_to_a_game_is_told_the_club_did_it()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var factory = pg.SharedHost;
        var mail = new CapturingMail();
        var f = CapturingMail.On(factory, mail);
        var club = await PlayersClub.SeedAsync(f, "r1clubadd");
        await club.CreditAsync(f, club.Organiser, 100m);
        var (bookingId, _) = await club.BookWithPlayersAsync(f, []);
        var admin = club.Client(f, club.Admin, admin: true);

        Assert.True((await admin.PostAsJsonAsync($"/api/v1/admin/bookings/{bookingId}/players", new { userId = club.Jo, reason = "Asked at the bar" })).IsSuccessStatusCode);
        Assert.True((await admin.PostAsJsonAsync($"/api/v1/admin/bookings/{bookingId}/players", new { userId = club.Alex, accepted = true, reason = "Playing tonight" })).IsSuccessStatusCode);
        await DeliverAsync(f, club);

        var jo = Assert.Single(To(mail, club, "jo.partner"));
        Assert.StartsWith("The club added you to Olive Organiser's game", jo.Subject);
        Assert.Contains("/invites/", Body(jo));
        var alex = Assert.Single(To(mail, club, "alex.partner"));
        Assert.StartsWith("The club put you in Olive Organiser's game", alex.Subject);
        Assert.Equal(ParticipantStatus.Accepted, (await club.SeatsAsync(f, bookingId)).Single(s => s.UserId == club.Alex).Status);
    }

    [SkippableFact]
    public async Task The_booking_mail_names_the_member_code_and_no_pin()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var factory = pg.SharedHost;
        var mail = new CapturingMail();
        var f = CapturingMail.On(factory, mail);
        var club = await PlayersClub.SeedAsync(f, "r1codeonly");
        await club.CreditAsync(f, club.Organiser, 100m);
        await club.BookWithPlayersAsync(f, []);

        EmailMessage? confirmation = null;
        for (var i = 0; i < 100 && confirmation is null; i++)
        {
            confirmation = To(mail, club, "olive.organiser").FirstOrDefault();
            if (confirmation is null) await Task.Delay(50);
        }
        Assert.NotNull(confirmation);
        Assert.DoesNotContain("your PIN", Body(confirmation!));
        Assert.DoesNotContain("PIN or", Body(confirmation!));
        Assert.Contains("member code", Body(confirmation!));
    }

    /// <summary>
    /// Lane F4: mails and new ledger comments print the club's date words — "Thu 1 Oct, 08:00" —
    /// never "Thu 01 Oct". Both the players mails (GameText) and the play mails (PlayNotices) go
    /// through one format.
    /// </summary>
    [Fact]
    public void Mail_dates_read_the_way_the_screens_do()
    {
        var settings = new TenantSettingsView(15, 8m, 30m, 5, 15, 14, "UTC", 1.6m, 100m, 1000m, 60, "16:00-19:00", 1, 2, 0, 1440, 7, ButtonMap.Default());
        var first = new DateTimeOffset(2026, 10, 1, 8, 0, 0, TimeSpan.Zero);
        Assert.Equal("Thu 1 Oct, 08:00", GameText.Local(first, settings));
        Assert.Equal("Thu 1 Oct, 08:00", PlayNotices.Local(first, settings));
        Assert.Equal("Tue 29 Sep, 08:00", GameText.Local(first.AddDays(-2), settings));
    }
}
