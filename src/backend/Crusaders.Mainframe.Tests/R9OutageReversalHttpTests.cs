using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;
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

    private sealed record Rig(PlayersClub Club, WebApplicationFactory<Program> App, CapturingMail Mail, Guid BookingId, DateTimeOffset Start)
    {
        /// <summary>The organiser's live wallet, subscribed before the sweep (R10 E10-1).</summary>
        public System.Threading.Channels.Channel<RealtimeMessage>? Wallet { get; init; }

        /// <summary>The named <c>balance</c> frames the organiser's wallet has received since the last call.</summary>
        public List<JsonElement> BalanceFrames()
        {
            var frames = new List<JsonElement>();
            while (Wallet!.Reader.TryRead(out var frame))
            {
                if (frame.Event == "balance") frames.Add(JsonDocument.Parse(frame.JsonPayload).RootElement.Clone());
            }
            return frames;
        }
    }

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

        var wallet = app.Services.GetRequiredService<IRealtimeBus>().Subscribe(RealtimeTopic.Wallet(club.TenantId, club.Organiser));
        await new NoShowWorker(app.Services, app.Services.GetRequiredService<IEventBus>(), NullLogger<NoShowWorker>.Instance)
            .TickAsync(DateTimeOffset.UtcNow, default);
        var swept = await PlayersClub.ReadAsync(app, db => db.Bookings.IgnoreQueryFilters().FirstAsync(b => b.Id == bookingId));
        Assert.Equal(BookingStatus.NoShow, swept.Status);
        Assert.Equal(dark, swept.OutageRefundedAt is not null);
        return new Rig(club, app, mail, bookingId, start) { Wallet = wallet };
    }

    /// <summary>The box's queued scan arrives: Olive checked in two minutes into the slot.</summary>
    private static Task<DateTimeOffset> ReverseAsync(Rig r) => ReverseAsync(r, r.Club.Organiser);

    private static async Task<DateTimeOffset> ReverseAsync(Rig r, Guid scanner)
    {
        var scannedAt = r.Start.AddMinutes(2).Storable();
        r.Mail.Sent.Clear();
        var result = await r.Club.InClubAsync(r.App, async sp =>
        {
            var row = await sp.GetRequiredService<MainframeDbContext>().Bookings.FirstAsync(b => b.Id == r.BookingId);
            return await sp.GetRequiredService<BookingService>().ReverseNoShowAsync(
                row, scannedAt, Guid.Empty, default, scan: new ReversalScan(scanner, "member_code"));
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
        // R10 E10-6: the stored line is the club's (the admin ledger shows it); the wallet says "you".
        Assert.Equal("Outage refund reversed — the member was checked in after all", reversal.Reason);

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
        // R14 E14-3: the reversal is the scanner's (here the organiser's own scan), and the Night names them.
        Assert.Equal("Olive Organiser's check-in reached the club late — no-show reversed",
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
    /// <summary>
    /// Review round 10, E10-1: the live wallet frame for an outage refund and its reversal said
    /// <c>cancellation_refund</c> both ways ("A cancelled booking put 32 minutes back", even for the
    /// −32). They now say <c>outage_refund</c> and <c>outage_refund_reversed</c>, with the rows in <c>parts</c>.
    /// </summary>
    [SkippableFact]
    public async Task The_live_wallet_says_outage_refund_and_its_reversal_not_a_cancellation()
    {
        Skip.IfNot(pg.Available, Skipped);
        var r = await SweptAsync("r10outstream", dark: true);
        await using var owned = r.App;

        // R13 E13-5 (C13-2): the share then returned to Sam is a part of the same, single frame.
        var refund = Assert.Single(r.BalanceFrames());
        Assert.Equal(WalletStreamReasons.OutageRefund, refund.GetProperty("reason").GetString());
        Assert.Equal(16, refund.GetProperty("delta_minutes").GetInt32());
        Assert.Equal([32, -16], refund.GetProperty("parts").EnumerateArray().Select(p => p.GetProperty("delta_minutes").GetInt32()));

        await ReverseAsync(r);
        var reversed = Assert.Single(r.BalanceFrames(), f => f.GetProperty("reason").GetString() == WalletStreamReasons.OutageRefundReversed);
        Assert.Equal(-16, reversed.GetProperty("delta_minutes").GetInt32());
        Assert.Equal(-32, reversed.GetProperty("parts")[0].GetProperty("delta_minutes").GetInt32());
    }

    /// <summary>
    /// E10-1, the genuine no-show: the sweep's refund-and-penalty pair was <c>mixed</c>, which the
    /// phone said as "The club added N minutes", hiding the penalty. It is <c>no_show_settled</c>
    /// with both rows in <c>parts</c>; the late check-in's undo is <c>no_show_reversed</c>.
    /// </summary>
    [SkippableFact]
    public async Task The_live_wallet_says_a_no_show_was_settled_with_its_refund_and_penalty()
    {
        Skip.IfNot(pg.Available, Skipped);
        var r = await SweptAsync("r10nsstream", dark: false);
        await using var owned = r.App;

        // R13 E13-5 (C13-2): one frame, the share going back to Sam its third part.
        var settled = Assert.Single(r.BalanceFrames());
        Assert.Equal(WalletStreamReasons.NoShowSettled, settled.GetProperty("reason").GetString());
        var parts = settled.GetProperty("parts").EnumerateArray().ToList();
        Assert.Equal(3, parts.Count);
        Assert.Equal("share_transfer", parts[2].GetProperty("reason").GetString());
        Assert.Equal("cancellation_refund", parts[0].GetProperty("reason").GetString());
        Assert.Equal(32, parts[0].GetProperty("delta_minutes").GetInt32());
        Assert.Equal("penalty", parts[1].GetProperty("reason").GetString());
        Assert.True(parts[1].GetProperty("delta_minutes").GetInt32() < 0);
        Assert.Equal(parts.Sum(p => p.GetProperty("delta_minutes").GetInt32()), settled.GetProperty("delta_minutes").GetInt32());

        await ReverseAsync(r);
        Assert.Contains(r.BalanceFrames(), f => f.GetProperty("reason").GetString() == WalletStreamReasons.NoShowReversed);
    }
    /// <summary>
    /// Review round 10, E10-7: after an OUTAGE refund the partner read "7 minutes of your share came
    /// back from Olive" — as if the organiser had returned it. The club refunded the session because
    /// the court's box was offline, and both the headline and the mail now say so.
    /// </summary>
    [SkippableFact]
    public async Task A_share_returned_by_an_outage_refund_says_the_club_refunded_it_and_why()
    {
        Skip.IfNot(pg.Available, Skipped);
        var r = await SweptAsync("r10outshare", dark: true);
        await using var owned = r.App;

        var sam = await PlayersClub.ReadAsync(r.App, db => db.AdminNotifications.IgnoreQueryFilters()
            .Where(n => n.RecipientUserId == r.Club.Sam && n.Kind == MemberEventCatalogue.ShareMoved)
            .OrderByDescending(n => n.CreatedAt).FirstAsync());
        Assert.Equal("16 minutes of your share came back — the club refunded the session: the court's box was offline", sam.Headline);
        Assert.Equal("outage", JsonDocument.Parse(sam.PayloadJson).RootElement.GetProperty("club_refund").GetString());

        var olive = await PlayersClub.ReadAsync(r.App, db => db.AdminNotifications.IgnoreQueryFilters()
            .Where(n => n.RecipientUserId == r.Club.Organiser && n.Kind == MemberEventCatalogue.ShareMoved)
            .OrderByDescending(n => n.CreatedAt).FirstAsync());
        Assert.Contains("the club refunded the session", olive.Headline, StringComparison.Ordinal);
    }

    /// <summary>E10-7, the mails: the club's refund and its cause, never "came back from" the organiser.</summary>
    [Fact]
    public void A_share_mail_after_a_club_refund_names_the_club_and_the_cause()
    {
        // The text part is wrapped at 72 columns; the sentences are read flat.
        static string Flat(string? text) => System.Text.RegularExpressions.Regex.Replace(text ?? "", @"\s+", " ");
        ShareMovement Move(ShareDirection d, string? cause) =>
            new(d, "Olive Organiser", "Court 2", "Sat 3 Oct, 10:00", 16, "https://x.test/b") { ClubRefund = cause };

        var partner = EmailTemplates.ShareMoved(EmailCatalogue.Riverside, "s@x.test", Move(ShareDirection.Refunded, ShareRefundCauses.Outage));
        Assert.Contains("The club refunded the session because the court's box was offline", Flat(partner.PlainBody), StringComparison.Ordinal);
        Assert.Contains("16 minutes of your share came back to your balance", Flat(partner.PlainBody), StringComparison.Ordinal);
        Assert.DoesNotContain("came back from", Flat(partner.PlainBody), StringComparison.Ordinal);
        Assert.Equal("The club refunded your share — Court 2", partner.Subject);

        var organiser = EmailTemplates.ShareMoved(EmailCatalogue.Riverside, "o@x.test", Move(ShareDirection.Returned, ShareRefundCauses.NoShow));
        Assert.Contains("nobody checked in", Flat(organiser.PlainBody), StringComparison.Ordinal);

        // An ordinary return is unchanged.
        var plain = EmailTemplates.ShareMoved(EmailCatalogue.Riverside, "s@x.test", Move(ShareDirection.Refunded, null));
        Assert.Contains("16 minutes of your share came back from Olive Organiser.", Flat(plain.PlainBody), StringComparison.Ordinal);
    }

    // ---- Review round 12, E12-2 (contract C2): the scan was the partner's, not the organiser's ----

    /// <summary>
    /// The partner's late check-in reversed Olive's outage refund. Olive's wallet frames (the
    /// reversal and the share taken again) and her mail name Sam; "you were checked in after all"
    /// is never said to the organiser who did not scan.
    /// </summary>
    [SkippableTheory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task A_partners_late_check_in_is_named_to_the_organiser_on_the_frame_and_the_mail(bool dark)
    {
        Skip.IfNot(pg.Available, Skipped);
        var r = await SweptAsync(dark ? "r12scanout" : "r12scanns", dark);
        await using var owned = r.App;
        r.BalanceFrames();
        var sam = await PlayersClub.ReadAsync(r.App, db => db.Memberships.IgnoreQueryFilters().Where(m => m.UserId == r.Club.Sam).Select(m => m.FullName).FirstAsync());

        await ReverseAsync(r, r.Club.Sam);

        var frames = r.BalanceFrames();
        var reversal = Assert.Single(frames, f => f.GetProperty("reason").GetString() is WalletStreamReasons.OutageRefundReversed or WalletStreamReasons.NoShowReversed);
        Assert.Equal(sam, reversal.GetProperty("checked_in_by_name").GetString());
        var again = ShareFrame(frames);
        Assert.Equal(WalletShareCauses.Attended, again.GetProperty("share_cause").GetString());
        Assert.Equal(sam, again.GetProperty("checked_in_by_name").GetString());

        var mail = Assert.Single(r.Mail.Sent, m => m.Subject.Contains("reversed", StringComparison.Ordinal));
        Assert.Contains($"{sam} checked in", mail.PlainBody ?? "", StringComparison.Ordinal);
        Assert.DoesNotContain("You were", mail.HtmlBody + mail.PlainBody, StringComparison.Ordinal);
    }

    /// <summary>C2: the organiser's own scan names nobody — the frame's field is null and the mail says "you".</summary>
    [SkippableFact]
    public async Task The_organisers_own_late_check_in_names_nobody()
    {
        Skip.IfNot(pg.Available, Skipped);
        var r = await SweptAsync("r12scanown", dark: true);
        await using var owned = r.App;
        r.BalanceFrames();

        await ReverseAsync(r);

        Assert.All(r.BalanceFrames(), f => Assert.Equal(JsonValueKind.Null, f.GetProperty("checked_in_by_name").ValueKind));
        Assert.Contains(r.Mail.Sent, m => m.Subject.StartsWith("Outage refund reversed", StringComparison.Ordinal)
                                           && (m.PlainBody ?? "").Contains("You were checked in after all", StringComparison.Ordinal));
    }

    // ---- Review round 11: the share's cause on the live wallet, and the no-show's kept part ----

    /// <summary>
    /// The organiser's frame carrying the share's move — since R13 E13-5 (C13-2) the settlement's own
    /// frame, the share one of its <c>parts</c>.
    /// </summary>
    private static JsonElement ShareFrame(IEnumerable<JsonElement> frames) =>
        Assert.Single(frames, f => f.GetProperty("parts").EnumerateArray().Any(p => p.GetProperty("reason").GetString() == "share_transfer"));

    /// <summary>The share part's signed minutes on <see cref="ShareFrame"/>'s frame.</summary>
    private static int SharePart(JsonElement frame) =>
        frame.GetProperty("parts").EnumerateArray().Single(p => p.GetProperty("reason").GetString() == "share_transfer").GetProperty("delta_minutes").GetInt32();

    /// <summary>
    /// R11 E11-1: the frame for a share the club's outage refund sent back said only
    /// <c>share_transfer</c>, so the phone toasted "came back from Cleo". It carries the cause; the
    /// share taken again after the late check-in says <c>attended</c>.
    /// </summary>
    [SkippableFact]
    public async Task The_live_wallet_says_why_a_share_moved_after_an_outage_and_its_reversal()
    {
        Skip.IfNot(pg.Available, Skipped);
        var r = await SweptAsync("r11outcause", dark: true);
        await using var owned = r.App;

        var returned = ShareFrame(r.BalanceFrames());
        Assert.Equal(WalletShareCauses.OutageRefund, returned.GetProperty("share_cause").GetString());
        Assert.Equal(JsonValueKind.Null, returned.GetProperty("share_kept_minutes").ValueKind);
        Assert.Equal(-16, SharePart(returned));

        await ReverseAsync(r);
        var again = ShareFrame(r.BalanceFrames());
        Assert.Equal(WalletShareCauses.Attended, again.GetProperty("share_cause").GetString());
        Assert.Equal(16, SharePart(again));
    }

    /// <summary>
    /// R11 E11-1 / E11-2: a no-show's share return is the share LESS the partner's part of the
    /// penalty. The frame says <c>no_show</c> with the kept minutes; the receipts name the penalty and
    /// that part — "the club refunded the session" alone left 4 of Sam's 16 minutes unexplained.
    /// </summary>
    [SkippableFact]
    public async Task A_no_show_share_return_names_the_penalty_and_the_partners_part_of_it()
    {
        Skip.IfNot(pg.Available, Skipped);
        var r = await SweptAsync("r11nsshare", dark: false);
        await using var owned = r.App;

        var frame = ShareFrame(r.BalanceFrames());
        Assert.Equal(WalletShareCauses.NoShow, frame.GetProperty("share_cause").GetString());
        var returned = -SharePart(frame);
        var kept = frame.GetProperty("share_kept_minutes").GetInt32();
        Assert.True(kept > 0, "a no-show penalty leaves part of the share behind");
        Assert.Equal(16, returned + kept);
        Assert.Equal(50 - 16 + returned, await PlayersClub.BalanceAsync(r.App, r.Club.Sam));

        var sam = await PlayersClub.ReadAsync(r.App, db => db.AdminNotifications.IgnoreQueryFilters()
            .Where(n => n.RecipientUserId == r.Club.Sam && n.Kind == MemberEventCatalogue.ShareMoved)
            .OrderByDescending(n => n.CreatedAt).FirstAsync());
        Assert.Equal(
            $"{returned} minutes of your share came back — nobody checked in, and {kept} minutes are your part of the no-show penalty",
            sam.Headline);
        Assert.DoesNotContain("refunded the session", sam.Headline, StringComparison.Ordinal);
        Assert.Equal(kept, JsonDocument.Parse(sam.PayloadJson).RootElement.GetProperty("kept_minutes").GetInt32());

        var olive = await PlayersClub.ReadAsync(r.App, db => db.AdminNotifications.IgnoreQueryFilters()
            .Where(n => n.RecipientUserId == r.Club.Organiser && n.Kind == MemberEventCatalogue.ShareMoved)
            .OrderByDescending(n => n.CreatedAt).FirstAsync());
        Assert.Contains($"{kept} minutes are", olive.Headline, StringComparison.Ordinal);
        Assert.Contains("part of the no-show penalty", olive.Headline, StringComparison.Ordinal);
    }

    /// <summary>R11 E11-2, the mails: the no-show penalty, the partner's part of it, and what came back of what they paid.</summary>
    [Fact]
    public void A_no_show_share_mail_names_the_penalty_part()
    {
        static string Flat(string? text) => System.Text.RegularExpressions.Regex.Replace(text ?? "", @"\s+", " ");
        ShareMovement Move(ShareDirection d) =>
            new(d, "Ava Organiser", "Court 4", "Sat 3 Oct, 10:00", 11, "https://x.test/b") { ClubRefund = ShareRefundCauses.NoShow, KeptMinutes = 4 };

        var partner = EmailTemplates.ShareMoved(EmailCatalogue.Riverside, "s@x.test", Move(ShareDirection.Refunded));
        Assert.Equal("No-show: part of your share came back — Court 4", partner.Subject);
        Assert.Contains("Your part of that penalty is 4 minutes, so 11 minutes of the 15 minutes you paid came back to your balance.", Flat(partner.PlainBody), StringComparison.Ordinal);
        Assert.DoesNotContain("refunded the session", Flat(partner.PlainBody), StringComparison.Ordinal);

        var organiser = EmailTemplates.ShareMoved(EmailCatalogue.Riverside, "o@x.test", Move(ShareDirection.Returned));
        Assert.Contains("Ava Organiser's part of that penalty is 4 minutes", Flat(organiser.PlainBody), StringComparison.Ordinal);
    }

    /// <summary>R11 E11-1: every cause the frame can carry, decided from the same facts the receipts use.</summary>
    [Theory]
    [InlineData(5, null, false, null, BookingStatus.Booked, WalletShareCauses.SharePaid)]
    [InlineData(5, true, false, null, BookingStatus.Booked, WalletShareCauses.ClubCollected)]
    [InlineData(5, null, true, null, BookingStatus.Booked, WalletShareCauses.Attended)]
    [InlineData(-5, false, false, null, BookingStatus.Booked, WalletShareCauses.ClubRemoved)]
    [InlineData(-5, null, false, ShareRefundCauses.Outage, BookingStatus.NoShow, WalletShareCauses.OutageRefund)]
    [InlineData(-5, null, false, ShareRefundCauses.NoShow, BookingStatus.NoShow, WalletShareCauses.NoShow)]
    [InlineData(-5, null, false, ShareRefundCauses.Displaced, BookingStatus.Cancelled, WalletShareCauses.Displaced)]
    [InlineData(-5, null, false, null, BookingStatus.Cancelled, WalletShareCauses.BookingCancelled)]
    // R14 review M1/L1: a plain return the seat's record does not explain names no act.
    [InlineData(-5, null, false, null, BookingStatus.Booked, WalletShareCauses.ShareBack)]
    public void Every_share_cause_is_decided_from_the_receipts_facts(
        int delta, bool? clubCollected, bool attended, string? refund, BookingStatus status, string expected)
    {
        var club = clubCollected is { } c ? new ClubReceipt(c, null, null) : null;
        var move = new ShareMove(Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), delta, 1);
        Assert.Equal(expected, ShareLedger.CauseOf(new Booking { Status = status }, move, club, attended, refund));
    }
}

