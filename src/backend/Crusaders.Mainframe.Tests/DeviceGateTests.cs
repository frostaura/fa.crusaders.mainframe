using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The door gate's two decisions, driven directly: who gets in, and what the gate is told to
/// cache so it can decide for itself when the network is gone.
///
/// <para>
/// Both are money-adjacent in the way the roster is — a member refused at a door they have
/// paid to be behind is a complaint, and a door that opens for a suspended member is the
/// thing the suspension was for — but neither moves any. That is itself pinned here: the
/// closing tests assert that an open leaves <c>CheckedInAt</c> and the ledger exactly as it
/// found them, because "a door is not attendance" is a sentence the product will be tempted
/// to break the first time somebody wants entry statistics.
/// </para>
///
/// <para>
/// <b>Every clock is threaded, never read.</b> <c>GateContext.Now</c> and
/// <c>BuildAsync</c>'s <c>now</c> are the only instants these tests use, so nothing here can
/// pass at 09:00 and fail at 23:45 — the trap <c>memory/gotchas.md</c> records six live tests
/// falling into. The window-edge cases below are measured in minutes either side of a
/// booking, which is exactly the shape that goes wrong when a wall clock leaks in.
/// </para>
/// </summary>
public class DeviceGateTests
{
    private sealed record Fixture(
        TestHost Host, IServiceScope Scope, MainframeDbContext Db, AccessCodeService Codes, TenantSettingsView Settings);

    private static async Task<Fixture> CreateAsync(string? sharedDb = null, string? slug = null)
    {
        var host = await TestHost.CreateAsync(slug, sharedDb);
        var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var codes = scope.ServiceProvider.GetRequiredService<AccessCodeService>();
        var settings = await scope.ServiceProvider.GetRequiredService<TenantSettingsAccessor>().GetAsync(default);
        return new Fixture(host, scope, db, codes, settings);
    }

    /// <summary>
    /// A gate row as auto-registration leaves one: no courts, no button map, a name an admin
    /// has given it.
    /// </summary>
    private static Device GateOn(Fixture f, string? gateKey = "front-door") => new()
    {
        TenantId = f.Host.Tenant.Id,
        DeviceCode = "gate-0a1b2c",
        Name = "Door gate",
        Kind = DeviceKind.Gate,
        Hardware = DeviceHardware.Esp32,
        MacAddress = "ff0000000101",
        CourtNumbers = [],
        GateKey = gateKey,
    };

    /// <summary>
    /// The settings a club runs its doors on, varied one field at a time. Written as a
    /// <c>with</c> over the fixture's own view rather than a fresh construction, because
    /// nothing in this repository constructs <c>TenantSettingsView</c> directly and the
    /// init-only pattern is what keeps that true.
    /// </summary>
    private static TenantSettingsView Policy(
        Fixture f, string policy, int unlockSeconds = 3, int earlyEntryMinutes = 30) =>
        f.Settings with
        {
            GateAccessPolicy = policy,
            GateUnlockSeconds = unlockSeconds,
            GateEarlyEntryMinutes = earlyEntryMinutes,
        };

    /// <summary>
    /// A charged booking written straight to the table, so the clock can be placed anywhere
    /// without meeting the peak, operating-hours and advance-booking rules that belong to
    /// <c>BookingService</c> and have nothing to do with a door.
    /// </summary>
    private static async Task<Booking> BookAsync(
        Fixture f, Court court, DateTimeOffset startsAt, int minutes = 45, Guid? userId = null)
    {
        var booking = new Booking
        {
            TenantId = f.Host.Tenant.Id,
            CourtId = court.Id,
            UserId = userId ?? f.Host.PlayerUser.Id,
            BookedByUserId = userId ?? f.Host.PlayerUser.Id,
            PaidByUserId = userId ?? f.Host.PlayerUser.Id,
            ActorUserId = userId ?? f.Host.PlayerUser.Id,
            StartsAt = startsAt,
            EndsAt = startsAt.AddMinutes(minutes),
            SliceMinutes = 15,
            SliceCount = Math.Max(1, minutes / 15),
            AmountChargedCredits = 8m * Math.Max(1, minutes / 15),
            Status = BookingStatus.Booked,
            ChargedAt = startsAt,
        };
        f.Db.Bookings.Add(booking);
        await f.Db.SaveChangesAsync();
        return booking;
    }

    private static async Task<string> IdentCodeAsync(Fixture f, Guid userId, DateTimeOffset expiresAt)
    {
        var code = new AccessCode
        {
            TenantId = f.Host.Tenant.Id,
            Code = AccessCodeService.NewCode(),
            Purpose = AccessCodePurpose.MemberIdent,
            UserId = userId,
            ExpiresAt = expiresAt,
        };
        f.Db.AccessCodes.Add(code);
        await f.Db.SaveChangesAsync();
        return code.Code;
    }

    private static async Task SetMembershipAsync(Fixture f, Guid userId, MembershipStatus? status)
    {
        var row = await f.Db.Memberships.FirstOrDefaultAsync(m => m.UserId == userId);
        if (status is null)
        {
            if (row is not null) f.Db.Memberships.Remove(row);
        }
        else
        {
            row!.Status = status.Value;
        }
        await f.Db.SaveChangesAsync();
    }

    private static Task<GateDecision> DecideAsync(
        Fixture f, Device gate, TenantSettingsView settings, string? token,
        DateTimeOffset now, string method = "qr") =>
        GateAccess.DecideAsync(f.Db, f.Codes, new GateContext(gate, settings, method, token, now), default);

    private static Task<List<string>> RosterAsync(Fixture f, TenantSettingsView settings, DateTimeOffset now) =>
        DeviceGateRosterBuilder.BuildAsync(f.Db, f.Codes, settings, now, default);

    private static string TokenOf(string entry) => entry.Split('|')[0];
    private static int RelayOf(string entry) => int.Parse(entry.Split('|')[1]);
    private static long OpensInOf(string entry) => long.Parse(entry.Split('|')[2]);
    private static long ClosesInOf(string entry) => long.Parse(entry.Split('|')[3]);

    private static async Task<string> CodeOfAsync(Fixture f, Booking booking) =>
        (await f.Db.AccessCodes.AsNoTracking().FirstAsync(c => c.BookingId == booking.Id)).Code;

    /// <summary>
    /// The booking's activation code, minted the way the product mints it. The roster mints
    /// these lazily, so a booking written straight to the table has none until something asks
    /// — which is why a test that wants one has to say so.
    /// </summary>
    private static async Task<string> BookingCodeAsync(Fixture f, Booking booking) =>
        (await f.Codes.MintForBookingAsync(booking, TimeSpan.FromMinutes(f.Settings.GraceWindowMinutes), default)).Code;

    // ---- Who gets in: the active_member policy (the default) ------------------

    /// <summary>
    /// The default policy: any member the club has approved, booking or not. This is the
    /// first surface in the product where an active membership on its own is sufficient for
    /// anything, so it is worth stating outright rather than inferring from the absence of a
    /// booking check.
    /// </summary>
    [Fact]
    public async Task Under_the_default_policy_an_active_member_with_no_booking_opens_the_door()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var now = DateTimeOffset.UtcNow;
        var token = await IdentCodeAsync(f, f.Host.PlayerUser.Id, now.AddMinutes(1));

