using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Services.Realtime;
using Microsoft.Extensions.DependencyInjection;
using static Crusaders.Mainframe.Tests.Play.PlayKit;

namespace Crusaders.Mainframe.Tests.Play;

/// <summary>
/// Play's notices (<c>docs/specs/play.md</c> §8): the kinds and who gets each, the one mailed kind
/// and its quiet hours, one mail per (booking, member) across edits and re-records, the mail itself,
/// and the unread frame.
/// </summary>
public sealed class PlayNotificationsHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private TestWebAppFactory CreateFactory() => new() { ConnectionString = pg.ConnectionString };

    [SkippableFact]
    public async Task A_record_asks_the_confirming_side_once_by_mail_and_the_mail_says_so()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var factory = CreateFactory();
        var mail = new CapturingMail();
        var f = CapturingMail.On(factory, mail);
        var club = await SeedAsync(f, "nt-record");
        var booking = await club.GameAsync(f, DateTimeOffset.UtcNow.AddHours(-2).Storable(), club.Organiser, [club.Sam, club.Alex, club.Jo]);
        var olive = club.Client(f, club.Organiser);
        var created = await (await RecordAsync(olive, booking, [U(club.Organiser), U(club.Sam)], [U(club.Alex), U(club.Jo)])).JsonAsync();

        foreach (var member in new[] { club.Alex, club.Jo })
        {
            var line = Assert.Single(await InboxAsync(f, member, MemberEventCatalogue.ResultToConfirm));
            Assert.StartsWith("Olive Organiser recorded Olive Organiser & Sam Partner 3–1 Alex Partner & Jo Partner (", line.Headline);
            Assert.EndsWith("). Is it right?", line.Headline);
            Assert.Equal($"/bookings/{booking}?result=confirm", line.Link);
            Assert.Single(await OutboxAsync(f, member, MemberEventCatalogue.ResultToConfirm));
        }
        Assert.Empty(await InboxAsync(f, club.Sam, MemberEventCatalogue.ResultToConfirm));
        Assert.Empty(await InboxAsync(f, club.Organiser, MemberEventCatalogue.ResultToConfirm));

        for (var i = 0; i < 50 && await PeopleClub.DeliverAdminNoticesAsync(f) > 0; i++) { }
        var sent = mail.Sent.Where(m => m.Subject.StartsWith("Is this result right?", StringComparison.Ordinal)).ToList();
        Assert.Equal(2, sent.Count);
        var alex = Assert.Single(sent, m => m.To.StartsWith("alex.partner@", StringComparison.Ordinal));
        Assert.Contains("on Court 1", alex.Subject);
        var text = MailText.Unwrap(alex.PlainBody);
        Assert.Contains("Olive Organiser & Sam Partner 3–1 Alex Partner & Jo Partner (11–7, 9–11, 11–5, 11–8)", text);
        Assert.Contains($"/bookings/{booking}?result=confirm", text);
        Assert.Contains("It will be confirmed automatically on", text);
        _ = created;
    }

    [SkippableFact]
    public async Task An_edit_or_a_re_record_writes_a_new_line_but_never_a_second_mail()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "nt-once");
        var booking = await club.GameAsync(f, DateTimeOffset.UtcNow.AddHours(-2).Storable(), club.Organiser, [club.Sam]);
        var olive = club.Client(f, club.Organiser);
        var v = (await (await RecordAsync(olive, booking, [U(club.Organiser)], [U(club.Sam)])).JsonAsync()).GetProperty("version").GetInt32();

        var edited = await olive.PutAsJsonAsync($"/api/v1/bookings/{booking}/result", new
        {
            expectedVersion = v, format = "best_of_3", sideA = new[] { U(club.Organiser) }, sideB = new[] { U(club.Sam) }, games = G((11, 2), (11, 3)),
        });
        Assert.True(edited.IsSuccessStatusCode);
        await ActAsync(olive, booking, "withdraw", v + 1);
        Assert.True((await RecordAsync(olive, booking, [U(club.Organiser)], [U(club.Sam)])).IsSuccessStatusCode);

        Assert.Equal(3, (await InboxAsync(f, club.Sam, MemberEventCatalogue.ResultToConfirm)).Count);
        Assert.Single(await OutboxAsync(f, club.Sam, MemberEventCatalogue.ResultToConfirm));
    }

    [SkippableFact]
    public async Task The_mail_waits_for_quiet_hours_and_the_inbox_line_does_not()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var minute = (DateTimeOffset.UtcNow.Hour * 60) + DateTimeOffset.UtcNow.Minute;
        var start = (minute + 1440 - 60) % 1440;
        var end = (minute + 120) % 1440;
        var club = await PlayersClub.SeedAsync(f, "nt-quiet", PlayersClub.Settings.Replace(
            "\"member_quiet_start_minute\":0,\"member_quiet_end_minute\":0",
            $"\"member_quiet_start_minute\":{start},\"member_quiet_end_minute\":{end}"));
        var booking = await club.GameAsync(f, DateTimeOffset.UtcNow.AddHours(-2).Storable(), club.Organiser, [club.Sam]);
        await RecordAsync(club.Client(f, club.Organiser), booking, [U(club.Organiser)], [U(club.Sam)]);

        Assert.Single(await InboxAsync(f, club.Sam, MemberEventCatalogue.ResultToConfirm));
        var queued = Assert.Single(await OutboxAsync(f, club.Sam, MemberEventCatalogue.ResultToConfirm));
        Assert.True(queued.DueAt > DateTimeOffset.UtcNow.AddMinutes(100), $"due {queued.DueAt:O}");
    }

    [SkippableFact]
    public async Task Confirmations_disputes_and_voids_are_inbox_lines_to_the_right_people_and_never_mail()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "nt-kinds");
        var olive = club.Client(f, club.Organiser);
        var sam = club.Client(f, club.Sam);

        var b1 = await club.GameAsync(f, DateTimeOffset.UtcNow.AddHours(-6).Storable(), club.Organiser, [club.Sam]);
        var r1 = await (await RecordAsync(olive, b1, [U(club.Organiser)], [U(club.Sam)])).JsonAsync();
        await ActAsync(sam, b1, "confirm", r1.GetProperty("version").GetInt32());
        var confirmed = Assert.Single(await InboxAsync(f, club.Organiser, MemberEventCatalogue.ResultConfirmed));
        Assert.StartsWith("Result confirmed: you won 3–1 (", confirmed.Headline);
        Assert.Empty(await InboxAsync(f, club.Sam, MemberEventCatalogue.ResultConfirmed));

        var b2 = await club.GameAsync(f, DateTimeOffset.UtcNow.AddHours(-3).Storable(), club.Organiser, [club.Sam]);
        var r2 = await (await RecordAsync(olive, b2, [U(club.Organiser)], [U(club.Sam)])).JsonAsync();
        await ActAsync(sam, b2, "dispute", r2.GetProperty("version").GetInt32(), "wrong");
        var disputed = Assert.Single(await InboxAsync(f, club.Organiser, MemberEventCatalogue.ResultDisputed));
        Assert.StartsWith("Sam Partner disputed the result of ", disputed.Headline);
        Assert.EndsWith(". The club will look at it.", disputed.Headline);

        await club.Client(f, club.Admin, admin: true).PostAsJsonAsync($"/api/v1/admin/play/results/{r2.GetProperty("result_id").GetGuid()}/void", new { reason = "no" });
        Assert.StartsWith("The club removed the result of ", Assert.Single(await InboxAsync(f, club.Sam, MemberEventCatalogue.ResultVoided)).Headline);
        Assert.Single(await InboxAsync(f, club.Organiser, MemberEventCatalogue.ResultVoided));

        foreach (var kind in new[] { MemberEventCatalogue.ResultConfirmed, MemberEventCatalogue.ResultDisputed, MemberEventCatalogue.ResultVoided, MemberEventCatalogue.BadgeEarned })
        {
            Assert.Empty(await OutboxAsync(f, club.Organiser, kind));
            Assert.Empty(await OutboxAsync(f, club.Sam, kind));
        }
    }

    [SkippableFact]
    public async Task The_confirming_members_open_app_is_told_its_inbox_changed()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "nt-frame");
        var booking = await club.GameAsync(f, DateTimeOffset.UtcNow.AddHours(-2).Storable(), club.Organiser, [club.Sam]);
        var bus = f.Services.GetRequiredService<IRealtimeBus>();
        var topic = RealtimeTopic.Wallet(club.TenantId, club.Sam);
        var channel = bus.Subscribe(topic);
        try
        {
            await RecordAsync(club.Client(f, club.Organiser), booking, [U(club.Organiser)], [U(club.Sam)]);
            var frames = new List<RealtimeMessage>();
            while (channel.Reader.TryRead(out var frame)) frames.Add(frame);
            var notice = frames.First(m => m.Event == MemberNotices.NotificationEvent);
            Assert.True(JsonDocument.Parse(notice.JsonPayload).RootElement.GetProperty("unread_count").GetInt32() >= 1);
        }
        finally
        {
            bus.Unsubscribe(topic, channel);
        }
    }
}
