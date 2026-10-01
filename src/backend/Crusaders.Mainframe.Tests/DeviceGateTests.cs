using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Webhooks;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

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
        Fixture f, string policy, int? unlockSeconds = null, int earlyEntryMinutes = 30) =>
        f.Settings with
        {
            GateAccessPolicy = policy,
            GateUnlockSeconds = unlockSeconds ?? TenantSettingsView.DefaultGateUnlockSeconds,
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
            AmountChargedMinutes = 8 * Math.Max(1, minutes / 15),
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
        Assert.Equal(TenantSettingsView.DefaultGateUnlockSeconds, decision.UnlockSeconds);
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
    /// A user with no membership row at all is <b>barred, under its own reason</b> — ruling 15,
    /// and a deliberate reversal of what this test used to assert.
    ///
    /// <para>
    /// The old rule was "the club has recorded a decision about this person, and it was not
    /// approval", and about such a user it had recorded none — so a real, live ident code for
    /// somebody the club had never admitted <b>opened the building</b> under the default
    /// <c>active_member</c> policy. "Active member" cannot mean "anybody the club has not said no
    /// to". <c>no_membership</c> rather than <c>member_not_active</c> because the desk's next
    /// action is different: there is nothing to un-suspend, the person needs enrolling.
    /// </para>
    /// </summary>
    [Fact]
    public async Task A_user_with_no_membership_row_is_refused_and_named_as_such()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var now = DateTimeOffset.UtcNow;
        var token = await IdentCodeAsync(f, f.Host.PlayerUser.Id, now.AddMinutes(1));
        await SetMembershipAsync(f, f.Host.PlayerUser.Id, null);

        var decision = await DecideAsync(f, GateOn(f), Policy(f, GateAccessPolicies.ActiveMember), token, now);
        Assert.False(decision.Opened);
        Assert.Equal(GateAccess.NoMembership, decision.Reason);
        Assert.Equal(0, decision.UnlockSeconds);
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
    /// and shuts it when that booking's own code dies — the slot's end plus
    /// <c>grace_window_minutes</c>. Both edges are checked a minute either side.
    ///
    /// <para>
    /// A minute rather than a second because the arithmetic is in minutes; a test that moved
    /// the clock by a second would pass against an implementation that had the comparison
    /// inverted for a whole minute at a time.
    /// </para>
    ///
    /// <para>
    /// <b>The upper edge used to be the slot's bare end and is now the code's liveness</b>,
    /// which is one sentence for the whole door: the product goes on showing the member that
    /// code for the grace window, the no-show sweep waits exactly that long before deciding
    /// they did not come, and refusing them at the door inside it is the product
    /// contradicting itself. Forty-five-minute slot, five-minute grace, so the edge is +50.
    /// </para>
    /// </summary>
    [Theory]
    [InlineData(-31, false)]   // a minute before the entry window opens
    [InlineData(-30, true)]    // the instant it opens
    [InlineData(-29, true)]
    [InlineData(0, true)]      // the slot starts
    [InlineData(44, true)]
    [InlineData(45, true)]     // the instant the slot ends — the code is still live
    [InlineData(49, true)]     // a minute before the code dies
    [InlineData(50, true)]     // the instant it dies
    [InlineData(51, false)]    // a minute after
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

        var court5 = new Court { TenantId = f.Host.Tenant.Id, CourtNumber = 5, Name = "Court 5" };
        f.Db.Courts.Add(court5);
        await f.Db.SaveChangesAsync();

        var now = DateTimeOffset.UtcNow;
        await BookAsync(f, court5, now.AddMinutes(5));
        var token = await IdentCodeAsync(f, f.Host.PlayerUser.Id, now.AddMinutes(1));

        Assert.True((await DecideAsync(
            f, GateOn(f), Policy(f, GateAccessPolicies.BookingWindow), token, now)).Opened);
    }

    /// <summary>
    /// A cancelled slot is not a reason to be in the building, and an <c>AdminBlock</c> is not
    /// a member's booking at all.
    ///
    /// <para>
    /// <b><c>NoShow</c> used to be on this list and is deliberately not any more.</b> A
    /// no-show is the club's bet that the member did not come, settled five minutes after
    /// the slot starts — and the member standing at the door six minutes late is in the
    /// middle of losing that bet, with the product's own way to reverse it waiting on a court
    /// box INSIDE the building. The statuses left here are decisions about the booking;
    /// a no-show is a decision about attendance, and a door records none. See
    /// <c>A_member_the_sweep_has_just_written_off_can_still_get_into_the_building</c>, which
    /// is the row that replaced it and drives the real sweep to get there.
    /// </para>
    ///
    /// <para>
    /// <b><c>Completed</c> has now left it for the mirror reason</b>, and a worse one: it was
    /// the ATTENDED member's status. <c>LightsCueWorker</c> promotes a checked-in booking
    /// within fifteen seconds of its end, so this row refused, at the door, the member who had
    /// just played — while the row above let in the member who had not. It is pinned by
    /// <c>A_member_the_lights_sweep_has_just_completed_can_still_get_into_the_building</c>,
    /// which drives that worker rather than setting the status by hand: a <c>Completed</c> row
    /// with no <c>CheckedInAt</c>, which is what this theory produced, is a fixture the
    /// product cannot make.
    /// </para>
    /// </summary>
    [Theory]
    [InlineData(BookingStatus.Cancelled)]
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
    [InlineData(true, false, false)]    // a club admin with NO membership row: out (ruling 15)
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

        // The membership check runs BEFORE the policy, so a missing row is answered
        // no_membership whoever the person is — the admin carve-out is on the BOOKING check and
        // nothing else, and ruling 15 made "no row" a refusal rather than a shrug.
        var expectedReason = !holdsMembership ? GateAccess.NoMembership
            : opens ? GateAccess.Ok
            : GateAccess.NoBooking;

        Assert.Equal(opens, decision.Opened);
        Assert.Equal(expectedReason, decision.Reason);
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
    /// <b>The admin carve-out does not leak into the booking code's own window.</b> A club
    /// admin presenting a booking code before that booking opens is <c>too_early</c> like
    /// anybody else.
    ///
    /// <para>
    /// Found by probing the claim rather than by a finder: "club admins always pass" is true
    /// of the POLICY check and the spec says so, but a reader — or the next person to move
    /// the carve-out "somewhere more central" — will read it as "admins always get in". They
    /// do not: an admin is held to the membership check (above) and to the credential's own
    /// scope (here), and only the booking check is waived. Without this the sentence had one
    /// of its two limits pinned.
    /// </para>
    ///
    /// <para>
    /// The admin's own ident code at the same instant is the probe: it opens, so the refusal
    /// is the CODE's window and not something about being an admin at a door.
    /// </para>
    /// </summary>
    [Theory]
    [InlineData(GateAccessPolicies.ActiveMember)]
    [InlineData(GateAccessPolicies.BookingWindow)]
    public async Task A_club_admins_booking_code_is_bounded_by_its_own_window_too(string policy)
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var now = DateTimeOffset.UtcNow;
        var booking = await BookAsync(f, f.Host.Courts[0], now.AddHours(6), userId: f.Host.AdminUser.Id);
        var settings = Policy(f, policy);

        var decision = await DecideAsync(f, GateOn(f), settings, await BookingCodeAsync(f, booking), now);
        Assert.False(decision.Opened);
        Assert.Equal(GateAccess.TooEarly, decision.Reason);

        // …and the same admin, same instant, with an ident code, walks in — under
        // booking_window that is the carve-out, and under active_member it is the default.
        var ident = await IdentCodeAsync(f, f.Host.AdminUser.Id, now.AddMinutes(1));
        Assert.True((await DecideAsync(f, GateOn(f), settings, ident, now)).Opened);
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
        // no_membership rather than no_booking since ruling 15: the membership check runs first,
        // and "the club has no record of you" is the truer of the two sentences.
        Assert.Equal(GateAccess.NoMembership, decision.Reason);
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
    // active_member: H = max(30, min(roster 120 + cue 10, 240)) = 130 minutes.
    [InlineData(GateAccessPolicies.ActiveMember, -131, false, GateAccess.TooEarly)]
    [InlineData(GateAccessPolicies.ActiveMember, -130, true, GateAccess.Ok)]
    [InlineData(GateAccessPolicies.ActiveMember, -30, true, GateAccess.Ok)]
    [InlineData(GateAccessPolicies.ActiveMember, 44, true, GateAccess.Ok)]
    [InlineData(GateAccessPolicies.ActiveMember, 45, true, GateAccess.Ok)]
    [InlineData(GateAccessPolicies.ActiveMember, 49, true, GateAccess.Ok)]
    [InlineData(GateAccessPolicies.ActiveMember, 50, false, GateAccess.NotRecognised)]
    // booking_window: H = gate_early_entry_minutes = 30.
    [InlineData(GateAccessPolicies.BookingWindow, -131, false, GateAccess.TooEarly)]
    [InlineData(GateAccessPolicies.BookingWindow, -31, false, GateAccess.TooEarly)]
    [InlineData(GateAccessPolicies.BookingWindow, -30, true, GateAccess.Ok)]
    [InlineData(GateAccessPolicies.BookingWindow, 44, true, GateAccess.Ok)]
    [InlineData(GateAccessPolicies.BookingWindow, 45, true, GateAccess.Ok)]
    [InlineData(GateAccessPolicies.BookingWindow, 49, true, GateAccess.Ok)]
    [InlineData(GateAccessPolicies.BookingWindow, 50, false, GateAccess.NotRecognised)]
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

        // The UPPER edge is the code's own liveness — 45-minute slot plus a 5-minute grace
        // window, and `IsLiveAt` is a strict `ExpiresAt > now`, so +49 opens and +50 is
        // already a dead code. Asserted rather than assumed, and asserted to AGREE with the
        // expected outcome on every late row: that is what says the door's top edge and the
        // code's expiry are ONE instant rather than two that happen to be near each other.
        var live = (await f.Db.AccessCodes.AsNoTracking().FirstAsync(c => c.Code == token)).IsLiveAt(now);
        if (minutesFromStart >= 0) Assert.Equal(opens, live);
        else Assert.True(live, "the early rows must present a LIVE code, or they would be testing expiry");

        var decision = await DecideAsync(f, GateOn(f), Policy(f, policy), token, now);

        Assert.Equal(opens, decision.Opened);
        Assert.Equal(reason, decision.Reason);

        // A refusal names whoever the code identified — except past the top edge, where the
        // code no longer identifies anybody at all. That is the same `not_recognised` an
        // invented code gets, by construction rather than by coincidence.
        Assert.Equal(live ? f.Host.PlayerUser.Id : null, decision.SubjectUserId);
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
    ///
    /// <para>
    /// <b>Neither <c>NoShow</c> nor <c>Completed</c> is on this list any more</b>, for the
    /// reasons <c>A_booking_that_is_not_live_does_not_open_the_door</c> gives above. They are
    /// replaced by the two rows that drive the REAL workers —
    /// <c>A_member_the_sweep_has_just_written_off_can_still_get_into_the_building</c> and
    /// <c>A_member_the_lights_sweep_has_just_completed_can_still_get_into_the_building</c> —
    /// each of which pins both halves: the member gets in for the slot they PAID for, and not
    /// a minute past it.
    /// </para>
    /// </summary>
    [Theory]
    [InlineData(GateAccessPolicies.ActiveMember, BookingStatus.Cancelled)]
    [InlineData(GateAccessPolicies.BookingWindow, BookingStatus.Cancelled)]
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
    /// <b>The no-show sweep must not lock a late member out of the building.</b>
    ///
    /// <para>
    /// This drives the REAL <see cref="NoShowWorker"/> — not a reconstruction of what it does
    /// — and then the real door, because the two halves of the bug are in different files and
    /// only their composition is wrong. Six minutes after a slot starts the sweep flips the
    /// row to <c>NoShow</c> and truncates <c>EndsAt</c> to its own clock. Both of those read
    /// at the door as "this code is fake": the member got <c>not_recognised</c> on the booking
    /// QR and <c>no_booking</c> on the ident QR, standing OUTSIDE — while the product's own
    /// way to reverse a wrong no-show is that same member scanning at the court box INSIDE.
    /// </para>
    ///
    /// <para>
    /// Both policies and both credentials, because the refusal differed between them and
    /// neither was right. The clock is injected into the sweep so the whole scenario is one
    /// anchor rather than two readings of a wall clock minutes apart.
    /// </para>
    /// </summary>
    [Theory]
    [InlineData(GateAccessPolicies.ActiveMember, true)]
    [InlineData(GateAccessPolicies.ActiveMember, false)]
    [InlineData(GateAccessPolicies.BookingWindow, true)]
    [InlineData(GateAccessPolicies.BookingWindow, false)]
    public async Task A_member_the_sweep_has_just_written_off_can_still_get_into_the_building(
        string policy, bool bookingCode)
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        // Six minutes past the start, one minute past the five-minute grace window.
        var startsAt = DateTimeOffset.UtcNow.AddMinutes(-6);
        var booking = await BookAsync(f, f.Host.Courts[0], startsAt, minutes: 45);
        var token = bookingCode
            ? await BookingCodeAsync(f, booking)
            : await IdentCodeAsync(f, f.Host.PlayerUser.Id, startsAt.AddHours(1));

        var now = startsAt.AddMinutes(6);
        var worker = new NoShowWorker(
            f.Host.Services, f.Host.Services.GetRequiredService<IEventBus>(),
            NullLogger<NoShowWorker>.Instance);
        await worker.TickAsync(now, default);

        // The fixture the sweep itself produced — asserted, not assumed, because this test is
        // worthless if the sweep did not fire.
        await f.Db.Entry(booking).ReloadAsync();
        Assert.Equal(BookingStatus.NoShow, booking.Status);
        Assert.True(booking.EndsAt <= now, "the sweep must have truncated the slot, or this tests nothing");

        // The member reaches the door two minutes AFTER the sweep ran, which is the ordinary
        // case and the one that discriminates: the truncated EndsAt is now behind them and
        // only the SOLD end still reaches forward. Asserting at the sweep's own instant would
        // have passed against either bound.
        var atTheDoor = now.AddMinutes(2);
        Assert.True(booking.EndsAt < atTheDoor, "the truncated end must be behind the member");
        Assert.True(BookingService.OriginalEndsAt(booking) > atTheDoor, "the SOLD slot must still be running");

        var decision = await DecideAsync(f, GateOn(f), Policy(f, policy), token, atTheDoor);

        Assert.True(decision.Opened, $"a swept member was refused at the door: {decision.Reason}");
        Assert.Equal(GateAccess.Ok, decision.Reason);

        // The probe: the SAME swept booking, past the instant its own code dies — the slot as
        // SOLD plus the grace window — admits nobody. The relief is exactly as long as the
        // product would have gone on showing that member the code, not a standing key.
        var afterTheSlot = BookingService.OriginalEndsAt(booking)
            .AddMinutes(f.Settings.GraceWindowMinutes + 1);
        var late = await DecideAsync(f, GateOn(f), Policy(f, policy), token, afterTheSlot);
        if (bookingCode)
        {
            Assert.False(late.Opened);
            Assert.Equal(GateAccess.NotRecognised, late.Reason);
        }
        else
        {
            // An ident code names no booking, so under the default policy it never needed one.
            Assert.Equal(policy == GateAccessPolicies.ActiveMember, late.Opened);
        }
    }

    /// <summary>
    /// <b>The lights sweep must not lock an ATTENDED member out of the building either.</b>
    ///
    /// <para>
    /// <c>NoShow</c> was the relief the member who did not come got, and a member who DID
    /// come got nothing: <see cref="LightsCueWorker"/> runs every fifteen seconds and promotes
    /// a checked-in booking to <see cref="BookingStatus.Completed"/> the moment its
    /// <c>EndsAt</c> passes, so within about fifteen seconds of a slot ending the attended
    /// member's own live code answered <c>not_recognised</c> and their ident code answered
    /// <c>no_booking</c>. The member who was refused is the one who was on the court. The
    /// member who was let in for the whole grace window is the one the club had just decided
    /// never turned up.
    /// </para>
    ///
    /// <para>
    /// <b>This drives the REAL worker, and that is the whole reason the defect survived two
    /// rounds.</b> The tests that pinned "a <c>Completed</c> booking opens nothing" set the
    /// status by hand on a row with <c>CheckedInAt == null</c> — a state no production path
    /// produces, because the only writer of <c>Completed</c> requires attendance. A fixture
    /// the product cannot produce pins nothing; the fixture here is the one the worker itself
    /// wrote, and it is asserted rather than assumed.
    /// </para>
    ///
    /// <para>
    /// Both policies and both credentials, because the refusal differed between them and
    /// none of the four was right.
    /// </para>
    /// </summary>
    [Theory]
    [InlineData(GateAccessPolicies.ActiveMember, true)]
    [InlineData(GateAccessPolicies.ActiveMember, false)]
    [InlineData(GateAccessPolicies.BookingWindow, true)]
    [InlineData(GateAccessPolicies.BookingWindow, false)]
    public async Task A_member_the_lights_sweep_has_just_completed_can_still_get_into_the_building(
        string policy, bool bookingCode)
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        // A forty-five minute court that ended a minute ago, played by somebody who was
        // there. The worker reads its own clock, so the slot is placed relative to now.
        var startsAt = DateTimeOffset.UtcNow.AddMinutes(-46);
        var booking = await BookAsync(f, f.Host.Courts[0], startsAt, minutes: 45);
        booking.CheckedInAt = startsAt.AddMinutes(1);
        await f.Db.SaveChangesAsync();

        var token = bookingCode
            ? await BookingCodeAsync(f, booking)
            : await IdentCodeAsync(f, f.Host.PlayerUser.Id, startsAt.AddHours(2));

        await new LightsCueWorker(
            f.Host.Services, f.Host.Services.GetRequiredService<IEventBus>(),
            NullLogger<LightsCueWorker>.Instance).TickAsync(default);

        // The fixture the worker itself produced, asserted: without the promotion this test
        // is a re-statement of the Booked case and proves nothing.
        await f.Db.Entry(booking).ReloadAsync();
        Assert.Equal(BookingStatus.Completed, booking.Status);
        Assert.NotNull(booking.CheckedInAt);

        // At the door a minute later, still inside the five-minute grace window — which is
        // exactly how long the product goes on holding a live code for this member.
        var atTheDoor = booking.EndsAt.AddMinutes(1);
        Assert.True(
            atTheDoor < BookingService.OriginalEndsAt(booking).AddMinutes(f.Settings.GraceWindowMinutes),
            "the door instant must be inside the grace window, or this tests the wrong edge");

        var decision = await DecideAsync(f, GateOn(f), Policy(f, policy), token, atTheDoor);
        Assert.True(decision.Opened, $"a member who played was refused at the door: {decision.Reason}");
        Assert.Equal(GateAccess.Ok, decision.Reason);

        // The probe, and the same one the swept member gets: past the instant that booking's
        // own code dies, the relief is over. A completed court is not a building key either.
        var afterTheGrace = BookingService.OriginalEndsAt(booking)
            .AddMinutes(f.Settings.GraceWindowMinutes + 1);
        var late = await DecideAsync(f, GateOn(f), Policy(f, policy), token, afterTheGrace);
        if (bookingCode)
        {
            Assert.False(late.Opened);
            Assert.Equal(GateAccess.NotRecognised, late.Reason);
        }
        else
        {
            // An ident code names no booking, so under the default policy it never needed one.
            Assert.Equal(policy == GateAccessPolicies.ActiveMember, late.Opened);
        }
    }

    /// <summary>
    /// The terminal statuses that really are terminal, and the probe that says the relief
    /// above is a carve-out rather than a hole. A cancelled booking's code opens nothing even
    /// while the row's own code is still live.
    ///
    /// <para>
    /// <b><c>Completed</c> used to be on this list and is deliberately not any more</b> — see
    /// <c>A_member_the_lights_sweep_has_just_completed_can_still_get_into_the_building</c>.
    /// It was here as a hand-set status on a row with no <c>CheckedInAt</c>, which is a state
    /// the product cannot reach: <see cref="LightsCueWorker"/> is the only writer of
    /// <c>Completed</c> and it requires attendance. So the row pinned a fixture rather than a
    /// rule, and the rule it appeared to pin was wrong.
    /// </para>
    ///
    /// <para>
    /// <c>AdminBlock</c> is not reachable through a booking CODE at all — an admin block
    /// carries no user, and <c>AccessCodeService.StageForBookingAsync</c> refuses to stage a
    /// code without one — so it is pinned on the policy path instead, in
    /// <c>A_booking_that_is_not_live_does_not_open_the_door</c>.
    /// </para>
    /// </summary>
    [Theory]
    [InlineData(BookingStatus.Cancelled)]
    public async Task A_booking_the_member_did_not_lose_by_being_late_still_opens_nothing(BookingStatus status)
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var now = DateTimeOffset.UtcNow;
        var booking = await BookAsync(f, f.Host.Courts[0], now.AddMinutes(-6), minutes: 45);
        var token = await BookingCodeAsync(f, booking);

        booking.Status = status;
        await f.Db.SaveChangesAsync();

        var decision = await DecideAsync(f, GateOn(f), Policy(f, GateAccessPolicies.ActiveMember), token, now);

        Assert.False(decision.Opened);
        Assert.Equal(GateAccess.NotRecognised, decision.Reason);
    }

    /// <summary>
    /// <b>The door's horizon has a ceiling, and no settings document can lift it.</b>
    ///
    /// <para>
    /// <c>GateAccess.MaxEarlyEntryMinutes</c> is four hours, and the comment on it says so in
    /// those words — but it bounded only <c>gate_early_entry_minutes</c>. Under
    /// <c>active_member</c> the horizon is the wider of that and the phone's, and the phone's
    /// is <c>roster_window_minutes + activation_cue_window_minutes</c>: two settings the
    /// settings PUT bounds at 1440 each, cross-checked only against each other. So a club
    /// could set both to their legal maxima and hand every booking code in the building a
    /// FORTY-EIGHT-HOUR door window, with the spec still saying four hours and no test
    /// disagreeing.
    /// </para>
    ///
    /// <para>
    /// A theory over the grid rather than three examples, and the grid deliberately includes
    /// values the PUT would refuse: a hand-edited settings column is the case the clamp exists
    /// for, and <c>TenantSettingsAccessor.TryInt</c> does not bound anything on the way in.
    /// The assertion is the ceiling AND the arithmetic, because a function that returned 0
    /// everywhere would satisfy the ceiling alone.
    /// </para>
    /// </summary>
    [Theory]
    // policy,                            early, roster, cue
    [InlineData(GateAccessPolicies.ActiveMember, 30, 120, 10)]     // the defaults
    [InlineData(GateAccessPolicies.ActiveMember, 30, 1440, 1440)]  // both at their legal maxima
    [InlineData(GateAccessPolicies.ActiveMember, 240, 1440, 1440)] // …and the entry window too
    [InlineData(GateAccessPolicies.ActiveMember, 0, 1440, 0)]
    [InlineData(GateAccessPolicies.ActiveMember, 0, 230, 10)]      // just under the ceiling
    [InlineData(GateAccessPolicies.ActiveMember, 0, 240, 1)]       // just over it
    [InlineData(GateAccessPolicies.BookingWindow, 240, 1440, 1440)]
    [InlineData(GateAccessPolicies.BookingWindow, 30, 1440, 1440)]
    // Values no PUT would accept. A hand-edited column reaches the reader unbounded.
    [InlineData(GateAccessPolicies.ActiveMember, 100000, 100000, 100000)]
    [InlineData(GateAccessPolicies.ActiveMember, -5, -5, -5)]
    [InlineData(GateAccessPolicies.ActiveMember, 241, 0, 0)]
    [InlineData(GateAccessPolicies.BookingWindow, 100000, 0, 0)]
    public async Task No_settings_combination_lets_a_door_reach_further_than_four_hours(
        string policy, int early, int roster, int cue)
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var settings = Policy(f, policy, earlyEntryMinutes: early) with
        {
            RosterWindowMinutes = roster,
            ActivationCueWindowMinutes = cue,
        };

        var horizon = BookingCodeWindow.DoorHorizonMinutes(settings);

        Assert.InRange(horizon, 0, GateAccess.MaxEarlyEntryMinutes);

        // …and it is the documented arithmetic, not merely something small. Every input is
        // clamped to the range its own PUT declares before the max/min is taken, so a
        // hand-edited column cannot widen a door and cannot narrow one below zero either.
        var clampedEarly = Math.Clamp(early, 0, GateAccess.MaxEarlyEntryMinutes);
        var expected = policy == GateAccessPolicies.BookingWindow
            ? clampedEarly
            : Math.Max(clampedEarly, Math.Min(
                Math.Clamp(roster, TenantSettingsView.MinRosterWindowMinutes, TenantSettingsView.MaxRosterWindowMinutes)
                + Math.Clamp(cue, 0, TenantSettingsView.MaxActivationCueWindowMinutes),
                GateAccess.MaxEarlyEntryMinutes));
        Assert.Equal(expected, horizon);
    }

    /// <summary>
    /// The ceiling at the layer a member meets it: a club whose phone horizon is two days
    /// wide still has doors that refuse a booking code four hours and one minute early.
    ///
    /// <para>
    /// The phone is deliberately NOT narrowed to match. A member may hold a code their own
    /// door will not yet accept, and the door says <c>too_early</c> rather than
    /// <c>not_recognised</c> — which is the honest answer to somebody standing outside with a
    /// real booking, and is why the asymmetry is pinned rather than argued away.
    /// </para>
    /// </summary>
    [Theory]
    [InlineData(239, true, GateAccess.Ok)]
    [InlineData(241, false, GateAccess.TooEarly)]
    public async Task A_club_with_an_enormous_phone_horizon_still_has_a_four_hour_door(
        int minutesEarly, bool opens, string reason)
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var settings = Policy(f, GateAccessPolicies.ActiveMember, earlyEntryMinutes: 30) with
        {
            RosterWindowMinutes = 1440,
            ActivationCueWindowMinutes = 1440,
        };

        var now = DateTimeOffset.UtcNow;
        var booking = await BookAsync(f, f.Host.Courts[0], now.AddMinutes(minutesEarly));
        var token = await BookingCodeAsync(f, booking);

        // The phone WOULD show it at both instants; that is the point of the pair.
        Assert.True(booking.StartsAt <= BookingCodeWindow.LatestStart(
            now, BookingCodeWindow.DisplayHorizonMinutes(settings)));

        var decision = await DecideAsync(f, GateOn(f), settings, token, now);

        Assert.Equal(opens, decision.Opened);
        Assert.Equal(reason, decision.Reason);
    }

    /// <summary>
    /// <b>A spent QR still opens the door when the member is genuinely due.</b>
    ///
    /// <para>
    /// A booking code is bounded by its own booking, which is right — but the member holding
    /// it is a person, not a credential. Somebody whose phone is still showing the code for
    /// the court they played at 17:00, walking back in at 18:50 for the court they have booked
    /// at 19:00, was told <c>not_recognised</c>: the code is fake. It is not fake; it is
    /// theirs, it is live, and they are due on a court in ten minutes.
    /// </para>
    ///
    /// <para>
    /// The earlier booking is <c>Completed</c> here because that is what the product does to
    /// it: <c>LightsCueWorker</c> promotes an attended-and-over booking, so this is the shape
    /// a member who PLAYED their 17:00 court is actually left holding. Its code outlives the
    /// promotion — nothing revokes one — which is exactly why the rule had to become "may this
    /// member come in" rather than "does this credential name the booking they are coming in
    /// for".
    /// </para>
    /// </summary>
    [Fact]
    public async Task A_spent_booking_code_still_opens_the_door_for_a_member_due_on_another_court()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var settings = Policy(f, GateAccessPolicies.ActiveMember);

        var five = new DateTimeOffset(2024, 3, 10, 17, 0, 0, TimeSpan.Zero);
        var earlier = await BookAsync(f, f.Host.Courts[0], five, minutes: 60);
        var later = await BookAsync(f, f.Host.Courts[0], five.AddHours(2), minutes: 60);

        // Minted with an hour of grace — a club that has since shortened the setting leaves
        // exactly this in its members' hands — so the code is still live long after its own
        // court is over and promoted.
        var spent = (await f.Codes.MintForBookingAsync(earlier, TimeSpan.FromMinutes(60), default)).Code;
        earlier.Status = BookingStatus.Completed;
        await f.Db.SaveChangesAsync();

        var now = five.AddMinutes(110);   // 18:50 — the 17:00 court is done, the 19:00 one is in reach.

        Assert.True((await f.Db.AccessCodes.AsNoTracking().FirstAsync(c => c.Code == spent)).IsLiveAt(now),
            "the fixture must present a LIVE code, or this would be testing plain expiry");
        Assert.True(later.StartsAt <= BookingCodeWindow.LatestStart(
            now, BookingCodeWindow.DoorHorizonMinutes(settings)), "the later booking must be in reach");

        var welcome = await DecideAsync(f, GateOn(f), settings, spent, now);
        Assert.True(welcome.Opened);
        Assert.Equal(GateAccess.Ok, welcome.Reason);

        // The probe: take the later booking away and the SAME code at the SAME instant is
        // refused exactly as before. Vary the fixture, not the assertion.
        f.Db.Bookings.Remove(later);
        await f.Db.SaveChangesAsync();

        var refused = await DecideAsync(f, GateOn(f), settings, spent, now);
        Assert.False(refused.Opened);
        Assert.Equal(GateAccess.NotRecognised, refused.Reason);
    }

    /// <summary>
    /// The same relief in the other direction: a code presented before its own booking opens,
    /// by a member whose EARLIER booking is running right now, is not <c>too_early</c> for
    /// the building. They are already entitled to be in it.
    /// </summary>
    [Fact]
    public async Task An_early_booking_code_opens_the_door_for_a_member_whose_court_is_running()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var settings = Policy(f, GateAccessPolicies.ActiveMember);
        var now = new DateTimeOffset(2024, 3, 10, 17, 30, 0, TimeSpan.Zero);

        var running = await BookAsync(f, f.Host.Courts[0], now.AddMinutes(-15), minutes: 60);
        var tomorrow = await BookAsync(f, f.Host.Courts[0], now.AddHours(20), minutes: 60);
        var tomorrowsCode = await BookingCodeAsync(f, tomorrow);

        Assert.True(now < tomorrow.StartsAt.AddMinutes(-BookingCodeWindow.DoorHorizonMinutes(settings)),
            "tomorrow's booking must be outside its own door window, or this tests nothing");

        var welcome = await DecideAsync(f, GateOn(f), settings, tomorrowsCode, now);
        Assert.True(welcome.Opened);

        f.Db.Bookings.Remove(running);
        await f.Db.SaveChangesAsync();

        var refused = await DecideAsync(f, GateOn(f), settings, tomorrowsCode, now);
        Assert.False(refused.Opened);
        Assert.Equal(GateAccess.TooEarly, refused.Reason);
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

    /// <summary>
    /// <b>WHO is locked out when a club overflows the cap, and that it is the same people
    /// every time.</b>
    ///
    /// <para>
    /// The cap is a real lockout: on a busy night a booking beyond the forty-eighth cannot get
    /// in while the door is offline, and the club needs to be able to say which bookings those
    /// are. The answer is <c>StartsAt</c> then <c>Id</c>, cap after ordering — so it is the
    /// LATEST-STARTING bookings that fall off, ties broken by a value that never changes.
    /// </para>
    ///
    /// <para>
    /// The tie-break is what makes the sentence true rather than approximately true. A club
    /// with sixty bookings in its window very plausibly has a dozen starting on the same slice
    /// boundary, and a cap applied to an unstable order sends a different forty-eight on every
    /// heartbeat — so a member is in the cache at 18:00, out of it at 18:01, and nobody can
    /// tell them which they will be. Every booking here starts at exactly the same instant, so
    /// nothing BUT the tie-break decides, and the roster is asked twice to say that the answer
    /// is stable rather than merely correct once.
    /// </para>
    /// </summary>
    [Fact]
    public async Task The_overflow_locks_out_the_latest_starting_bookings_deterministically()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var now = DateTimeOffset.UtcNow;
        var settings = Policy(f, GateAccessPolicies.ActiveMember);
        const int Cap = DeviceGateRosterBuilder.GateRosterMaxEntries;   // 48
        const int Earlier = 40;
        const int Tied = 24;                                            // 64 in the window

        // Forty, each a minute apart, so StartsAt alone orders them and every one fits.
        var earlier = new List<Booking>();
        for (var i = 0; i < Earlier; i++)
        {
            earlier.Add(await BookAsync(f, f.Host.Courts[i % 4], now.AddMinutes(1 + i), minutes: 5));
        }

        // Twenty-four on ONE slice boundary, which is the shape a busy club really has. Eight
        // of them fit; nothing but the tie-break can decide which.
        var sameInstant = new List<Booking>();
        for (var i = 0; i < Tied; i++)
        {
            sameInstant.Add(await BookAsync(f, f.Host.Courts[i % 4], now.AddMinutes(90), minutes: 5));
        }

        var roster = await RosterAsync(f, settings, now);
        Assert.Equal(Cap, roster.Count);
        var tokens = roster.Select(TokenOf).ToList();

        // Every earlier booking is in, so the whole overflow falls among the tied ones.
        foreach (var booking in earlier) Assert.Contains(await CodeOfAsync(f, booking), tokens);

        // Among the tied, the survivors are the lowest Ids: the documented tie-break, and the
        // sixteen locked out are the ones the console's sentence is about.
        var byId = sameInstant.OrderBy(b => b.Id).ToList();
        for (var i = 0; i < byId.Count; i++)
        {
            var code = await CodeOfOrEmptyAsync(f, byId[i]);
            if (i < Cap - Earlier) Assert.Contains(code, tokens);
            else Assert.DoesNotContain(code, tokens);
        }

        // Asked again, at the same instant: the SAME forty-eight, in the same order. A cap
        // applied to an unstable order would send a different set on every heartbeat and
        // nobody could tell a member which one they were in.
        Assert.Equal(roster, await RosterAsync(f, settings, now));
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
    /// <b>Every window the gate roster reads is clamped on read, and none of them was.</b>
    ///
    /// <para>
    /// G2's B1 clamped the three numbers the ONLINE decision reads and left the roster
    /// builder reading two of them raw — <c>roster_window_minutes</c> straight off the column
    /// and, before that fix, <c>gate_early_entry_minutes</c> too. A hand-edited settings
    /// document is the case the clamp exists for, and <c>TenantSettingsAccessor.TryInt</c>
    /// bounds nothing on the way in, so a negative roster window silently emptied every door's
    /// cache in the club: no error, no log, a present-and-empty <c>roster</c> key on a 200,
    /// and a door that admits nobody the moment the network drops.
    /// </para>
    ///
    /// <para>
    /// The grid is the shape a hand-edited column really takes — negative, absurd, and just
    /// past a legal bound — and the assertion is the ARITHMETIC rather than "not empty",
    /// because a builder that ignored the settings entirely would satisfy the weaker one. Both
    /// halves are checked: which bookings are in the list (the window), and the
    /// <c>opens_in</c> on each (the early-entry term), so a mutant can be wrong in either
    /// direction and be seen.
    /// </para>
    /// </summary>
    [Theory]
    //        roster,  cue,  early        what a hand-edited column looks like
    [InlineData(120,    10,     30)]   // the defaults
    [InlineData(-600,   10,     30)]   // the executed probe: a negative window emptied the door
    [InlineData(120,    10,   -600)]
    [InlineData(100000, 10, 100000)]
    [InlineData(0,      10,    241)]   // one past the door's own ceiling
    [InlineData(1,      10,      0)]   // one under the roster's floor
    public async Task Every_window_the_gate_roster_reads_is_clamped_on_read(int roster, int cue, int early)
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var now = DateTimeOffset.UtcNow;
        var settings = Policy(f, GateAccessPolicies.ActiveMember, earlyEntryMinutes: early) with
        {
            RosterWindowMinutes = roster,
            ActivationCueWindowMinutes = cue,
        };

        // What the clamps say the window and the early-entry term are, computed from the
        // bounds the settings PUT itself declares rather than restated as literals.
        var clampedRoster = Math.Clamp(
            roster, TenantSettingsView.MinRosterWindowMinutes, TenantSettingsView.MaxRosterWindowMinutes);
        var clampedEarly = Math.Clamp(early, 0, GateAccess.MaxEarlyEntryMinutes);

        // One booking a minute inside the clamped window and one a minute outside it. Under
        // the RAW reading of either number at least one of the two lands on the wrong side.
        var inside = await BookAsync(f, f.Host.Courts[0], now.AddMinutes(clampedRoster + clampedEarly - 1));
        var outside = await BookAsync(f, f.Host.Courts[1], now.AddMinutes(clampedRoster + clampedEarly + 1));

        var entries = await RosterAsync(f, settings, now);
        var tokens = entries.Select(TokenOf).ToList();

        Assert.Contains(await CodeOfAsync(f, inside), tokens);
        Assert.DoesNotContain(await CodeOfOrEmptyAsync(f, outside), tokens);

        // And the early-entry term on the entry itself: opens_in counts down to
        // StartsAt − clamped early, floored to whole seconds.
        var entry = Assert.Single(entries);
        var expected = (long)Math.Floor(
            (inside.StartsAt.AddMinutes(-clampedEarly) - now).TotalSeconds);
        Assert.InRange(OpensInOf(entry), expected - 2, expected);
    }

    /// <summary>
    /// <b>Step 5's relief asks its question with the DOOR's horizon, not the club's entry
    /// window</b>, and the two are different numbers under the default policy — 130 minutes
    /// against 30 at the defaults.
    ///
    /// <para>
    /// It is the difference between "is this member due on a court soon enough to be let in
    /// for it" (step 6's question, the club's entry window) and "is this member entitled to be
    /// in the building at all" (step 5's, the horizon in which the product itself puts that
    /// member's next code on their screen). A member holding a code the product is showing
    /// them, for a court an hour away, is not somebody to refuse at the front door.
    /// </para>
    ///
    /// <para>
    /// The existing relief tests all place the OTHER booking either already running or within
    /// half an hour, so both horizons answer the same and a mutant swapping them changes
    /// nothing. This one places it in the gap on purpose.
    /// </para>
    /// </summary>
    [Fact]
    public async Task The_reliefs_horizon_is_the_doors_and_not_the_clubs_entry_window()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var settings = Policy(f, GateAccessPolicies.ActiveMember, earlyEntryMinutes: 30);
        var door = BookingCodeWindow.DoorHorizonMinutes(settings);
        var entry = BookingCodeWindow.EntryWindowMinutes(settings);
        Assert.True(door > entry + 2, "the two horizons must differ, or this test cannot discriminate");

        var now = new DateTimeOffset(2024, 3, 10, 17, 0, 0, TimeSpan.Zero);

        // The credential: an earlier court, played and over, whose code was minted with three
        // hours of grace and is therefore still live — what a club that has since shortened
        // the setting leaves in its members' hands. `Completed` with a `CheckedInAt` is what
        // LightsCueWorker leaves behind, and it is what puts the code outside its OWN window
        // so that the relief is what decides. Its own sold end plus the club's CURRENT grace
        // is 16:05, an hour behind `now`, so this booking cannot satisfy the relief itself.
        var earlier = await BookAsync(f, f.Host.Courts[0], now.AddMinutes(-120), minutes: 60);
        var spent = (await f.Codes.MintForBookingAsync(earlier, TimeSpan.FromMinutes(180), default)).Code;
        earlier.Status = BookingStatus.Completed;
        earlier.CheckedInAt = earlier.StartsAt.AddMinutes(1);
        await f.Db.SaveChangesAsync();

        // The entitlement: a court that starts BETWEEN the two horizons.
        var soon = await BookAsync(f, f.Host.Courts[1], now.AddMinutes((entry + door) / 2), minutes: 60);
        Assert.True(soon.StartsAt > BookingCodeWindow.LatestStart(now, entry), "outside the entry window");
        Assert.True(soon.StartsAt <= BookingCodeWindow.LatestStart(now, door), "inside the door's horizon");

        Assert.True((await DecideAsync(f, GateOn(f), settings, spent, now)).Opened);

        // The probe: take the later booking away and the SAME code at the SAME instant is
        // refused. Vary the fixture, not the assertion.
        f.Db.Bookings.Remove(soon);
        await f.Db.SaveChangesAsync();
        Assert.Equal(GateAccess.NotRecognised, (await DecideAsync(f, GateOn(f), settings, spent, now)).Reason);
    }

    /// <summary>
    /// <b>A booking with no member cannot carry a code, and the refusal is an exception rather
    /// than a fallback.</b>
    ///
    /// <para>
    /// The only booking in this product with a null <c>UserId</c> is an
    /// <see cref="BookingStatus.AdminBlock"/>, and there is nobody to let in. The code's user
    /// used to fall back to <c>BookedByUserId</c>, which made "the person the code identifies"
    /// and "the person the booking belongs to" two potentially different people — and the
    /// cached roster's barred filter keys on the BOOKING's user while the online door check
    /// keys on the CODE's, so the two rules would have disagreed about whom a suspension
    /// binds.
    /// </para>
    ///
    /// <para>
    /// Pinned because a fallback of any kind — <c>BookedByUserId</c>, <c>Guid.Empty</c> —
    /// restores that divergence silently and every other test in this file goes on passing.
    /// The agreement is a property of the type, and this is what makes it one.
    /// </para>
    /// </summary>
    [Fact]
    public async Task A_booking_with_no_member_cannot_carry_an_access_code()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var block = new Booking
        {
            TenantId = f.Host.Tenant.Id,
            CourtId = f.Host.Courts[0].Id,
            UserId = null,
            BookedByUserId = f.Host.AdminUser.Id,
            ActorUserId = f.Host.AdminUser.Id,
            StartsAt = DateTimeOffset.UtcNow.AddMinutes(10),
            EndsAt = DateTimeOffset.UtcNow.AddMinutes(55),
            SliceMinutes = 15,
            SliceCount = 3,
            Status = BookingStatus.AdminBlock,
        };
        f.Db.Bookings.Add(block);
        await f.Db.SaveChangesAsync();

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => f.Codes.MintForBookingAsync(block, TimeSpan.FromMinutes(5), default));

        Assert.Empty(await f.Db.AccessCodes.Where(c => c.BookingId == block.Id).ToListAsync());
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
