using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Webhooks;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 9, E9-2 / E9-4: a booking the sweep refunded in full because its court box was
/// offline, then reversed when the box's queued check-in arrived. It was told as a no-show on
/// every surface — "No-show refund reversed" on the wallet, "The club took a no-show back" on the
/// Night, a mail saying "marked as a no-show" with "No-show penalty returned: 0 minutes" — and the
/// partner whose share was taken again got a plain "You paid your share". Postgres because the
/// share pair, the outage index and the Night are all read off the real tables.
/// </summary>
public sealed class R9OutageReversalHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private sealed record Rig(PlayersClub Club, WebApplicationFactory<Program> App, CapturingMail Mail, Guid BookingId, DateTimeOffset Start);

    /// <summary>
    /// Olive's 32-minute court, started ten minutes ago, split with Sam (16 each); when
    /// <paramref name="dark"/> the court's only box has been silent for a day, so the sweep
    /// refunds it in full (an outage), else it is an ordinary no-show.
    /// </summary>
    private async Task<Rig> SweptAsync(string prefix, bool dark)
    {
        var mail = new CapturingMail();
        var app = CapturingMail.On(pg.SharedHost, mail);
        var club = await PlayersClub.SeedAsync(app, prefix);
        if (dark)
        {
            await club.WriteAsync(app, db => db.Devices.Add(new Device
            {
                TenantId = club.TenantId, DeviceCode = $"box-{prefix}", Name = "Box", Kind = DeviceKind.CourtBox,
                MacAddress = Guid.NewGuid().ToString("N")[..12], CourtNumbers = [1], AutoRegistered = false,
                CreatedAt = DateTimeOffset.UtcNow.AddDays(-3), LastSeenAt = DateTimeOffset.UtcNow.AddDays(-1),
            }));
        }
        await club.CreditAsync(app, club.Sam, 50);
        var start = DateTimeOffset.UtcNow.AddMinutes(-10).Storable();
        var bookingId = await club.InsertBookingAsync(app, start);
        await club.CreditAsync(app, club.Organiser, 32);

        var added = await club.Client(app, club.Organiser).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players",
            new { players = new object[] { new { userId = club.Sam } } });
        added.EnsureSuccessStatusCode();
        var seat = (await added.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("participants")[0].GetProperty("participant_id").GetGuid();
        var shown = (await club.SeatsAsync(app, bookingId)).Single(s => s.Id == seat).ShareMinutes;
        (await club.Client(app, club.Sam).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players/{seat}/accept",
            new { expectedShareMinutes = shown })).EnsureSuccessStatusCode();

        await new NoShowWorker(app.Services, app.Services.GetRequiredService<IEventBus>(), NullLogger<NoShowWorker>.Instance)
            .TickAsync(DateTimeOffset.UtcNow, default);
        var swept = await PlayersClub.ReadAsync(app, db => db.Bookings.IgnoreQueryFilters().FirstAsync(b => b.Id == bookingId));
        Assert.Equal(BookingStatus.NoShow, swept.Status);
        Assert.Equal(dark, swept.OutageRefundedAt is not null);
        return new Rig(club, app, mail, bookingId, start);
    }

    /// <summary>The box's queued scan arrives: Olive checked in two minutes into the slot.</summary>
    private static async Task<DateTimeOffset> ReverseAsync(Rig r)
    {
        var scannedAt = r.Start.AddMinutes(2).Storable();
        r.Mail.Sent.Clear();
        var result = await r.Club.InClubAsync(r.App, async sp =>
        {
            var row = await sp.GetRequiredService<MainframeDbContext>().Bookings.FirstAsync(b => b.Id == r.BookingId);
            return await sp.GetRequiredService<BookingService>().ReverseNoShowAsync(
                row, scannedAt, Guid.Empty, default, scan: new ReversalScan(r.Club.Organiser, "member_code"));
        });
        Assert.IsType<NoShowReversalResult.Ok>(result);
        await r.App.Services.GetRequiredService<ShareHook>().AfterSettlementAsync(r.Club.TenantId, r.Club.Slug, [r.BookingId], default);
        return scannedAt;
    }

    private static async Task<List<JsonElement>> NightAsync(Rig r, Guid user, DateTimeOffset day)
    {
        var body = await r.Club.Client(r.App, r.Club.Admin, admin: true)
            .GetFromJsonAsync<JsonElement>($"/api/v1/admin/members/{user}/trace?day={day:yyyy-MM-dd}");
        return body.GetProperty("events").EnumerateArray().ToList();
    }

    private static Task<List<LedgerEntry>> ReversalRowsAsync(Rig r) =>
        PlayersClub.ReadAsync(r.App, db => db.LedgerEntries.IgnoreQueryFilters()
            .Where(l => l.RelatedBookingId == r.BookingId && l.ExternalReference != null && l.ExternalReference.StartsWith("noshow-reversal"))
            .ToListAsync());

    [SkippableFact]
    public async Task An_outage_refund_reversed_by_a_late_check_in_is_told_as_an_outage_refund_everywhere()
    {
        Skip.IfNot(pg.Available, Skipped);
        var r = await SweptAsync("r9outrev", dark: true);
        await using var owned = r.App;
        Assert.Equal(50, await PlayersClub.BalanceAsync(r.App, r.Club.Sam));   // the share came back in full
        var scannedAt = await ReverseAsync(r);

        // The money is unchanged by this fix: the court was played, so the share is taken again.
        Assert.Equal(50 - 16, await PlayersClub.BalanceAsync(r.App, r.Club.Sam));

        // Wallet / ledger: the reversal names the outage refund, never a no-show.
        var reversal = Assert.Single(await ReversalRowsAsync(r));
        Assert.DoesNotContain("no-show", reversal.Reason, StringComparison.OrdinalIgnoreCase);
        Assert.Equal("Outage refund reversed — you were checked in after all", reversal.Reason);

        // The organiser's mail: its own words, no no-show, no zero-minute penalty line.
        var olive = Assert.Single(r.Mail.Sent, m => m.Subject.Contains("Court 1", StringComparison.Ordinal) && m.Subject.Contains("refund", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain("no-show", olive.Subject + olive.HtmlBody + olive.PlainBody, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("penalty", olive.HtmlBody + olive.PlainBody, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("offline", olive.PlainBody, StringComparison.Ordinal);

        // The Night: the reversal row says what it was, and the check-in is at the scan, not the upload.
        var night = await NightAsync(r, r.Club.Organiser, scannedAt);
        var taken = Assert.Single(night, e => e.GetProperty("kind").GetString() == TraceKinds.BookingNoShowReversed);
        var headline = taken.GetProperty("headline").GetString()!;
        Assert.DoesNotContain("no-show", headline, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("outage refund", headline, StringComparison.Ordinal);
        var checkedIn = Assert.Single(night, e => e.GetProperty("kind").GetString() == TraceKinds.CourtCheckedIn);
        Assert.Equal(scannedAt, checkedIn.GetProperty("at").GetDateTimeOffset());

        // The partner's receipt says why the share was taken again.
        var samLine = await PlayersClub.ReadAsync(r.App, db => db.AdminNotifications.IgnoreQueryFilters()
            .Where(n => n.RecipientUserId == r.Club.Sam && n.Kind == MemberEventCatalogue.ShareMoved)
            .OrderByDescending(n => n.CreatedAt).FirstAsync());
        Assert.Contains("attended", samLine.Headline, StringComparison.Ordinal);
        Assert.True(JsonDocument.Parse(samLine.PayloadJson).RootElement.GetProperty("after_attendance").GetBoolean());
    }

    /// <summary>The genuine no-show keeps its words: the reversal of a real verdict is still a no-show's.</summary>
    [SkippableFact]
    public async Task A_genuine_no_show_reversed_keeps_the_no_show_words()
    {
        Skip.IfNot(pg.Available, Skipped);
        var r = await SweptAsync("r9nsrev", dark: false);
        await using var owned = r.App;
        var scannedAt = await ReverseAsync(r);

        Assert.All(await ReversalRowsAsync(r), l => Assert.StartsWith("No-show", l.Reason, StringComparison.Ordinal));
        Assert.Contains(r.Mail.Sent, m => m.Subject.StartsWith("No-show reversed", StringComparison.Ordinal));
        var night = await NightAsync(r, r.Club.Organiser, scannedAt);
        Assert.Equal("The club took a no-show back",
            Assert.Single(night, e => e.GetProperty("kind").GetString() == TraceKinds.BookingNoShowReversed).GetProperty("headline").GetString());
    }

    /// <summary>The two mails' own words: the outage reversal names no no-show and no penalty; the partner is told why.</summary>
    [Fact]
    public void The_reversal_mails_say_what_happened()
    {
        var olive = EmailTemplates.OutageRefundReversed(EmailCatalogue.Riverside, "o@x.test", "Court 2", 32);
        Assert.Equal("Outage refund reversed — Court 2", olive.Subject);
        Assert.Contains("32 minutes", olive.PlainBody, StringComparison.Ordinal);
        Assert.DoesNotContain("0 minutes", olive.PlainBody, StringComparison.Ordinal);

        var sam = EmailTemplates.ShareMoved(EmailCatalogue.Riverside, "s@x.test",
            new ShareMovement(ShareDirection.Paid, "Olive Organiser", "Court 2", "Sat 3 Oct, 10:00", 16, "https://x.test/b") { AfterAttendance = true });
        Assert.Equal("Share taken again — Court 2", sam.Subject);
        Assert.Contains("the session was attended", sam.PlainBody, StringComparison.Ordinal);
        Assert.Contains("16 minutes was taken from your balance again", sam.PlainBody, StringComparison.Ordinal);
    }
}
