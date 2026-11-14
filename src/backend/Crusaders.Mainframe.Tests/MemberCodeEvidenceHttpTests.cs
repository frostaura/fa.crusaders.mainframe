using System.Net;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Uploaded v1 evidence (<c>docs/specs/member-code.md</c> §7, §13), the cases two independent
/// reviews proved wrong: the booking a scan belongs to when two sit back to back; a board's own
/// fallback of an online act, and a retried upload, flagged as forgery; an old generation honoured
/// for ever; and a clamped clock turned into a forgery alarm.
/// </summary>
public sealed class MemberCodeEvidenceHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private static Task<List<AdminNotification>> ForgeryNoticesAsync(MemberCodeClub club, Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactory<Program> app) =>
        club.ReadAsync(app, db => db.AdminNotifications.IgnoreQueryFilters()
            .Where(n => n.TenantId == club.TenantId && n.Kind == AdminEventCatalogue.CodeForgerySuspected).ToListAsync());

    private static Task<Booking> BookingAsync(MemberCodeClub club, Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactory<Program> app, Guid id) =>
        club.ReadAsync(app, db => db.Bookings.IgnoreQueryFilters().FirstAsync(b => b.Id == id));

    // ---- #3: back-to-back bookings ---------------------------------------------------------------

    /// <summary>
    /// 17:00 and 18:00 on one court, one member; the scan is at 18:02 — inside the 18:00 slot and
    /// inside the 17:00 slot's grace tail. It is the 18:00 slot's attendance.
    /// </summary>
    [SkippableFact]
    public async Task A_scan_in_the_second_of_two_back_to_back_slots_is_that_slots_attendance()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "backtoback");
        var first = await club.BookAsync(app, club.Olga, courtIndex: 1, startsInMinutes: -62, minutes: 60);   // "17:00", ended 2 min ago
        var second = await club.BookAsync(app, club.Olga, courtIndex: 1, startsInMinutes: -2, minutes: 60);   // "18:00", started 2 min ago

        Assert.Equal(HttpStatusCode.OK, (await app.CreateClient().SendAsync(club.Events(club.BoxMac, 1, "activation", 1, club.Code(club.Olga)))).StatusCode);

        Assert.NotNull((await BookingAsync(club, app, second.Id)).CheckedInAt);
        Assert.Null((await BookingAsync(club, app, first.Id)).CheckedInAt);
    }

    /// <summary>The other side of the boundary: 17:55, inside the 17:00 slot and the 18:00 slot's cue window, is the 17:00 slot's.</summary>
    [SkippableFact]
    public async Task A_scan_in_the_first_slot_and_the_next_ones_cue_window_is_the_first_slots()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "b2bcue");
        var first = await club.BookAsync(app, club.Olga, courtIndex: 1, startsInMinutes: -55, minutes: 60);   // ends in 5
        var second = await club.BookAsync(app, club.Olga, courtIndex: 1, startsInMinutes: 5, minutes: 60);   // cue open (10 min)

        await app.CreateClient().SendAsync(club.Events(club.BoxMac, 1, "activation", 1, club.Code(club.Olga)));

        Assert.NotNull((await BookingAsync(club, app, first.Id)).CheckedInAt);
        Assert.Null((await BookingAsync(club, app, second.Id)).CheckedInAt);
    }

    // ---- #4: the board's own act, uploaded ------------------------------------------------------

    /// <summary>
    /// An online grant, then the same box's roster fallback for the same scan (the answer was lost
    /// on the way back): a receipt, attendance already stamped, and no alarm. The same code
    /// uploaded by a DIFFERENT box is still one code used twice.
    /// </summary>
    [SkippableFact]
    public async Task The_same_boards_fallback_of_an_online_grant_is_a_receipt_not_a_forgery()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "fallback");
        var booking = await club.BookAsync(app, club.Olga, courtIndex: 1, startsInMinutes: -5);
        var device = app.CreateClient();
        var code = club.Code(club.Olga);

        var online = await MemberCodeClub.JsonAsync(await device.SendAsync(club.Activate(code)));
        Assert.True(online.GetProperty("activated").GetBoolean());

        Assert.Equal(HttpStatusCode.OK, (await device.SendAsync(club.Events(club.BoxMac, 1, "activation", 1, code))).StatusCode);
        Assert.Empty(await ForgeryNoticesAsync(club, app));
        Assert.NotNull((await BookingAsync(club, app, booking.Id)).CheckedInAt);
        Assert.Equal(1, await club.UsesAsync(app, MemberCodeUseClass.Court));

        // A second box uploading the same code is the third kind of forgery.
        var otherBox = Guid.NewGuid().ToString("N")[..12];
        await club.WriteAsync(app, db =>
        {
            db.Devices.Add(new Device
            {
                TenantId = club.TenantId,
                DeviceCode = $"box-{otherBox[^6..]}",
                Name = "Box 2",
                Kind = DeviceKind.CourtBox,
                MacAddress = otherBox,
                CourtNumbers = [1, 2, 3, 4],
                AutoRegistered = false,
            });
            return Task.CompletedTask;
        });
        await device.SendAsync(club.Events(otherBox, 1, "activation", 1, code));
        Assert.Contains("twice", Assert.Single(await ForgeryNoticesAsync(club, app)).PayloadJson);
    }

    [SkippableFact]
    public async Task The_same_doors_fallback_of_an_online_open_is_a_receipt_not_a_forgery()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "doorfallback");
        var device = app.CreateClient();
        var code = club.Code(club.Pam);

        Assert.True((await MemberCodeClub.JsonAsync(await device.SendAsync(club.Gate(code)))).GetProperty("opened").GetBoolean());
        await device.SendAsync(club.Events(club.DoorMac, 1, "gate_open", -1, code));

        Assert.Empty(await ForgeryNoticesAsync(club, app));
        Assert.Equal(1, await club.UsesAsync(app, MemberCodeUseClass.Door));
    }

    /// <summary>
    /// M2: an upload that failed after claiming its use left the claim behind; the box re-uploads
    /// the same (device, boot, seq) and must be recognised as the same act — attendance, no alarm.
    /// </summary>
    [SkippableFact]
    public async Task A_re_upload_after_a_failed_one_recognises_its_own_claim()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "strandclaim");
        var booking = await club.BookAsync(app, club.Olga, courtIndex: 1, startsInMinutes: -5);
        var at = DateTimeOffset.UtcNow.AddSeconds(-1);
        var code = club.Code(club.Olga, at);

        // What the failed upload left: its claim, and no receipt.
        var boxId = await club.ReadAsync(app, db => db.Devices.IgnoreQueryFilters().Where(d => d.MacAddress == club.BoxMac).Select(d => d.Id).FirstAsync());
        await club.WriteAsync(app, db =>
        {
            db.MemberCodeUses.Add(new MemberCodeUse
            {
                TenantId = club.TenantId,
                Ref = club.Refs[club.Olga],
                Step = MemberCodeMath.StepOf(at),
                UseClass = MemberCodeUseClass.Court,
                DeviceId = boxId,
                Kind = "activation_event",
                ClaimKey = "evt:7:1",   // this very event: boot 7, seq 1
            });
            return Task.CompletedTask;
        });

        await app.CreateClient().SendAsync(club.Events(club.BoxMac, 1, "activation", 1, code));

        Assert.Empty(await ForgeryNoticesAsync(club, app));
        Assert.NotNull((await BookingAsync(club, app, booking.Id)).CheckedInAt);
    }

    // ---- #7: the previous generation, bounded -----------------------------------------------------

    [SkippableTheory]
    [InlineData(1, true)]    // rotated an hour ago: a board offline across it verified honestly
    [InlineData(7, false)]   // rotated seven hours ago: every roster carrying the old keys is dead
    public async Task An_old_generation_is_honoured_only_within_a_rosters_life_of_the_rotation(int hoursAgo, bool genuine)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, $"oldgen{hoursAgo}");
        var booking = await club.BookAsync(app, club.Olga, courtIndex: 1, startsInMinutes: -5);
        await club.WriteAsync(app, async db =>
        {
            var row = await db.MemberCodes.IgnoreQueryFilters().FirstAsync(c => c.UserId == club.Olga);
            row.Generation = 2;
            row.RotatedAt = DateTimeOffset.UtcNow.AddHours(-hoursAgo);
        });

        await app.CreateClient().SendAsync(club.Events(club.BoxMac, 1, "activation", 1, club.Code(club.Olga, generation: 1)));

        Assert.Equal(genuine, (await BookingAsync(club, app, booking.Id)).CheckedInAt is not null);
        Assert.Equal(genuine ? 0 : 1, (await ForgeryNoticesAsync(club, app)).Count);
    }

    /// <summary>A suspended member's retired code is never honoured, however recent the rotation.</summary>
    [SkippableFact]
    public async Task An_old_generation_is_never_honoured_for_a_member_not_active_at_the_scan()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "oldgensusp");
        await club.WriteAsync(app, async db =>
        {
            var row = await db.MemberCodes.IgnoreQueryFilters().FirstAsync(c => c.UserId == club.Sid);
            row.Generation = 2;
            row.RotatedAt = DateTimeOffset.UtcNow.AddMinutes(-30);
            var m = await db.Memberships.IgnoreQueryFilters().FirstAsync(x => x.Id == club.SidMembership);
            m.Status = MembershipStatus.Suspended;
            m.ReviewedAt = DateTimeOffset.UtcNow.AddMinutes(-30);
        });

        await app.CreateClient().SendAsync(club.Events(club.DoorMac, 1, "gate_open", -1, club.Code(club.Sid, generation: 1)));

        Assert.Single(await ForgeryNoticesAsync(club, app));
        Assert.Equal(0, await club.UsesAsync(app));
    }

    // ---- #13: a clamped clock --------------------------------------------------------------------

    /// <summary>
    /// A box whose counter claims the scan happened in the future is clamped to the upload; the
    /// step the code was shown at is unknown, so it is recorded unverifiable — not attendance, and
    /// no forgery alarm on a guess.
    /// </summary>
    [SkippableFact]
    public async Task A_v1_code_on_a_clamped_event_is_unverifiable_not_forged()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "clamped");
        var booking = await club.BookAsync(app, club.Olga, courtIndex: 1, startsInMinutes: -60, minutes: 120);

        // Shown an hour ago; the box's broken counter says "in ten minutes".
        var response = await app.CreateClient().SendAsync(
            club.Events(club.BoxMac, 1, "activation", 1, club.Code(club.Olga, DateTimeOffset.UtcNow.AddHours(-1)), agoMs: -600_000));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(1, (await MemberCodeClub.JsonAsync(response)).GetProperty("accepted_through").GetInt64());

        Assert.Empty(await ForgeryNoticesAsync(club, app));
        Assert.Null((await BookingAsync(club, app, booking.Id)).CheckedInAt);
        Assert.Single(await club.ReadAsync(app, db => db.AuditLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == club.TenantId && a.Action == "device.activation_unverifiable").ToListAsync()));
    }

    /// <summary>
    /// Refute round 1, #6: a broken counter makes the STEP unknowable, not the facts that need no
    /// step. Another door holding the code's use is still a reuse, and an OFF that matched with an
    /// ON that did not is still somebody holding K_day without S — both page every admin.
    /// </summary>
    [SkippableFact]
    public async Task A_clamped_event_still_raises_reuse_and_a_failed_on()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "clampalarm");
        var secondDoor = Guid.NewGuid().ToString("N")[..12];
        await club.WriteAsync(app, db =>
        {
            db.Devices.Add(new Device
            {
                TenantId = club.TenantId,
                DeviceCode = "gate-2",
                Name = "Side door",
                Kind = DeviceKind.Gate,
                Hardware = DeviceHardware.Esp32,
                MacAddress = secondDoor,
                GateKey = "side",
            });
            return Task.CompletedTask;
        });
        var device = app.CreateClient();
        var code = club.Code(club.Pam);

        await device.SendAsync(club.Events(club.DoorMac, 1, "gate_open", -1, code));
        await device.SendAsync(club.Events(secondDoor, 1, "gate_open", -1, code, agoMs: -600_000));   // clamped
        Assert.Contains("twice", Assert.Single(await ForgeryNoticesAsync(club, app)).PayloadJson);

        await device.SendAsync(club.Events(club.DoorMac, 2, "gate_open", -1, club.ForgedOn(club.Olga), agoMs: -600_000));
        Assert.Equal(2, (await ForgeryNoticesAsync(club, app)).Count);
    }

    /// <summary>A GENUINE code on a clamped event is still not attendance: the scan's time is unknown.</summary>
    [SkippableFact]
    public async Task A_genuine_code_on_a_clamped_event_is_not_attendance()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "clampgen");
        var booking = await club.BookAsync(app, club.Olga, courtIndex: 1, startsInMinutes: -5);

        await app.CreateClient().SendAsync(club.Events(club.BoxMac, 1, "activation", 1, club.Code(club.Olga), agoMs: -600_000));

        Assert.Null((await BookingAsync(club, app, booking.Id)).CheckedInAt);
        Assert.Empty(await ForgeryNoticesAsync(club, app));
    }

    /// <summary>
    /// Refute round 2, M2: a door opened OFFLINE for a code, got its link back, and was shown a
    /// photo of the same code before the first open was uploaded; the server — not yet told —
    /// opened again. When the queued event then arrives it is clearly EARLIER than the online
    /// claim it collides with: a second act at the same door, not the same one, and it pages
    /// every admin. (The door firmware now refuses such a scan locally too.)
    /// </summary>
    [SkippableFact]
    public async Task An_offline_event_clearly_earlier_than_the_same_boards_online_claim_is_a_reuse()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "earlierev");
        var device = app.CreateClient();
        var code = club.Code(club.Pam);

        Assert.True((await MemberCodeClub.JsonAsync(await device.SendAsync(club.Gate(code)))).GetProperty("opened").GetBoolean());
        await device.SendAsync(club.Events(club.DoorMac, 1, "gate_open", -1, code, agoMs: 20_000));

        Assert.Contains("twice", Assert.Single(await ForgeryNoticesAsync(club, app)).PayloadJson);
    }

    /// <summary>The same board's upload of an event it logged a moment AFTER its online claim is still the same act.</summary>
    [SkippableFact]
    public async Task An_offline_event_at_or_after_the_same_boards_online_claim_is_the_same_act()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "laterev");
        var device = app.CreateClient();
        var code = club.Code(club.Pam);

        Assert.True((await MemberCodeClub.JsonAsync(await device.SendAsync(club.Gate(code)))).GetProperty("opened").GetBoolean());
        await device.SendAsync(club.Events(club.DoorMac, 1, "gate_open", -1, code, agoMs: 0));

        Assert.Empty(await ForgeryNoticesAsync(club, app));
    }
}
