using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security;
using Crusaders.Mainframe.Api.Services;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The member-code seam (<c>IBookingPlayers</c>, <c>docs/specs/member-code.md</c> §13) wired to
/// P11's participants (<c>docs/specs/players-and-splits.md</c>), over HTTP against Postgres, with
/// real seats rather than a stand-in: a split booking's roster entry names the organiser and the
/// ACCEPTED partners' REFs; a partner's own v1 code opens the door, lights the court and is their
/// own attendance, with nobody's money moved; pay-for at the box refuses a split booking with
/// <c>split_booking</c>; and an invited, declined or removed member gets none of it.
/// </summary>
public sealed class PlayersMemberCodeSeamHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Nonce = "5e7a9c1b3d5f7a9c";

    private sealed record Game(
        MemberCodeClub Club, WebApplicationFactory<Program> App, Booking Booking,
        Guid Invited, Guid Declined, Guid Removed);

    /// <summary>
    /// Olga's booking on court 2, started five minutes ago: Pam ACCEPTED with a share (so the
    /// booking is split), plus one seat each invited, declined and removed — every one of them an
    /// active member with a code of their own.
    /// </summary>
    private static async Task<Game> SplitGameAsync(WebApplicationFactory<Program> app, string prefix)
    {
        var club = await MemberCodeClub.SeedAsync(app, prefix);
        var booking = await club.BookAsync(app, club.Olga, courtIndex: 1, startsInMinutes: -5);
        var invited = await MemberAsync(app, club, "ivy");
        var declined = await MemberAsync(app, club, "dee");
        var removed = await MemberAsync(app, club, "rae");
        await SeatsAsync(app, club, booking.Id,
            (1, club.Olga, ParticipantStatus.Accepted, 8),
            (2, club.Pam, ParticipantStatus.Accepted, 8),
            (3, invited, ParticipantStatus.Invited, 8),
            (4, declined, ParticipantStatus.Declined, 8));
        // A removed seat frees its seat number; the row stays, and it must not count.
        await SeatsAsync(app, club, booking.Id, (4, removed, ParticipantStatus.Removed, 8));
        return new Game(club, app, booking, invited, declined, removed);
    }

    [SkippableFact]
    public async Task A_split_bookings_roster_entry_names_the_organiser_then_the_accepted_partner_and_nobody_else()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var g = await SplitGameAsync(app, "seamroster");
        var c = g.Club;
        await c.SetPhaseAsync(app, MemberCodeSettings.V1);
        var device = app.CreateClient();

        var olga = MemberCodeMath.RefText(c.Refs[c.Olga]);
        var pam = MemberCodeMath.RefText(c.Refs[c.Pam]);
        var box = await BeatAsync(device, c, c.BoxMac, kind: null);
        Assert.StartsWith($"m{olga}{pam}|1|", Assert.Single(box.GetProperty("roster").EnumerateArray()).GetString());
        var door = await BeatAsync(device, c, c.DoorMac, kind: "gate");
        Assert.StartsWith($"m{olga}{pam}|", Assert.Single(door.GetProperty("roster").EnumerateArray()).GetString());

        // The partner's K_day travels with the roster, so the board can check her code offline;
        // nobody else on the seat list gets one.
        var keyRefs = box.GetProperty("code_keys").EnumerateArray().Select(k => k.GetString()![..pam.Length]).ToHashSet();
        Assert.Contains(pam, keyRefs);
        foreach (var outsider in new[] { g.Invited, g.Declined, g.Removed })
        {
            Assert.DoesNotContain(MemberCodeMath.RefText(c.Refs[outsider]), keyRefs);
        }
    }

    [SkippableFact]
    public async Task A_partners_own_code_opens_the_door_and_lights_the_court_as_her_own_attendance_and_moves_no_money()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        var clock = new PinnedClock();
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService(), clock);
        var g = await SplitGameAsync(app, "seamaccess");
        var c = g.Club;
        await c.SetAsync(app, GateAccessPolicies.Key, GateAccessPolicies.BookingWindow);
        var device = app.CreateClient();
        var before = (await c.BalanceAsync(app, c.Olga), await c.BalanceAsync(app, c.Pam));

        // The invited, the declined and the removed are strangers to this booking at both boards.
        foreach (var outsider in new[] { g.Invited, g.Declined, g.Removed })
        {
            var shut = await MemberCodeClub.JsonAsync(await device.SendAsync(c.Gate(c.Code(outsider, at: clock.Now))));
            Assert.False(shut.GetProperty("opened").GetBoolean());
            Assert.Equal(GateAccess.NoBooking, shut.GetProperty("reason").GetString());
            var dark = await MemberCodeClub.JsonAsync(await device.SendAsync(c.Activate(c.Code(outsider, at: clock.Now))));
            Assert.False(dark.GetProperty("activated").GetBoolean());
            Assert.Equal("no_booking", dark.GetProperty("reason").GetString());
        }

        var gate = await MemberCodeClub.JsonAsync(await device.SendAsync(c.Gate(c.Code(c.Pam, at: clock.Now))));
        Assert.True(gate.GetProperty("opened").GetBoolean());

        // A fresh code: the door's use of the last one is a different class, but a new step keeps
        // the assertion about the court and nothing else.
        var lit = await MemberCodeClub.JsonAsync(await device.SendAsync(c.Activate(c.Code(c.Pam, at: clock.Now, stepOffset: -1))));
        Assert.True(lit.GetProperty("activated").GetBoolean());
        Assert.Equal(g.Booking.Id, lit.GetProperty("booking_id").GetGuid());

        var seats = await SeatsOfAsync(app, c, g.Booking.Id);
        Assert.NotNull(seats.Single(s => s.UserId == c.Pam && s.Status == ParticipantStatus.Accepted).CheckedInAt);
        Assert.All(seats.Where(s => s.UserId != c.Pam), s => Assert.Null(s.CheckedInAt));
        var booking = await c.ReadAsync(app, db => db.Bookings.IgnoreQueryFilters().AsNoTracking().SingleAsync(b => b.Id == g.Booking.Id));
        Assert.NotNull(booking.CheckedInAt);
        Assert.Equal(c.Olga, booking.PaidByUserId);   // no payer override: a scan is not a payment
        Assert.Equal(before, (await c.BalanceAsync(app, c.Olga), await c.BalanceAsync(app, c.Pam)));

        // Review round 10, E10-2: Olga's Night names whose code lit her court — Pam's, not hers.
        var night = await c.Member(app, c.AdminId, "admin")
            .GetFromJsonAsync<JsonElement>($"/api/v1/admin/members/{c.Olga}/trace?day={c.DayOf(clock.Now)}");
        var lights = Assert.Single(night.GetProperty("events").EnumerateArray(), e => e.GetProperty("kind").GetString() == TraceKinds.LightsOn);
        Assert.Equal(c.Olga, lights.GetProperty("subject").GetProperty("user_id").GetGuid());
        Assert.Equal(c.Pam, lights.GetProperty("code_holder").GetProperty("user_id").GetGuid());
        Assert.Equal("Pam Payer", lights.GetProperty("code_holder").GetProperty("name").GetString());
        Assert.All(night.GetProperty("events").EnumerateArray().Where(e => e.GetProperty("kind").GetString() != TraceKinds.LightsOn),
            e => Assert.Equal(JsonValueKind.Null, e.GetProperty("code_holder").ValueKind));
    }

    [SkippableFact]
    public async Task A_partners_offline_scan_uploaded_as_evidence_is_her_attendance_and_a_declined_members_is_nobodys()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var g = await SplitGameAsync(app, "seamevid");
        var c = g.Club;
        var device = app.CreateClient();

        Assert.Equal(HttpStatusCode.OK, (await device.SendAsync(c.Events(c.BoxMac, 1, "activation", 1, c.Code(g.Declined)))).StatusCode);
        Assert.All(await SeatsOfAsync(app, c, g.Booking.Id), s => Assert.Null(s.CheckedInAt));

        Assert.Equal(HttpStatusCode.OK, (await device.SendAsync(c.Events(c.BoxMac, 2, "activation", 1, c.Code(c.Pam)))).StatusCode);
        var seats = await SeatsOfAsync(app, c, g.Booking.Id);
        Assert.NotNull(seats.Single(s => s.UserId == c.Pam && s.Status == ParticipantStatus.Accepted).CheckedInAt);
        Assert.NotNull((await c.ReadAsync(app, db => db.Bookings.IgnoreQueryFilters().SingleAsync(b => b.Id == g.Booking.Id))).CheckedInAt);
    }

    [SkippableFact]
    public async Task Pay_for_at_the_box_refuses_a_split_booking_and_a_declined_seat_does_not_make_one_split()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        var clock = new PinnedClock();
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService(), clock);
        var g = await SplitGameAsync(app, "seampay");
        var c = g.Club;
        var device = app.CreateClient();
        var sid = await c.BalanceAsync(app, c.Sid);

        var split = await (await device.SendAsync(c.PayFor(c.Code(c.Sid, at: clock.Now), 2, Nonce, confirm: false))).Content.ReadAsStringAsync();
        Assert.Equal("""{"payable":false,"reason":"split_booking","court_number":2}""", split);
        var confirm = await (await device.SendAsync(c.PayFor(c.Code(c.Sid, at: clock.Now, stepOffset: -1), 2, Nonce, confirm: true, label: "32"))).Content.ReadAsStringAsync();
        Assert.Contains("\"reason\":\"split_booking\"", confirm);

        // A legacy ident code reaches the same refusal: the seam decides, not the credential.
        var ident = new AccessCode
        {
            TenantId = c.TenantId,
            Code = AccessCodeService.NewCode(),
            Purpose = AccessCodePurpose.MemberIdent,
            UserId = c.Sid,
            ExpiresAt = DateTimeOffset.UtcNow.AddMinutes(5),
        };
        await c.WriteAsync(app, db => { db.AccessCodes.Add(ident); return Task.CompletedTask; });
        Assert.Contains("split_booking", await (await device.SendAsync(c.PayFor(ident.Code, 2, "1212121212121212", confirm: false))).Content.ReadAsStringAsync());
        Assert.Equal(sid, await c.BalanceAsync(app, c.Sid));

        // Court 3: a partner who DECLINED, share and all, is not a split — the box may quote it (to
        // Pam, who is on court 2's game and not this one).
        var other = await c.BookAsync(app, c.Olga, courtIndex: 2, startsInMinutes: -5);
        await SeatsAsync(app, c, other.Id, (1, c.Olga, ParticipantStatus.Accepted, 24), (2, g.Declined, ParticipantStatus.Declined, 8));
        var quote = JsonDocument.Parse(await (await device.SendAsync(c.PayFor(c.Code(c.Pam, at: clock.Now), 3, "3434343434343434", confirm: false))).Content.ReadAsStringAsync()).RootElement;
        Assert.True(quote.GetProperty("payable").GetBoolean());
    }

    [SkippableFact]
    public async Task A_partner_is_on_the_v1_roster_when_her_organiser_is_suspended_and_the_organiser_is_not()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var c = await MemberCodeClub.SeedAsync(app, "seambarred");
        var booking = await c.BookAsync(app, c.Sid, courtIndex: 1, startsInMinutes: -5);
        await SeatsAsync(app, c, booking.Id, (1, c.Sid, ParticipantStatus.Accepted, 24), (2, c.Pam, ParticipantStatus.Accepted, 8));
        await c.WriteAsync(app, async db =>
            (await db.Memberships.IgnoreQueryFilters().SingleAsync(m => m.Id == c.SidMembership)).Status = MembershipStatus.Suspended);
        await c.SetPhaseAsync(app, MemberCodeSettings.V1);
        var device = app.CreateClient();

        var pam = MemberCodeMath.RefText(c.Refs[c.Pam]);
        var box = await BeatAsync(device, c, c.BoxMac, kind: null);
        Assert.StartsWith($"m{pam}|1|", Assert.Single(box.GetProperty("roster").EnumerateArray()).GetString());
        var door = await BeatAsync(device, c, c.DoorMac, kind: "gate");
        Assert.StartsWith($"m{pam}|", Assert.Single(door.GetProperty("roster").EnumerateArray()).GetString());

        // …and the LEGACY roster, which names the booking by the organiser's own code, still does not.
        await c.SetPhaseAsync(app, MemberCodeSettings.Legacy);
        Assert.Empty((await BeatAsync(device, c, c.BoxMac, kind: null, m1: false)).GetProperty("roster").EnumerateArray());
    }

    // ---- Helpers ----------------------------------------------------------------------------------

    private static async Task<JsonElement> BeatAsync(HttpClient device, MemberCodeClub club, string mac, string? kind, bool m1 = true)
    {
        var response = await device.SendAsync(club.Heartbeat(mac, m1, kind));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.Clone();
    }

    /// <summary>One more active member of the club, with a member-code REF of their own.</summary>
    private static async Task<Guid> MemberAsync(WebApplicationFactory<Program> app, MemberCodeClub club, string handle)
    {
        var user = new User
        {
            TenantId = club.TenantId,
            Email = $"{handle}-{club.Slug}@test.local",
            PasswordHash = new Pbkdf2PasswordHasher().Hash("OldPass!123"),
            EmailVerified = true,
        };
        var used = club.Refs.Values.ToHashSet();
        var reference = Enumerable.Range(0, 64).Select(_ => Random.Shared.Next(1, MemberCodeMath.MaxRefValue)).First(r => !used.Contains(r));
        await club.WriteAsync(app, db =>
        {
            db.Users.Add(user);
            db.Memberships.Add(new Membership
            {
                TenantId = club.TenantId,
                UserId = user.Id,
                FullName = $"{handle} Player",
                MembershipNumber = $"{handle}-{club.Slug}",
                Status = MembershipStatus.Active,
            });
            db.MemberCodes.Add(new MemberCode { TenantId = club.TenantId, UserId = user.Id, Ref = reference });
            return Task.CompletedTask;
        });
        club.Refs[user.Id] = reference;
        return user.Id;
    }

    private static Task SeatsAsync(
        WebApplicationFactory<Program> app, MemberCodeClub club, Guid bookingId,
        params (int Seat, Guid User, ParticipantStatus Status, int Share)[] seats) =>
        club.WriteAsync(app, db =>
        {
            var now = DateTimeOffset.UtcNow;
            foreach (var (seat, user, status, share) in seats)
            {
                db.BookingParticipants.Add(new BookingParticipant
                {
                    TenantId = club.TenantId,
                    BookingId = bookingId,
                    Seat = seat,
                    UserId = user,
                    Status = status,
                    ShareMinutes = share,
                    ConsentedMinutes = status == ParticipantStatus.Accepted && seat > 1 ? share : 0,
                    ShareWeight = 1,
                    SplitMode = seat == 1 ? SplitModes.Equal : null,
                    InvitedAt = now,
                    CreatedAt = now,
                    UpdatedAt = now,
                    RespondedAt = status == ParticipantStatus.Invited ? null : now,
                });
            }
            return Task.CompletedTask;
        });

    private static Task<List<BookingParticipant>> SeatsOfAsync(WebApplicationFactory<Program> app, MemberCodeClub club, Guid bookingId) =>
        club.ReadAsync(app, db => db.BookingParticipants.IgnoreQueryFilters().AsNoTracking()
            .Where(p => p.BookingId == bookingId).OrderBy(p => p.Seat).ToListAsync());
}