        var decision = await DecideAsync(f, GateOn(f), Policy(f, GateAccessPolicies.ActiveMember), token, now);

        Assert.True(decision.Opened);
        Assert.Equal(GateAccess.Ok, decision.Reason);
        Assert.Equal(f.Host.PlayerUser.Id, decision.SubjectUserId);
        Assert.Equal(3, decision.UnlockSeconds);
        Assert.Empty(await f.Db.Bookings.ToListAsync());
    }

    /// <summary>
    /// Not-Active rather than Suspended, on a door as on a court:
    /// <c>PendingApproval</c> and <c>Rejected</c> are barred too, and the reason is named
    /// rather than folded into <c>not_recognised</c> so the desk can read it back.
    /// </summary>
    [Theory]
    [InlineData(MembershipStatus.Suspended)]
    [InlineData(MembershipStatus.Rejected)]
    [InlineData(MembershipStatus.PendingApproval)]
    public async Task A_member_the_club_has_not_approved_is_refused_by_name(MembershipStatus status)
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var now = DateTimeOffset.UtcNow;
        var token = await IdentCodeAsync(f, f.Host.PlayerUser.Id, now.AddMinutes(1));
        await SetMembershipAsync(f, f.Host.PlayerUser.Id, status);

        var decision = await DecideAsync(f, GateOn(f), Policy(f, GateAccessPolicies.ActiveMember), token, now);

        Assert.False(decision.Opened);
        Assert.Equal(GateAccess.MemberNotActive, decision.Reason);
        Assert.Equal(0, decision.UnlockSeconds);

        // Still named, because the audit row's whole value is saying who was turned away.
        Assert.Equal(f.Host.PlayerUser.Id, decision.SubjectUserId);
    }

    /// <summary>
    /// A user with no membership row at all is not barred. The test
    /// <see cref="MembershipAccess"/> applies is "the club has recorded a decision about this
    /// person, and it was not approval" — and it has recorded none. Note that this is the
    /// BARRED check only: whether such a user then gets through a door is the policy's
    /// question, and under <c>booking_window</c> the answer is no unless they are a club
    /// admin.
    /// </summary>
    [Fact]
    public async Task A_user_with_no_membership_row_is_not_barred()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var now = DateTimeOffset.UtcNow;
        var token = await IdentCodeAsync(f, f.Host.PlayerUser.Id, now.AddMinutes(1));
        await SetMembershipAsync(f, f.Host.PlayerUser.Id, null);

        var decision = await DecideAsync(f, GateOn(f), Policy(f, GateAccessPolicies.ActiveMember), token, now);
        Assert.True(decision.Opened);
    }

    /// <summary>
    /// Unknown, expired and malformed all answer the same thing, on purpose: a door that
    /// distinguished them would be an oracle for which codes are real, and there is nobody
    /// standing at a door to be told anything more useful.
    /// </summary>
    [Fact]
    public async Task An_unknown_or_expired_code_is_not_recognised_and_names_nobody()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var now = DateTimeOffset.UtcNow;
        var settings = Policy(f, GateAccessPolicies.ActiveMember);

        // Live one minute ago, dead now. The same code, one minute apart, is the whole test:
        // a fixture that only tried a code that never existed would not discriminate the
        // expiry check at all.
        var expired = await IdentCodeAsync(f, f.Host.PlayerUser.Id, now.AddMinutes(-1));
        Assert.True((await DecideAsync(f, GateOn(f), settings, expired, now.AddMinutes(-2))).Opened);

        foreach (var token in new[] { expired, "ZZZZZZZZZZZZ", "TOOSHORT", "", null })
        {
            var decision = await DecideAsync(f, GateOn(f), settings, token, now);
            Assert.False(decision.Opened);
            Assert.Equal(GateAccess.NotRecognised, decision.Reason);
            Assert.Null(decision.SubjectUserId);
        }
    }

    /// <summary>
    /// A PIN against the whole membership roll is an oracle, not an identification, and
    /// unlike a court there is no candidate set at a door to check one against. Refused
    /// before the code table is touched, so an unsupported method cannot be used to probe it.
    /// </summary>
    [Theory]
    [InlineData("pin")]
    [InlineData("biometric")]
    [InlineData("")]
    [InlineData(null)]
    public async Task Only_a_method_that_identifies_globally_is_accepted(string? method)
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var now = DateTimeOffset.UtcNow;
        var token = await IdentCodeAsync(f, f.Host.PlayerUser.Id, now.AddMinutes(1));

        var decision = await DecideAsync(
            f, GateOn(f), Policy(f, GateAccessPolicies.ActiveMember), token, now, method!);

        Assert.False(decision.Opened);
        Assert.Equal(GateAccess.MethodNotSupported, decision.Reason);
        Assert.Null(decision.SubjectUserId);
    }

    /// <summary>The two methods that do identify globally both work, typed or scanned.</summary>
    [Theory]
    [InlineData("qr")]
    [InlineData("code")]
    [InlineData("QR")]
    public async Task A_code_read_or_typed_identifies(string method)
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var now = DateTimeOffset.UtcNow;
        var token = await IdentCodeAsync(f, f.Host.PlayerUser.Id, now.AddMinutes(1));

        Assert.True((await DecideAsync(
            f, GateOn(f), Policy(f, GateAccessPolicies.ActiveMember), token, now, method)).Opened);
    }

    // ---- Who gets in: the booking_window policy ------------------------------

    /// <summary>
    /// <c>booking_window</c> opens the door <c>gate_early_entry_minutes</c> before the slot
    /// and shuts it at the end, and the two edges are checked a minute either side.
    ///
    /// <para>
    /// A minute rather than a second because the arithmetic is in minutes; a test that moved
    /// the clock by a second would pass against an implementation that had the comparison
    /// inverted for a whole minute at a time.
    /// </para>
    /// </summary>
    [Theory]
    [InlineData(-31, false)]   // a minute before the entry window opens
    [InlineData(-30, true)]    // the instant it opens
    [InlineData(-29, true)]
    [InlineData(0, true)]      // the slot starts
    [InlineData(44, true)]     // a minute before it ends
    [InlineData(45, true)]     // the instant it ends
    [InlineData(46, false)]    // a minute after
    public async Task The_booking_window_opens_at_early_entry_and_shuts_at_the_slots_end(
        int minutesFromStart, bool opens)
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        // One anchor for the whole test, so the two edges are measured against each other
        // rather than against whatever the clock said when each line ran.
        var startsAt = DateTimeOffset.UtcNow.AddHours(3);
        var now = startsAt.AddMinutes(minutesFromStart);

        await BookAsync(f, f.Host.Courts[0], startsAt);
        var token = await IdentCodeAsync(f, f.Host.PlayerUser.Id, now.AddMinutes(1));

        var decision = await DecideAsync(
            f, GateOn(f), Policy(f, GateAccessPolicies.BookingWindow, earlyEntryMinutes: 30), token, now);

        Assert.Equal(opens, decision.Opened);
        Assert.Equal(opens ? GateAccess.Ok : GateAccess.NoBooking, decision.Reason);
        Assert.Equal(f.Host.PlayerUser.Id, decision.SubjectUserId);
    }

    /// <summary>
    /// The edge really is the SETTING and not a hardcoded thirty. Same booking, same clock,
    /// one field of the club's configuration different — which is the probe that would have
    /// caught the number being baked into the query.
    /// </summary>
    [Fact]
    public async Task The_entry_window_is_the_clubs_setting_and_not_a_constant()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var startsAt = DateTimeOffset.UtcNow.AddHours(3);
        var now = startsAt.AddMinutes(-45);
        await BookAsync(f, f.Host.Courts[0], startsAt);
        var token = await IdentCodeAsync(f, f.Host.PlayerUser.Id, now.AddMinutes(1));

        Assert.False((await DecideAsync(
            f, GateOn(f), Policy(f, GateAccessPolicies.BookingWindow, earlyEntryMinutes: 30), token, now)).Opened);
        Assert.True((await DecideAsync(
            f, GateOn(f), Policy(f, GateAccessPolicies.BookingWindow, earlyEntryMinutes: 60), token, now)).Opened);

        // And zero means zero: the member waits for their slot.
        Assert.False((await DecideAsync(
            f, GateOn(f), Policy(f, GateAccessPolicies.BookingWindow, earlyEntryMinutes: 0), token, now)).Opened);
    }

    /// <summary>
    /// Any court of the club. A door is not on a court, and the member walking through the
    /// front door has not chosen one yet — so a booking on a court no gate could be said to
    /// belong to still lets them in.
    /// </summary>
    [Fact]
    public async Task A_booking_on_any_court_opens_the_door()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var court5 = new Court { TenantId = f.Host.Tenant.Id, CourtNumber = 5, Name = "Court 5", SlicePriceCredits = 8m };
        f.Db.Courts.Add(court5);
        await f.Db.SaveChangesAsync();

        var now = DateTimeOffset.UtcNow;
        await BookAsync(f, court5, now.AddMinutes(5));
        var token = await IdentCodeAsync(f, f.Host.PlayerUser.Id, now.AddMinutes(1));

        Assert.True((await DecideAsync(
            f, GateOn(f), Policy(f, GateAccessPolicies.BookingWindow), token, now)).Opened);
    }

    /// <summary>
    /// Only a <c>Booked</c> booking. A cancelled slot is not a reason to be in the building,
    /// and an <c>AdminBlock</c> is not a member's booking at all.
    /// </summary>
    [Theory]
    [InlineData(BookingStatus.Cancelled)]
    [InlineData(BookingStatus.NoShow)]
    [InlineData(BookingStatus.Completed)]
    [InlineData(BookingStatus.AdminBlock)]
    public async Task A_booking_that_is_not_live_does_not_open_the_door(BookingStatus status)
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var now = DateTimeOffset.UtcNow;
        var booking = await BookAsync(f, f.Host.Courts[0], now.AddMinutes(5));
        var token = await IdentCodeAsync(f, f.Host.PlayerUser.Id, now.AddMinutes(1));
        var settings = Policy(f, GateAccessPolicies.BookingWindow);

        // The control: it opens while the row is Booked. Without this the test would pass
        // against an implementation that never opens for anybody.
        Assert.True((await DecideAsync(f, GateOn(f), settings, token, now)).Opened);

        booking.Status = status;
        await f.Db.SaveChangesAsync();

        var decision = await DecideAsync(f, GateOn(f), settings, token, now);
        Assert.False(decision.Opened);
        Assert.Equal(GateAccess.NoBooking, decision.Reason);
    }

    /// <summary>
    /// <b>Club admins always pass the booking check</b>, membership row or not — a club that
    /// switches to <c>booking_window</c> must not lock its own staff out of the building.
    ///
    /// <para>
    /// The exemption is keyed on <c>User.IsAdmin</c>. It used to be keyed on the ABSENCE of a
    /// membership row, which is a state no production path creates: every account that reaches
    /// a door has one, and the only reason the old test passed was that it deleted the row
    /// first. A fixture production cannot produce is not evidence, so the rule it was
    /// defending — "staff can get in" — was in fact enforced for nobody, and the club's own
    /// admins were locked out the day it switched policy.
    /// </para>
    ///
    /// <para>
    /// The four rows vary exactly two fields, and three of them are the probe: flip
    /// <c>isAdmin</c> and the same fixture must refuse, so this cannot pass against an
    /// implementation that lets everybody through, and flip the membership row and an admin
    /// must still pass, so it cannot pass against the old rule either.
    /// </para>
    /// </summary>
    [Theory]
    [InlineData(true, true, true)]      // a club admin who is also a member: in
    [InlineData(true, false, true)]     // a club admin with no membership row: in
    [InlineData(false, true, false)]    // an ordinary member with nothing booked: out
    [InlineData(false, false, false)]   // no membership row is not itself a way in
    public async Task A_club_admin_passes_the_booking_check_and_nobody_else_does(
        bool isAdmin, bool holdsMembership, bool opens)
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var now = DateTimeOffset.UtcNow;
        var user = isAdmin ? f.Host.AdminUser : f.Host.PlayerUser;
        var token = await IdentCodeAsync(f, user.Id, now.AddMinutes(1));
        if (!holdsMembership) await SetMembershipAsync(f, user.Id, null);

        var decision = await DecideAsync(f, GateOn(f), Policy(f, GateAccessPolicies.BookingWindow), token, now);

        Assert.Equal(opens, decision.Opened);
        Assert.Equal(opens ? GateAccess.Ok : GateAccess.NoBooking, decision.Reason);
        Assert.Equal(user.Id, decision.SubjectUserId);
    }

    /// <summary>
    /// An admin is still held to the membership check exactly as everybody else is. The
    /// carve-out is on the BOOKING check and nothing else: a club that suspends an admin's
    /// membership has said something about that person, and a door is not where it gets
    /// quietly undone.
    /// </summary>
    [Theory]
    [InlineData(GateAccessPolicies.ActiveMember)]
    [InlineData(GateAccessPolicies.BookingWindow)]
    public async Task A_suspended_club_admin_is_refused_by_name_under_either_policy(string policy)
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var now = DateTimeOffset.UtcNow;
        var token = await IdentCodeAsync(f, f.Host.AdminUser.Id, now.AddMinutes(1));

        // The control: Active, and the admin walks in under either policy.
        Assert.True((await DecideAsync(f, GateOn(f), Policy(f, policy), token, now)).Opened);

        await SetMembershipAsync(f, f.Host.AdminUser.Id, MembershipStatus.Suspended);

        var decision = await DecideAsync(f, GateOn(f), Policy(f, policy), token, now);
        Assert.False(decision.Opened);
        Assert.Equal(GateAccess.MemberNotActive, decision.Reason);
    }

    /// <summary>
    /// A member with neither a membership row nor a booking is still refused. The staff
    /// carve-out is for club admins, and "no membership row" on its own must not become a
    /// way in.
    /// </summary>
    [Fact]
    public async Task A_non_admin_with_no_membership_and_no_booking_is_still_refused()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var now = DateTimeOffset.UtcNow;
        await SetMembershipAsync(f, f.Host.PlayerUser.Id, null);
        var token = await IdentCodeAsync(f, f.Host.PlayerUser.Id, now.AddMinutes(1));

        var decision = await DecideAsync(f, GateOn(f), Policy(f, GateAccessPolicies.BookingWindow), token, now);
        Assert.False(decision.Opened);
        Assert.Equal(GateAccess.NoBooking, decision.Reason);
    }

    /// <summary>
    /// A booking-activation code opens the door for the booking it names even when an admin
    /// made that booking on somebody else's behalf — the code IS the member's proof that the
    /// slot is theirs to walk in for.
    /// </summary>
    [Fact]
    public async Task A_booking_code_opens_the_door_for_the_booking_it_names()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var now = DateTimeOffset.UtcNow;

        // The booking belongs to the league player; the code is minted against the admin who
        // made it, so a UserId match alone would not find it.
        var booking = await BookAsync(f, f.Host.Courts[0], now.AddMinutes(5), userId: f.Host.LeaguePlayerUser.Id);
        f.Db.AccessCodes.Add(new AccessCode
        {
            TenantId = f.Host.Tenant.Id,
            Code = AccessCodeService.NewCode(),
            Purpose = AccessCodePurpose.BookingActivation,
            UserId = f.Host.AdminUser.Id,
            BookingId = booking.Id,
            ExpiresAt = booking.EndsAt.AddMinutes(5),
        });
        await f.Db.SaveChangesAsync();
        await SetMembershipAsync(f, f.Host.AdminUser.Id, MembershipStatus.Active);

        var token = await CodeOfAsync(f, booking);
        Assert.True((await DecideAsync(
            f, GateOn(f), Policy(f, GateAccessPolicies.BookingWindow), token, now)).Opened);
    }

    // ---- A booking code is not a standing building key -----------------------

    /// <summary>
    /// <b>Under EVERY policy, a booking's own code opens a door only inside that booking's
    /// window</b> — from <c>StartsAt − H</c> until <c>EndsAt</c>, where <c>H</c> is
    /// <see cref="BookingCodeWindow.DoorHorizonMinutes"/>.
    ///
    /// <para>
    /// The code lives until the slot ends plus the grace window and is a stable token for the
    /// whole of it, so before this the code the member's phone showed them at 17:00 for a
    /// 19:00 court opened every door in the club at 03:00 the same night, under the default
    /// policy, for as long as the row survived. A captured roster bought a building key rather
    /// than an entry to one booking.
    /// </para>
    ///
    /// <para>
    /// Both edges of both horizons, a minute either side. A minute rather than a second
    /// because the arithmetic is in minutes: a second-wide probe passes against a comparison
    /// that is inverted for a whole minute at a time.
    /// </para>
    ///
    /// <para>
    /// The two reasons are not the same and the asymmetry is deliberate. Early is
    /// <c>too_early</c> — the member has a valid booking and the door will honour it later.
    /// Late is <c>not_recognised</c>, indistinguishable from a code that never existed,
    /// because between <c>EndsAt</c> and <c>EndsAt + grace</c> the row is still live and a
    /// door that told "spent" from "unknown" would be the oracle every other refusal here is
    /// written to avoid.
    /// </para>
    /// </summary>
    [Theory]
    // active_member: H = max(30, roster 120 + cue 10) = 130 minutes.
    [InlineData(GateAccessPolicies.ActiveMember, -131, false, GateAccess.TooEarly)]
    [InlineData(GateAccessPolicies.ActiveMember, -130, true, GateAccess.Ok)]
    [InlineData(GateAccessPolicies.ActiveMember, -30, true, GateAccess.Ok)]
    [InlineData(GateAccessPolicies.ActiveMember, 44, true, GateAccess.Ok)]
    [InlineData(GateAccessPolicies.ActiveMember, 45, true, GateAccess.Ok)]
    [InlineData(GateAccessPolicies.ActiveMember, 46, false, GateAccess.NotRecognised)]
    // booking_window: H = gate_early_entry_minutes = 30.
    [InlineData(GateAccessPolicies.BookingWindow, -131, false, GateAccess.TooEarly)]
    [InlineData(GateAccessPolicies.BookingWindow, -31, false, GateAccess.TooEarly)]
    [InlineData(GateAccessPolicies.BookingWindow, -30, true, GateAccess.Ok)]
    [InlineData(GateAccessPolicies.BookingWindow, 44, true, GateAccess.Ok)]
    [InlineData(GateAccessPolicies.BookingWindow, 45, true, GateAccess.Ok)]
    [InlineData(GateAccessPolicies.BookingWindow, 46, false, GateAccess.NotRecognised)]
    public async Task A_booking_code_opens_a_door_only_inside_its_own_bookings_window(
        string policy, int minutesFromStart, bool opens, string reason)
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        // One anchor for the whole test, so the edges are measured against each other rather
        // than against whatever the clock said when each line ran.
        var startsAt = DateTimeOffset.UtcNow.AddHours(6);
        var now = startsAt.AddMinutes(minutesFromStart);

        var booking = await BookAsync(f, f.Host.Courts[0], startsAt);
        var token = await BookingCodeAsync(f, booking);

        // The code itself is still live at every row here — it lives until EndsAt + grace (5)
        // — so a refusal at +46 is this rule and not plain expiry.
        Assert.True(
            (await f.Db.AccessCodes.AsNoTracking().FirstAsync(c => c.Code == token)).IsLiveAt(now),
            "the fixture must present a LIVE code, or the late rows would be testing expiry");

        var decision = await DecideAsync(f, GateOn(f), Policy(f, policy), token, now);

        Assert.Equal(opens, decision.Opened);
        Assert.Equal(reason, decision.Reason);
        Assert.Equal(f.Host.PlayerUser.Id, decision.SubjectUserId);
    }

    /// <summary>
    /// A sixty-second <see cref="AccessCodePurpose.MemberIdent"/> code is untouched by any of
    /// it: it names no booking, so it has no window of its own to be outside. Under
    /// <c>active_member</c> it opens at any hour, and under <c>booking_window</c> it still
    /// needs a qualifying booking and still answers <c>no_booking</c> without one.
    ///
    /// <para>
    /// This is the probe on the rule above. Vary ONLY the code's purpose — same member, same
    /// clock, same booking six hours out — and the refusal changes from <c>too_early</c> to
    /// the policy's own answer, which is what says the new gate is scoped to booking codes
    /// rather than applied to everything that resolves.
    /// </para>
    /// </summary>
    [Fact]
    public async Task An_ident_code_has_no_booking_window_of_its_own()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var now = DateTimeOffset.UtcNow;
        var booking = await BookAsync(f, f.Host.Courts[0], now.AddHours(6));
        var ident = await IdentCodeAsync(f, f.Host.PlayerUser.Id, now.AddMinutes(1));

        Assert.True((await DecideAsync(
            f, GateOn(f), Policy(f, GateAccessPolicies.ActiveMember), ident, now)).Opened);

        var underBookingWindow = await DecideAsync(
            f, GateOn(f), Policy(f, GateAccessPolicies.BookingWindow), ident, now);
        Assert.False(underBookingWindow.Opened);
        Assert.Equal(GateAccess.NoBooking, underBookingWindow.Reason);

        // …and the SAME member at the SAME instant, presenting that booking's own code
        // instead, is refused for being early rather than for having nothing booked.
        var bookingCode = await BookingCodeAsync(f, booking);
        Assert.Equal(GateAccess.TooEarly, (await DecideAsync(
            f, GateOn(f), Policy(f, GateAccessPolicies.BookingWindow), bookingCode, now)).Reason);
    }

    /// <summary>
    /// A booking that is no longer <c>Booked</c> has a live code and no door behind it. The
    /// <see cref="AccessCode"/> row outlives a cancellation — nothing revokes it, because
    /// revoking on cancel would break a court box deciding offline from a roster fetched
    /// before it — so the check has to be on the booking rather than on the code.
    ///
    /// <para>
    /// Under both policies, because under <c>active_member</c> there was no booking check at
    /// all: a member who cancelled their 19:00 court kept a code that opened the building
    /// until the row was pruned.
    /// </para>
    /// </summary>
    [Theory]
    [InlineData(GateAccessPolicies.ActiveMember, BookingStatus.Cancelled)]
    [InlineData(GateAccessPolicies.ActiveMember, BookingStatus.NoShow)]
    [InlineData(GateAccessPolicies.ActiveMember, BookingStatus.Completed)]
    [InlineData(GateAccessPolicies.BookingWindow, BookingStatus.Cancelled)]
    [InlineData(GateAccessPolicies.BookingWindow, BookingStatus.NoShow)]
    [InlineData(GateAccessPolicies.BookingWindow, BookingStatus.Completed)]
    public async Task A_booking_code_for_a_booking_that_is_no_longer_booked_opens_nothing(
        string policy, BookingStatus status)
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var now = DateTimeOffset.UtcNow;
        var booking = await BookAsync(f, f.Host.Courts[0], now.AddMinutes(5));
        var token = await BookingCodeAsync(f, booking);
        var settings = Policy(f, policy);

        // The control: inside its own window and still Booked, it opens. Without this the
        // assertion below would hold against an implementation that refuses everybody.
        Assert.True((await DecideAsync(f, GateOn(f), settings, token, now)).Opened);

        booking.Status = status;
        await f.Db.SaveChangesAsync();

        var decision = await DecideAsync(f, GateOn(f), settings, token, now);
        Assert.False(decision.Opened);
        Assert.Equal(GateAccess.NotRecognised, decision.Reason);

        // The code is still live; it is the booking behind it that is gone.
        Assert.True((await f.Db.AccessCodes.AsNoTracking().FirstAsync(c => c.Code == token)).IsLiveAt(now));
    }

    /// <summary>
    /// <b>The door's horizon under <c>active_member</c> is the phone's, and the two cannot
    /// drift apart.</b>
    ///
    /// <para>
    /// <c>QrEndpoints</c> decides whether the member's screen shows a booking's code at all,
    /// and this decides whether the door accepts it. Narrower here and the product refuses a
    /// code it has just put on somebody's screen; wider and the code is a standing key again.
    /// They were two independent rearrangements of one predicate in two files, and this walks
    /// a whole day of anchors through BOTH — so a change to either side alone lands here.
    /// </para>
    ///
    /// <para>
    /// The <c>max</c> against the entry window is asserted from the other end: the door must
    /// never be NARROWER than the cached roster, or a club's doors would work better during an
    /// outage than online.
    /// </para>
    /// </summary>
    [Fact]
    public async Task The_doors_horizon_under_the_default_policy_is_the_one_the_phone_shows()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var settings = Policy(f, GateAccessPolicies.ActiveMember);

        Assert.Equal(
            settings.RosterWindowMinutes + settings.ActivationCueWindowMinutes,
            BookingCodeWindow.DisplayHorizonMinutes(settings));
        Assert.Equal(
            BookingCodeWindow.DisplayHorizonMinutes(settings),
            BookingCodeWindow.DoorHorizonMinutes(settings));

        // Online is never narrower than the cached roster, under either policy.
        Assert.True(BookingCodeWindow.DoorHorizonMinutes(settings) >= settings.GateEarlyEntryMinutes);
        Assert.True(BookingCodeWindow.DoorHorizonMinutes(
            Policy(f, GateAccessPolicies.BookingWindow)) >= settings.GateEarlyEntryMinutes);

        // …and a club whose entry window is wider than the phone's horizon keeps the entry
        // window, which is the case the max exists for.
        var generous = Policy(f, GateAccessPolicies.ActiveMember, earlyEntryMinutes: 240);
        Assert.Equal(240, BookingCodeWindow.DoorHorizonMinutes(generous));

        // The predicate itself, at every minute of the UTC day: the rearrangement the door
        // uses and the rearrangement the phone uses are the same function of the same numbers.
        var midnight = new DateTimeOffset(2024, 3, 10, 0, 0, 0, TimeSpan.Zero);
        for (var minute = 0; minute < 1440; minute++)
        {
            var now = midnight.AddMinutes(minute);
            var horizon = BookingCodeWindow.DoorHorizonMinutes(settings);

            Assert.Equal(now.AddMinutes(horizon), BookingCodeWindow.LatestStart(now, horizon));
            Assert.True(BookingCodeWindow.LatestStart(now, horizon)
                >= BookingCodeWindow.LatestStart(now, settings.GateEarlyEntryMinutes));
        }
    }

    // ---- The lock's release --------------------------------------------------

    /// <summary>
    /// The club's <c>gate_unlock_seconds</c> is clamped on the way out, so a value the
    /// settings PUT would have refused — arriving by a hand-edited column, which is the only
    /// other way in — cannot hold a door open for an hour or pulse it shut instantly.
    /// </summary>
    [Theory]
    [InlineData(3, 3)]
    [InlineData(1, 1)]
    [InlineData(30, 30)]
    [InlineData(0, 1)]
    [InlineData(-5, 1)]
    [InlineData(31, 30)]
    [InlineData(86400, 30)]
    public async Task The_release_is_the_clubs_setting_clamped(int configured, int expected)
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var now = DateTimeOffset.UtcNow;
        var token = await IdentCodeAsync(f, f.Host.PlayerUser.Id, now.AddMinutes(1));

        var decision = await DecideAsync(
            f, GateOn(f), Policy(f, GateAccessPolicies.ActiveMember, unlockSeconds: configured), token, now);

        Assert.True(decision.Opened);
        Assert.Equal(expected, decision.UnlockSeconds);
    }

    // ---- What a door must never do ------------------------------------------

    /// <summary>
    /// <b>Walking through a door is not attendance.</b> An open leaves the booking exactly as
    /// it found it — no <c>CheckedInAt</c>, no status change — and posts nothing to the
    /// ledger. This is the sentence the product will be tempted to break the first time
    /// somebody wants entry statistics or "check the member in when they arrive", and it is
    /// wrong for a reason a test can state: the member may be collecting a racquet, coming in
    /// for somebody else's league night, or an hour early for a court they then cancel.
    /// </summary>
    [Fact]
    public async Task An_open_stamps_no_attendance_and_posts_no_ledger_entry()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var now = DateTimeOffset.UtcNow;
        var booking = await BookAsync(f, f.Host.Courts[0], now.AddMinutes(5));
        var ledgerBefore = await f.Db.LedgerEntries.CountAsync();
        var token = await BookingCodeAsync(f, booking);

        var decision = await DecideAsync(f, GateOn(f), Policy(f, GateAccessPolicies.BookingWindow), token, now);
        Assert.True(decision.Opened);

        await f.Db.Entry(booking).ReloadAsync();
        Assert.Null(booking.CheckedInAt);
        Assert.Equal(BookingStatus.Booked, booking.Status);
        Assert.Equal(ledgerBefore, await f.Db.LedgerEntries.CountAsync());
    }

    /// <summary>
    /// Another club's code opens nothing here. The isolation is the context's query filter
    /// rather than a claim compared, and the row really is in the same store — so the
    /// refusal is the filter and not an empty table.
    /// </summary>
    [Fact]
    public async Task Another_clubs_code_is_not_recognised_at_this_clubs_gate()
    {
        var shared = $"crusaders-gate-{Guid.NewGuid():N}";
        var a = await CreateAsync(sharedDb: shared, slug: "club-a");
        var b = await CreateAsync(sharedDb: shared, slug: "club-b");
        await using var _ = a.Host;
        await using var __ = b.Host;
        using var ___ = a.Scope;
        using var ____ = b.Scope;

        var now = DateTimeOffset.UtcNow;
        var tokenB = await IdentCodeAsync(b, b.Host.PlayerUser.Id, now.AddMinutes(1));

        // It works at its own club — otherwise this proves nothing about the filter.
        Assert.True((await DecideAsync(b, GateOn(b), Policy(b, GateAccessPolicies.ActiveMember), tokenB, now)).Opened);

        var atA = await DecideAsync(a, GateOn(a), Policy(a, GateAccessPolicies.ActiveMember), tokenB, now);
        Assert.False(atA.Opened);
        Assert.Equal(GateAccess.NotRecognised, atA.Reason);
        Assert.Null(atA.SubjectUserId);

        // And the row is genuinely there, under the other tenant.
        Assert.NotNull(await a.Db.AccessCodes.IgnoreQueryFilters().FirstOrDefaultAsync(c => c.Code == tokenB));
    }

    // ---- The offline roster --------------------------------------------------

    /// <summary>
    /// Every entry carries relay <c>0</c>, because a door has one lock. The field exists at
    /// all so the element grammar stays identical to the court box's and the firmware's
    /// parser is reused rather than forked.
    /// </summary>
    [Fact]
    public async Task Every_gate_roster_entry_is_on_relay_zero()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var now = DateTimeOffset.UtcNow;
        foreach (var court in f.Host.Courts) await BookAsync(f, court, now.AddMinutes(5));

        var roster = await RosterAsync(f, Policy(f, GateAccessPolicies.ActiveMember), now);

        Assert.Equal(4, roster.Count);
        Assert.All(roster, e => Assert.Equal(DeviceGateRosterBuilder.GateRelay, RelayOf(e)));
        Assert.All(roster, e => Assert.Matches(DeviceProtocolCorpusTests.RosterEntryPattern, e));
    }

    /// <summary>
    /// <c>opens_in</c> counts to <c>StartsAt − gate_early_entry_minutes</c> and goes negative
    /// once the window is open; <c>closes_in</c> counts to <c>EndsAt</c>. Both floored, and
    /// both measured from the instant the response was built rather than from a clock read
    /// somewhere inside — the gate has no RTC and anchors them to the moment it accepted the
    /// response.
    /// </summary>
    [Fact]
    public void The_relative_seconds_are_measured_from_the_response_instant_and_the_entry_window()
    {
        var now = new DateTimeOffset(2023, 11, 14, 22, 13, 20, TimeSpan.Zero);

        Booking At(double startsInMinutes, int minutes) => new()
        {
            TenantId = Guid.NewGuid(),
            CourtId = Guid.NewGuid(),
            StartsAt = now.AddMinutes(startsInMinutes),
            EndsAt = now.AddMinutes(startsInMinutes + minutes),
        };

        var roster = DeviceGateRosterBuilder.Format(
        [
            new DeviceGateRosterBuilder.GateCandidate(At(60, 45), "7Q3F9KM2XZ8B"),
            new DeviceGateRosterBuilder.GateCandidate(At(-20, 45), "K4TQ8N2ZV7BM"),
        ], now, TimeSpan.FromMinutes(30));

        Assert.Equal(
        [
            "K4TQ8N2ZV7BM|0|-3000|1500",   // started 20 min ago: entry opened 50 min ago, 25 min left
            "7Q3F9KM2XZ8B|0|1800|6300",    // starts in 60: entry opens in 30, ends in 105
        ], roster);
    }

    /// <summary>
    /// The arithmetic at every minute of the UTC day.
    ///
    /// <para>
    /// <c>Format</c> is pure, so this costs nothing and closes the failure mode this suite
    /// has been bitten by repeatedly: a relative-time calculation that happens to be right at
    /// the hour the suite ran. 1440 anchors, one per minute, each asserting the same two
    /// identities.
    /// </para>
    /// </summary>
    [Fact]
    public void The_roster_arithmetic_holds_at_every_minute_of_the_day()
    {
        var early = TimeSpan.FromMinutes(30);
        var midnight = new DateTimeOffset(2024, 3, 10, 0, 0, 0, TimeSpan.Zero);

        for (var minute = 0; minute < 1440; minute++)
        {
            var now = midnight.AddMinutes(minute);
            var booking = new Booking
            {
                TenantId = Guid.NewGuid(),
                CourtId = Guid.NewGuid(),
                StartsAt = now.AddMinutes(17),
                EndsAt = now.AddMinutes(62),
            };

            var entry = Assert.Single(DeviceGateRosterBuilder.Format(
                [new DeviceGateRosterBuilder.GateCandidate(booking, "7Q3F9KM2XZ8B")], now, early));

            Assert.Equal(-13 * 60, OpensInOf(entry));
            Assert.Equal(62 * 60, ClosesInOf(entry));
        }
    }

    /// <summary>
    /// Forty-nine bookings in the window: the forty-eight that start first go, the
    /// forty-ninth waits for a later heartbeat. The cap is applied AFTER ordering, which is
    /// the difference between "the earliest forty-eight" and "whichever forty-eight the
    /// database returned first".
    /// </summary>
    [Fact]
    public async Task The_cap_keeps_the_forty_eight_earliest()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var now = DateTimeOffset.UtcNow;
        var settings = Policy(f, GateAccessPolicies.ActiveMember);
        var bookings = new List<Booking>();
        for (var i = 0; i < DeviceGateRosterBuilder.GateRosterMaxEntries + 1; i++)
        {
            bookings.Add(await BookAsync(f, f.Host.Courts[i % 4], now.AddMinutes(1 + (i * 2)), minutes: 5));
        }

        var roster = await RosterAsync(f, settings, now);

        Assert.Equal(DeviceGateRosterBuilder.GateRosterMaxEntries, roster.Count);
        var tokens = roster.Select(TokenOf).ToList();
        Assert.Contains(await CodeOfAsync(f, bookings[0]), tokens);
        Assert.DoesNotContain(await CodeOfOrEmptyAsync(f, bookings[^1]), tokens);

        var opensIn = roster.Select(OpensInOf).ToList();
        Assert.Equal(opensIn.OrderBy(x => x), opensIn);
    }

    /// <summary>A booking beyond the cap is never minted a code by the roster, so "its code" may not exist.</summary>
    private static async Task<string> CodeOfOrEmptyAsync(Fixture f, Booking booking) =>
        (await f.Db.AccessCodes.AsNoTracking().FirstOrDefaultAsync(c => c.BookingId == booking.Id))?.Code ?? "";

    /// <summary>
    /// Forty-eight fits and the forty-ninth does not, stated against the constant rather than
    /// against a literal — and the constant is the firmware's buffer, so the two sides of
    /// this number are the contract.
    /// </summary>
    [Fact]
    public void The_cap_is_forty_eight_and_the_grammar_bounds_the_token()
    {
        Assert.Equal(48, DeviceGateRosterBuilder.GateRosterMaxEntries);
        Assert.Equal(4096, DeviceGateRosterBuilder.MaxResponseBytes);

        var now = DateTimeOffset.UtcNow;
        Booking At(int i) => new() { StartsAt = now.AddMinutes(i), EndsAt = now.AddMinutes(i + 10) };

        var candidates = Enumerable.Range(0, DeviceGateRosterBuilder.GateRosterMaxEntries + 1)
            .Select(i => new DeviceGateRosterBuilder.GateCandidate(At(i), $"TOKEN{i:00}"))
            .Reverse()   // inserted latest-first; the cap must still keep the earliest
            .Append(new DeviceGateRosterBuilder.GateCandidate(
                At(-5), new string('A', DeviceRosterBuilder.MaxTokenLength + 1)))
            .ToList();

        var roster = DeviceGateRosterBuilder.Format(candidates, now, TimeSpan.Zero);

        Assert.Equal(DeviceGateRosterBuilder.GateRosterMaxEntries, roster.Count);
        Assert.Equal("TOKEN00", TokenOf(roster[0]));
        Assert.Equal("TOKEN47", TokenOf(roster[^1]));

        // A token the firmware could not match is left out rather than sent to be refused:
        // a token cut short matches a different member.
        Assert.DoesNotContain(roster, e => e.StartsWith("AAAAA", StringComparison.Ordinal));
    }

    /// <summary>
    /// A member the club has barred is not on the cached roster either — otherwise a
    /// suspension would hold only while the gate can reach the API, and the one window in
    /// which a club most wants it to hold is the one where nobody is watching.
    /// </summary>
    [Theory]
    [InlineData(MembershipStatus.Suspended)]
    [InlineData(MembershipStatus.Rejected)]
    [InlineData(MembershipStatus.PendingApproval)]
    public async Task A_barred_members_booking_is_not_pushed_to_any_gate(MembershipStatus status)
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var now = DateTimeOffset.UtcNow;
        var settings = Policy(f, GateAccessPolicies.ActiveMember);
        await BookAsync(f, f.Host.Courts[0], now.AddMinutes(5));

        // The control: while Active, it is there.
        Assert.Single(await RosterAsync(f, settings, now));

        await SetMembershipAsync(f, f.Host.PlayerUser.Id, status);
        Assert.Empty(await RosterAsync(f, settings, now));
    }

    /// <summary>
    /// The window is <c>[StartsAt − early, EndsAt] ∩ [now, now + roster_window]</c>, checked
    /// a minute either side of both edges. The far edge is the setting plus the entry window,
    /// which is the part an implementation gets wrong by leaving one of the two out.
    /// </summary>
    [Fact]
    public async Task Bookings_just_outside_the_roster_window_are_absent_and_just_inside_are_present()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var now = DateTimeOffset.UtcNow;
        var settings = Policy(f, GateAccessPolicies.ActiveMember, earlyEntryMinutes: 30);
        var horizon = settings.RosterWindowMinutes + settings.GateEarlyEntryMinutes;

        var justOutside = await BookAsync(f, f.Host.Courts[0], now.AddMinutes(horizon + 1));
        var justInside = await BookAsync(f, f.Host.Courts[1], now.AddMinutes(horizon - 1));
        var justEnded = await BookAsync(f, f.Host.Courts[2], now.AddMinutes(-46), minutes: 45);
        var almostOver = await BookAsync(f, f.Host.Courts[3], now.AddMinutes(-44), minutes: 45);

        var tokens = (await RosterAsync(f, settings, now)).Select(TokenOf).ToList();

        Assert.DoesNotContain(await CodeOfOrEmptyAsync(f, justOutside), tokens);
        Assert.DoesNotContain(await CodeOfOrEmptyAsync(f, justEnded), tokens);
        Assert.Contains(await CodeOfAsync(f, justInside), tokens);
        Assert.Contains(await CodeOfAsync(f, almostOver), tokens);
        Assert.Equal(2, tokens.Count);
    }

    /// <summary>
    /// The gate's roster is the CLUB's, not the board's. Two doors on one tenant are handed
    /// the same list, and nothing on a gate row — its <c>gate_key</c> above all — changes it:
    /// <c>gate_key</c> names the door for an admin and for the audit trail and is not an
    /// access-control input.
    /// </summary>
    [Fact]
    public async Task Two_gates_at_one_club_are_handed_the_same_roster()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var now = DateTimeOffset.UtcNow;
        var settings = Policy(f, GateAccessPolicies.ActiveMember);
        await BookAsync(f, f.Host.Courts[0], now.AddMinutes(5));

        // BuildAsync takes no device at all, which IS the property — stated here so that
        // giving it one later has to break a test rather than a promise.
        var first = await RosterAsync(f, settings, now);
        var second = await RosterAsync(f, settings, now);
        Assert.Equal(first, second);
        Assert.Single(first);
    }

    /// <summary>
    /// Another club's bookings never reach this club's gates. The other club's row is in the
    /// same store, inside the window and on a court numbered the same — everything but the
    /// tenant matches, so the absence is the filter.
    /// </summary>
    [Fact]
    public async Task Another_clubs_booking_never_appears_in_this_clubs_gate_roster()
    {
        var shared = $"crusaders-gate-roster-{Guid.NewGuid():N}";
        var a = await CreateAsync(sharedDb: shared, slug: "club-a");
        var b = await CreateAsync(sharedDb: shared, slug: "club-b");
        await using var _ = a.Host;
        await using var __ = b.Host;
        using var ___ = a.Scope;
        using var ____ = b.Scope;

        var now = DateTimeOffset.UtcNow;
        var bookingB = await BookAsync(b, b.Host.Courts[0], now.AddMinutes(5));
        var bookingA = await BookAsync(a, a.Host.Courts[0], now.AddMinutes(5));

        var rosterA = await RosterAsync(a, Policy(a, GateAccessPolicies.ActiveMember), now);
        Assert.Equal(await CodeOfAsync(a, bookingA), TokenOf(Assert.Single(rosterA)));

        var rosterB = await RosterAsync(b, Policy(b, GateAccessPolicies.ActiveMember), now);
        Assert.Equal(await CodeOfAsync(b, bookingB), TokenOf(Assert.Single(rosterB)));

        Assert.NotNull(await a.Db.Bookings.IgnoreQueryFilters().SingleOrDefaultAsync(x => x.Id == bookingB.Id));
    }

    /// <summary>
    /// The token is the booking's own activation code — the same bytes the member's phone
    /// shows and the same bytes a court box caches — minted once through the court builder's
    /// own helper rather than by a second rule.
    /// </summary>
    [Fact]
    public async Task The_token_is_the_bookings_activation_code_minted_once()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var now = DateTimeOffset.UtcNow;
        var settings = Policy(f, GateAccessPolicies.ActiveMember);
        var booking = await BookAsync(f, f.Host.Courts[0], now.AddMinutes(5));

        var first = Assert.Single(await RosterAsync(f, settings, now));
        var second = Assert.Single(await RosterAsync(f, settings, now));

        Assert.Equal(TokenOf(first), TokenOf(second));
        Assert.Equal(await CodeOfAsync(f, booking), TokenOf(first));
        Assert.Equal(1, await f.Db.AccessCodes.CountAsync(c => c.BookingId == booking.Id));
    }

    // ---- The policy vocabulary ------------------------------------------------

    /// <summary>
    /// An absent policy is the documented default. A PRESENT one that is not a policy is
    /// corruption — the settings PUT refuses anything else, so the only way such a value
    /// exists is a hand-edited column — and a door narrows rather than widens in response.
    ///
    /// <para>
    /// This is the one setting in the tree that fails closed, and it is worth a test rather
    /// than a comment: the next person to "make it consistent with the button map" will read
    /// the comment as an oversight, and this will stop them.
    /// </para>
    /// </summary>
    [Theory]
    [InlineData("{}", GateAccessPolicies.ActiveMember)]
    [InlineData("""{"slice_minutes":15}""", GateAccessPolicies.ActiveMember)]
    [InlineData("""{"gate_access_policy":"active_member"}""", GateAccessPolicies.ActiveMember)]
    [InlineData("""{"gate_access_policy":"booking_window"}""", GateAccessPolicies.BookingWindow)]
    [InlineData("""{"gate_access_policy":"everyone"}""", GateAccessPolicies.BookingWindow)]
    [InlineData("""{"gate_access_policy":""}""", GateAccessPolicies.BookingWindow)]
    [InlineData("""{"gate_access_policy":7}""", GateAccessPolicies.BookingWindow)]
    [InlineData("""{"gate_access_policy":null}""", GateAccessPolicies.BookingWindow)]
    public void An_unreadable_access_policy_narrows_the_door_rather_than_widening_it(string json, string expected)
    {
        using var doc = JsonDocument.Parse(json);
        Assert.Equal(expected, GateAccessPolicies.FromSettings(doc.RootElement));
    }

    /// <summary>The closed set, and the only two members of it.</summary>
    [Fact]
    public void There_are_exactly_two_access_policies()
    {
        Assert.Equal(["active_member", "booking_window"], GateAccessPolicies.All.Order());
        Assert.All(GateAccessPolicies.All, p => Assert.True(GateAccessPolicies.IsKnown(p)));
        Assert.False(GateAccessPolicies.IsKnown("Active_Member"));
        Assert.False(GateAccessPolicies.IsKnown(null));
    }

    // ---- The heartbeat's kind hint -------------------------------------------

    /// <summary>
    /// Absent and <c>court_box</c> are the same thing — every board in the field sends
    /// nothing — <c>gate</c> is the only hint that changes anything, and an unrecognised
    /// string is refused rather than silently becoming a court box.
    /// </summary>
    [Theory]
    [InlineData(null, true, DeviceKind.CourtBox)]
    [InlineData("", true, DeviceKind.CourtBox)]
    [InlineData("   ", true, DeviceKind.CourtBox)]
    [InlineData("court_box", true, DeviceKind.CourtBox)]
    [InlineData("gate", true, DeviceKind.Gate)]
    [InlineData("Gate", false, DeviceKind.CourtBox)]
    [InlineData("turnstile", false, DeviceKind.CourtBox)]
    [InlineData("courtbox", false, DeviceKind.CourtBox)]
    public void The_kind_hint_is_parsed_strictly(string? hint, bool known, DeviceKind expected)
    {
        Assert.Equal(known, DeviceKinds.TryParseHint(hint, out var kind));
        Assert.Equal(expected, kind);
    }

    /// <summary>A gate registers itself with nothing a court box has, and a name an admin will replace.</summary>
    [Fact]
    public async Task A_gate_registers_itself_with_no_courts_and_no_button_map()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var registry = f.Scope.ServiceProvider.GetRequiredService<DeviceRegistryService>();
        var gate = await registry.AutoRegisterAsync("aabbcc0a1b2c", DeviceKind.Gate, default);

        Assert.Equal(DeviceKind.Gate, gate.Kind);
        Assert.Equal(DeviceHardware.Esp32, gate.Hardware);
        Assert.Equal("gate-0a1b2c", gate.DeviceCode);
        Assert.Equal("Door gate", gate.Name);
        Assert.Empty(gate.CourtNumbers);
        Assert.Null(gate.ButtonMapJson);
        Assert.Null(gate.GateKey);
        Assert.True(gate.AutoRegistered);

        // The same MAC as a court box would have produced a very different row — which is
        // the reason the kind is a required argument rather than a default.
        var box = await registry.AutoRegisterAsync("ddeeff0a1b2d", DeviceKind.CourtBox, default);
        Assert.Equal("box-0a1b2d", box.DeviceCode);
        Assert.Equal([1, 2, 3, 4], box.CourtNumbers);
    }

    /// <summary>
    /// The short code falls back to the full MAC on a collision, exactly as a box's does —
    /// <c>device_code</c> is uniquely indexed and a collision would otherwise throw at the one
    /// moment nobody is watching.
    /// </summary>
    [Fact]
    public async Task A_gate_code_collision_falls_back_to_the_full_mac()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var registry = f.Scope.ServiceProvider.GetRequiredService<DeviceRegistryService>();

        var first = await registry.AutoRegisterAsync("aabbcc0a1b2c", DeviceKind.Gate, default);
        var second = await registry.AutoRegisterAsync("ddeeff0a1b2c", DeviceKind.Gate, default);

        Assert.Equal("gate-0a1b2c", first.DeviceCode);
        Assert.Equal("gate-ddeeff0a1b2c", second.DeviceCode);
    }

    /// <summary>The registration audit row says which kind of board turned up.</summary>
    [Fact]
    public async Task Gate_registration_is_audited_with_its_kind()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var registry = f.Scope.ServiceProvider.GetRequiredService<DeviceRegistryService>();
        await registry.AutoRegisterAsync("aabbcc0a1b2c", DeviceKind.Gate, default);
        await registry.AutoRegisterAsync("ddeeff0a1b2d", DeviceKind.CourtBox, default);

        var rows = await f.Db.AuditLogs.Where(a => a.Action == "device.auto_registered").ToListAsync();
        Assert.Equal(2, rows.Count);
        Assert.Contains(rows, r => r.DetailsJson!.Contains("\"kind\":\"gate\"", StringComparison.Ordinal));
        Assert.Contains(rows, r => r.DetailsJson!.Contains("\"kind\":\"court_box\"", StringComparison.Ordinal));
        Assert.All(rows, r => Assert.Equal(Guid.Empty, r.ActorUserId));
    }
}
