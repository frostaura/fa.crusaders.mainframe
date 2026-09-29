using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// <c>v1_only</c> refuses legacy codes on EVERY path (<c>docs/specs/member-code.md</c> §8, §13) —
/// the courtside QR kiosk, the biometric payer override and uploaded legacy evidence were the
/// paths that forgot — and the cut-off ends every legacy code in the table.
/// </summary>
public sealed class MemberCodeCutoffHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private static AccessCode Code(MemberCodeClub club, Guid user, AccessCodePurpose purpose, Guid? booking = null) => new()
    {
        TenantId = club.TenantId, Code = AccessCodeService.NewCode(), Purpose = purpose, UserId = user, BookingId = booking,
        ExpiresAt = DateTimeOffset.UtcNow.AddHours(2),
    };

    [SkippableFact]
    public async Task After_the_cut_off_the_kiosk_and_the_payer_override_refuse_legacy_codes()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "kiosk");
        var booking = await club.BookAsync(app, club.Olga, courtIndex: 1, startsInMinutes: -5);
        var bookingCode = Code(club, club.Olga, AccessCodePurpose.BookingActivation, booking.Id);
        var ident = Code(club, club.Pam, AccessCodePurpose.MemberIdent);
        await club.WriteAsync(app, db => { db.AccessCodes.AddRange(bookingCode, ident); return Task.CompletedTask; });
        var kiosk = club.Member(app, club.AdminId, "admin");

        await club.SetPhaseAsync(app, MemberCodeSettings.V1Only);

        var qr = await MemberCodeClub.JsonAsync(await kiosk.PostAsJsonAsync("/api/v1/court/2/qr/match", new { token = bookingCode.Code }));
        Assert.False(qr.GetProperty("matched").GetBoolean());
        Assert.Null((await club.ReadAsync(app, db => db.Bookings.IgnoreQueryFilters().FirstAsync(b => b.Id == booking.Id))).CheckedInAt);

        var payer = await kiosk.PostAsJsonAsync("/api/v1/court/2/biometric/match", new { payerMethod = "qr", payerToken = ident.Code });
        Assert.Equal(HttpStatusCode.BadRequest, payer.StatusCode);
        Assert.Equal("payer_not_recognised", (await MemberCodeClub.JsonAsync(payer)).GetProperty("error").GetString());
    }

    /// <summary>The control: before the cut-off the kiosk still takes a booking code.</summary>
    [SkippableFact]
    public async Task Before_the_cut_off_the_kiosk_still_takes_a_booking_code()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "kioskv1");
        var booking = await club.BookAsync(app, club.Olga, courtIndex: 1, startsInMinutes: -5);
        var bookingCode = Code(club, club.Olga, AccessCodePurpose.BookingActivation, booking.Id);
        await club.WriteAsync(app, db => { db.AccessCodes.Add(bookingCode); return Task.CompletedTask; });
        await club.SetPhaseAsync(app, MemberCodeSettings.V1);

        var qr = await MemberCodeClub.JsonAsync(await club.Member(app, club.AdminId, "admin").PostAsJsonAsync("/api/v1/court/2/qr/match", new { token = bookingCode.Code }));
        Assert.True(qr.GetProperty("matched").GetBoolean());
    }

    /// <summary>
    /// Uploaded legacy evidence is judged at the scan: a scan from before the cut-off instant
    /// (a roster fetched before it) is attendance; one after it names nobody.
    /// </summary>
    [SkippableTheory]
    [InlineData(-10, true)]    // cut off ten minutes AFTER the scan
    [InlineData(10, false)]    // cut off ten minutes BEFORE it
    public async Task Legacy_evidence_is_honoured_only_for_a_scan_before_the_cut_off(int cutoffMinutesAgo, bool attended)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, $"legev{(attended ? "a" : "b")}");
        var booking = await club.BookAsync(app, club.Olga, courtIndex: 1, startsInMinutes: -30, minutes: 60);
        var bookingCode = Code(club, club.Olga, AccessCodePurpose.BookingActivation, booking.Id);
        await club.WriteAsync(app, db => { db.AccessCodes.Add(bookingCode); return Task.CompletedTask; });

        // The scan was five minutes ago.
        await club.SetPhaseAsync(app, MemberCodeSettings.V1Only, DateTimeOffset.UtcNow.AddDays(-20));
        await club.SetAsync(app, MemberCodeSettings.CutoffAtKey, DateTimeOffset.UtcNow.AddMinutes(-(5 + cutoffMinutesAgo)).ToString("O"));

        await app.CreateClient().SendAsync(club.Events(club.BoxMac, 1, "activation", 1, bookingCode.Code, agoMs: 5 * 60_000));

        Assert.Equal(attended, (await club.ReadAsync(app, db => db.Bookings.IgnoreQueryFilters().FirstAsync(b => b.Id == booking.Id))).CheckedInAt is not null);
    }

    [SkippableFact]
    public async Task The_cut_off_by_hand_ends_every_legacy_code_in_the_table()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "expire");
        var other = await MemberCodeClub.SeedAsync(app, "expireother");
        var mine = Code(club, club.Pam, AccessCodePurpose.MemberIdent);
        var theirs = Code(other, other.Pam, AccessCodePurpose.MemberIdent);
        await club.WriteAsync(app, db => { db.AccessCodes.AddRange(mine, theirs); return Task.CompletedTask; });
        await club.SetPhaseAsync(app, MemberCodeSettings.V1);

        var admin = club.Member(app, club.AdminId, "admin");
        var body = JsonSerializer.SerializeToNode(new
        {
            sliceMinutes = 15, slicePriceCredits = 8, advanceBookingDays = 14, dayStartMinute = 0, dayEndMinute = 1440,
            penaltyPct = 30, graceWindowMinutes = 5, penaltyWindowMinutes = 15, member_code_phase = "v1_only",
        });
        Assert.Equal(HttpStatusCode.OK, (await admin.PutAsJsonAsync("/api/v1/admin/settings", body)).StatusCode);

        var expiries = await club.ReadAsync(app, db => db.AccessCodes.IgnoreQueryFilters()
            .Where(c => c.Id == mine.Id || c.Id == theirs.Id).ToDictionaryAsync(c => c.Id, c => c.ExpiresAt));
        Assert.True(expiries[mine.Id] <= DateTimeOffset.UtcNow);
        Assert.True(expiries[theirs.Id] > DateTimeOffset.UtcNow.AddHours(1));   // another club's codes are not this club's cut-off
    }

    /// <summary>The automatic cut-off does the same.</summary>
    [SkippableFact]
    public async Task The_automatic_cut_off_ends_every_legacy_code_in_the_table()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "autoexp");
        var mine = Code(club, club.Pam, AccessCodePurpose.MemberIdent);
        await club.WriteAsync(app, db => { db.AccessCodes.Add(mine); return Task.CompletedTask; });
        await club.SetPhaseAsync(app, MemberCodeSettings.V1, DateTimeOffset.UtcNow.AddDays(-15));

        await app.CreateClient().SendAsync(club.Heartbeat(club.BoxMac, m1: true));

        Assert.True(await club.ReadAsync(app, db => db.AccessCodes.IgnoreQueryFilters().Where(c => c.Id == mine.Id).Select(c => c.ExpiresAt).FirstAsync()) <= DateTimeOffset.UtcNow);
    }

    /// <summary>
    /// Refute round 1, #4: a club that rolls back out of <c>v1_only</c> gets its members' legacy
    /// codes back — the ones the cut-off ended early and whose own expiry is still ahead. One whose
    /// own expiry has since passed stays expired.
    /// </summary>
    [SkippableFact]
    public async Task A_rollback_out_of_v1_only_gives_back_the_codes_the_cut_off_ended()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "restore");
        var live = Code(club, club.Pam, AccessCodePurpose.MemberIdent);
        var lapsed = Code(club, club.Olga, AccessCodePurpose.MemberIdent);
        await club.WriteAsync(app, db => { db.AccessCodes.AddRange(live, lapsed); return Task.CompletedTask; });
        await club.SetPhaseAsync(app, MemberCodeSettings.V1);
        var admin = club.Member(app, club.AdminId, "admin");

        async Task Put(string phase)
        {
            var body = JsonSerializer.SerializeToNode(new
            {
                sliceMinutes = 15, slicePriceCredits = 8, advanceBookingDays = 14, dayStartMinute = 0, dayEndMinute = 1440,
                penaltyPct = 30, graceWindowMinutes = 5, penaltyWindowMinutes = 15, member_code_phase = phase,
            });
            Assert.Equal(HttpStatusCode.OK, (await admin.PutAsJsonAsync("/api/v1/admin/settings", body)).StatusCode);
        }

        await Put("v1_only");
        Assert.Equal("not_recognised", (await MemberCodeClub.JsonAsync(await app.CreateClient().SendAsync(club.Gate(live.Code)))).GetProperty("reason").GetString());

        // The other code's own expiry passes while the club is cut off.
        await club.WriteAsync(app, async db =>
            (await db.AccessCodes.IgnoreQueryFilters().FirstAsync(c => c.Id == lapsed.Id)).ExpiresAtBeforeCutoff = DateTimeOffset.UtcNow.AddMinutes(-1));

        await Put("v1");

        var rows = await club.ReadAsync(app, db => db.AccessCodes.IgnoreQueryFilters()
            .Where(c => c.Id == live.Id || c.Id == lapsed.Id).ToDictionaryAsync(c => c.Id));
        Assert.Equal(live.ExpiresAt.Storable(), rows[live.Id].ExpiresAt);
        Assert.True(rows[lapsed.Id].ExpiresAt <= DateTimeOffset.UtcNow);
        Assert.All(rows.Values, c => Assert.Null(c.CutoffExpiredAt));
        Assert.True((await MemberCodeClub.JsonAsync(await app.CreateClient().SendAsync(club.Gate(live.Code)))).GetProperty("opened").GetBoolean());
    }

    /// <summary>
    /// Refute round 2: the rollback gives back a booking's code only while the booking is still
    /// live — one cancelled (or displaced, or ended) after the cut-off keeps its code dead.
    /// </summary>
    [SkippableFact]
    public async Task A_rollback_never_revives_the_code_of_a_booking_that_is_no_longer_live()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "restorebk");
        var live = await club.BookAsync(app, club.Olga, courtIndex: 1, startsInMinutes: 30);
        var gone = await club.BookAsync(app, club.Pam, courtIndex: 2, startsInMinutes: 30);
        var liveCode = Code(club, club.Olga, AccessCodePurpose.BookingActivation, live.Id);
        var goneCode = Code(club, club.Pam, AccessCodePurpose.BookingActivation, gone.Id);
        await club.WriteAsync(app, db => { db.AccessCodes.AddRange(liveCode, goneCode); return Task.CompletedTask; });
        await club.SetPhaseAsync(app, MemberCodeSettings.V1);
        var admin = club.Member(app, club.AdminId, "admin");

        async Task Put(string phase)
        {
            var body = JsonSerializer.SerializeToNode(new
            {
                sliceMinutes = 15, slicePriceCredits = 8, advanceBookingDays = 14, dayStartMinute = 0, dayEndMinute = 1440,
                penaltyPct = 30, graceWindowMinutes = 5, penaltyWindowMinutes = 15, member_code_phase = phase,
            });
            Assert.Equal(HttpStatusCode.OK, (await admin.PutAsJsonAsync("/api/v1/admin/settings", body)).StatusCode);
        }

        await Put("v1_only");
        await club.WriteAsync(app, async db => (await db.Bookings.IgnoreQueryFilters().FirstAsync(b => b.Id == gone.Id)).Status = BookingStatus.Cancelled);
        await Put("v1");

        var rows = await club.ReadAsync(app, db => db.AccessCodes.IgnoreQueryFilters()
            .Where(c => c.Id == liveCode.Id || c.Id == goneCode.Id).ToDictionaryAsync(c => c.Id));
        Assert.True(rows[liveCode.Id].ExpiresAt > DateTimeOffset.UtcNow.AddHours(1));
        Assert.True(rows[goneCode.Id].ExpiresAt <= DateTimeOffset.UtcNow);
        Assert.All(rows.Values, c => Assert.Null(c.CutoffExpiredAt));
    }
}
