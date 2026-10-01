using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// A pre-booked member lighting their court from the box — <c>POST /api/v1/device/activate</c>.
///
/// <para>
/// The path that did not exist (review C3): every endpoint that could stamp attendance for
/// a booking wanted an admin JWT the box cannot present, so a member who paid online stood
/// at a dark court, was refused on the button path by their own booking, and was then swept
/// as a no-show. These drive the endpoint's decision directly; the signed wire is covered in
/// <c>DeviceEventHttpTests</c>.
/// </para>
/// </summary>
public class DeviceActivateTests
{
    private sealed record Fixture(
        TestHost Host, IServiceScope Scope, MainframeDbContext Db, AccessCodeService Codes,
        LedgerService Ledger, DeviceActivateServices Services);

    private static async Task<Fixture> CreateAsync(int topUpMinutes = 100, string? sharedDb = null, string? slug = null)
    {
        var host = await TestHost.CreateAsync(slug, sharedDb);
        var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();

        if (topUpMinutes > 0)
        {
            await ledger.PostAsync(
                new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, topUpMinutes, host.PlayerUser.Id), default);
        }

        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var codes = scope.ServiceProvider.GetRequiredService<AccessCodeService>();
        return new Fixture(host, scope, db, codes, ledger,
            new DeviceActivateServices(db, codes,
                scope.ServiceProvider.GetRequiredService<CourtActivationService>(),
                scope.ServiceProvider.GetRequiredService<TenantSettingsAccessor>(),
                scope.ServiceProvider.GetRequiredService<DeviceFaultSink>(),
                scope.ServiceProvider.GetRequiredService<MemberCodeService>(),
                TimeProvider.System));
    }

    /// <summary>The MAC every box in this suite announces. One box, so one MAC.</summary>
    private const string BoxMac = "ff0000000001";

    private static async Task<Device> BoxOnAsync(Fixture f, params int[] courtNumbers)
    {
        var device = new Device
        {
            TenantId = f.Host.Tenant.Id,
            DeviceCode = "court-box-1",
            Name = "The box",
            Kind = DeviceKind.CourtBox,
            MacAddress = BoxMac,
            CourtNumbers = [.. courtNumbers],
        };
        f.Db.Devices.Add(device);
        await f.Db.SaveChangesAsync();
        return device;
    }

    /// <summary>A charged booking for the player, written directly so the clock can be placed anywhere.</summary>
    private static async Task<Booking> BookAsync(Fixture f, int courtIndex, int startsInMinutes, int minutes = 60, bool charged = true)
    {
        var startsAt = DateTimeOffset.UtcNow.AddMinutes(startsInMinutes);
        var booking = new Booking
        {
            TenantId = f.Host.Tenant.Id,
            CourtId = f.Host.Courts[courtIndex].Id,
            UserId = f.Host.PlayerUser.Id,
            BookedByUserId = f.Host.PlayerUser.Id,
            PaidByUserId = f.Host.PlayerUser.Id,
            ActorUserId = f.Host.PlayerUser.Id,
            StartsAt = startsAt,
            EndsAt = startsAt.AddMinutes(minutes),
            SliceMinutes = 15,
            SliceCount = minutes / 15,
            AmountChargedMinutes = 8 * (minutes / 15),
            Status = BookingStatus.Booked,
            ChargedAt = charged ? DateTimeOffset.UtcNow : null,
        };
        f.Db.Bookings.Add(booking);
        if (charged)
        {
            f.Db.LedgerEntries.Add(new LedgerEntry
            {
                TenantId = f.Host.Tenant.Id,
                UserId = f.Host.PlayerUser.Id,
                Type = LedgerEntryType.BookingCharge,
                AmountMinutes = -booking.AmountChargedMinutes,
                ActorUserId = f.Host.PlayerUser.Id,
                RelatedBookingId = booking.Id,
                Reason = "seed charge",
            });
        }
        await f.Db.SaveChangesAsync();
        return booking;
    }

    private static async Task<string> BookingCodeAsync(Fixture f, Booking booking) =>
        (await f.Codes.MintForBookingAsync(booking, TimeSpan.FromMinutes(5), default)).Code;

    private static async Task<string> IdentCodeAsync(Fixture f) =>
        (await f.Codes.MintIdentAsync(f.Host.PlayerUser.Id, TimeSpan.FromSeconds(60), default)).Code;

    private static Task<DeviceActivateResponse> ActivateAsync(Fixture f, Device box, string code, int? court = null, string method = "qr") =>
        DeviceActivateEndpoint.ActivateForDeviceAsync(box, new DeviceActivateRequest(BoxMac, method, code, court), f.Services, default);

    // ---- The happy path ---------------------------------------------------

    /// <summary>
    /// The booking's own code lights the booking's own court, and the grant is what is left
    /// of the slot — the box puts exactly this on its relay timer.
    /// </summary>
    [Fact]
    public async Task A_booking_code_activates_the_booking_and_grants_the_remainder_of_the_slot()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var box = await BoxOnAsync(f, 1, 2);
        var booking = await BookAsync(f, courtIndex: 1, startsInMinutes: 1, minutes: 45);

        var response = await ActivateAsync(f, box, await BookingCodeAsync(f, booking));

        Assert.True(response.Activated);
        Assert.Equal("ok", response.Reason);
        Assert.Equal(2, response.CourtNumber);
        Assert.Equal(booking.Id, response.BookingId);

        // 46 minutes of slot, give or take the test's own clock.
        Assert.InRange(response.GrantedSeconds, 45 * 60, 46 * 60 + 1);
        Assert.Null(response.StartsInSeconds);

        var fresh = await f.Db.Bookings.AsNoTracking().FirstAsync(b => b.Id == booking.Id);
        Assert.NotNull(fresh.CheckedInAt);
        Assert.NotNull(fresh.LightsOnCuedAt);
        Assert.Single(await f.Db.AuditLogs.Where(a => a.Action == "court.activated").ToListAsync());
    }

    /// <summary>
    /// A scan inside the grace window after the slot has ended is still attendance — it
    /// stops the sweep — but there is nothing left to light. <c>activated:true</c> with
    /// <c>granted_seconds:0</c> became a one-second relay pulse and a spent scan on the
    /// box; the box is told the slot is over instead.
    /// </summary>
    [Fact]
    public async Task A_scan_after_the_slot_has_ended_is_stamped_but_answers_ended_with_no_grant()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var box = await BoxOnAsync(f, 1);
        var booking = await BookAsync(f, courtIndex: 0, startsInMinutes: -47, minutes: 45);   // over two minutes ago, inside grace

        var response = await ActivateAsync(f, box, await BookingCodeAsync(f, booking));

        Assert.False(response.Activated);
        Assert.Equal("ended", response.Reason);
        Assert.Equal(0, response.GrantedSeconds);
        Assert.Equal(booking.Id, response.BookingId);
        Assert.Equal(1, response.CourtNumber);

        var fresh = await f.Db.Bookings.AsNoTracking().FirstAsync(b => b.Id == booking.Id);
        Assert.NotNull(fresh.CheckedInAt);
    }

    /// <summary>
    /// The same scan, fifteen seconds later — after <c>LightsCueWorker</c> has closed the
    /// booking out — must still say SLOT ENDED.
    ///
    /// <para>
    /// The <c>ended</c> arm above was reachable only in the gap between a slot's end and
    /// the next worker tick, because the lookup filtered on <c>Status == Booked</c>: the
    /// worker promotes an attended booking to <c>Completed</c> within fifteen seconds, and
    /// from then on the member's still-valid code — it lives until slot end plus grace —
    /// resolved to nothing and the glass read NO BOOKING. The member arriving two minutes
    /// late is precisely the case SLOT ENDED exists for, and was the one case that could
    /// never see it.
    /// </para>
    /// </summary>
    [Theory]
    [InlineData(BookingStatus.Completed)]
    [InlineData(BookingStatus.NoShow)]
    public async Task A_booking_the_sweep_has_already_closed_still_answers_ended(BookingStatus closed)
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var box = await BoxOnAsync(f, 1);
        var booking = await BookAsync(f, courtIndex: 0, startsInMinutes: -47, minutes: 45);
        var code = await BookingCodeAsync(f, booking);

        // What the worker does a tick after the slot ends.
        booking.Status = closed;
        booking.LightsOffCuedAt = DateTimeOffset.UtcNow;
        await f.Db.SaveChangesAsync();

        var response = await ActivateAsync(f, box, code);

        Assert.False(response.Activated);
        Assert.Equal("ended", response.Reason);
        Assert.Equal(0, response.GrantedSeconds);
        Assert.Equal(1, response.CourtNumber);
    }

    /// <summary>
    /// A cancelled booking is NOT "ended" — nothing was ever going to happen on that court,
    /// so "no booking behind this code" is the true sentence and SEE THE DESK means
    /// something different to the person reading it.
    /// </summary>
    [Fact]
    public async Task A_cancelled_booking_is_still_no_booking()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var box = await BoxOnAsync(f, 1);
        var booking = await BookAsync(f, courtIndex: 0, startsInMinutes: -47, minutes: 45);
        var code = await BookingCodeAsync(f, booking);

        booking.Status = BookingStatus.Cancelled;
        await f.Db.SaveChangesAsync();

        var response = await ActivateAsync(f, box, code);

        Assert.False(response.Activated);
        Assert.Equal("no_booking", response.Reason);
    }

    /// <summary>
    /// A slot longer than the relay can hold is granted the cap, not the slot. The relay
    /// bank cuts the lights at ninety minutes whatever it is told; a grant of two hours
    /// would be thirty minutes of darkness the box could not explain.
    /// </summary>
    [Fact]
    public async Task A_grant_is_clamped_to_the_relay_hard_cap()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var box = await BoxOnAsync(f, 1);
        var booking = await BookAsync(f, courtIndex: 0, startsInMinutes: 0, minutes: 120);

        var response = await ActivateAsync(f, box, await BookingCodeAsync(f, booking));

        Assert.True(response.Activated);
        Assert.Equal(RelayHardCap.Seconds, response.GrantedSeconds);
    }

    /// <summary>
    /// A repeat scan of a live session answers the remaining seconds. This is the re-light
    /// path for a slot longer than the cap: at minute ninety the relay drops, the member
    /// scans again, and gets what is left — with no second charge and no second stamp.
    /// </summary>
    [Fact]
    public async Task A_repeat_scan_of_a_live_session_returns_the_remaining_seconds_without_charging_again()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var box = await BoxOnAsync(f, 1);
        var booking = await BookAsync(f, courtIndex: 0, startsInMinutes: -10, minutes: 60);
        var code = await BookingCodeAsync(f, booking);

        var first = await ActivateAsync(f, box, code);
        var second = await ActivateAsync(f, box, code);

        Assert.True(first.Activated);
        Assert.True(second.Activated);
        Assert.Equal("ok", second.Reason);
        Assert.InRange(second.GrantedSeconds, 49 * 60, 50 * 60 + 1);
        Assert.True(second.GrantedSeconds <= first.GrantedSeconds);

        Assert.Single(await f.Db.AuditLogs.Where(a => a.Action == "court.activated").ToListAsync());
        Assert.Single(await f.Db.LedgerEntries.Where(l => l.RelatedBookingId == booking.Id).ToListAsync());
    }

    // ---- Which court -------------------------------------------------------

    /// <summary>The booking is on a court this box does not drive. Identified, but not here.</summary>
    [Fact]
    public async Task A_booking_on_a_court_the_box_does_not_drive_is_wrong_court()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var box = await BoxOnAsync(f, 1, 2);
        var booking = await BookAsync(f, courtIndex: 2, startsInMinutes: 1);

        var response = await ActivateAsync(f, box, await BookingCodeAsync(f, booking));

        Assert.False(response.Activated);
        Assert.Equal("wrong_court", response.Reason);
        Assert.Equal(0, response.GrantedSeconds);
        Assert.Null((await f.Db.Bookings.AsNoTracking().FirstAsync(b => b.Id == booking.Id)).CheckedInAt);
    }

    /// <summary>The member pressed a court button that is not the court they booked.</summary>
    [Fact]
    public async Task A_named_court_that_is_not_the_bookings_court_is_wrong_court()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var box = await BoxOnAsync(f, 1, 2);
        var booking = await BookAsync(f, courtIndex: 1, startsInMinutes: 1);

        var response = await ActivateAsync(f, box, await BookingCodeAsync(f, booking), court: 1);

        Assert.False(response.Activated);
        Assert.Equal("wrong_court", response.Reason);
    }

    /// <summary>A named court the box does not drive at all is refused before anything is looked up.</summary>
    [Fact]
    public async Task A_named_court_the_box_does_not_drive_is_wrong_court()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var box = await BoxOnAsync(f, 1, 2);
        var booking = await BookAsync(f, courtIndex: 1, startsInMinutes: 1);

        var response = await ActivateAsync(f, box, await BookingCodeAsync(f, booking), court: 4);

        Assert.False(response.Activated);
        Assert.Equal("wrong_court", response.Reason);
    }

    // ---- Member-ident codes -----------------------------------------------

    /// <summary>
    /// A member-ident code names no booking, so the member's earliest activatable booking
    /// across the box's courts is the one they are standing on. Two back-to-back slices on
    /// two of the box's courts, inserted latest-first: the earlier one wins.
    /// </summary>
    [Fact]
    public async Task An_ident_code_activates_the_earliest_of_two_back_to_back_bookings_across_the_boxs_courts()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var box = await BoxOnAsync(f, 1, 2, 3);
        var later = await BookAsync(f, courtIndex: 2, startsInMinutes: 5, minutes: 15);
        var earlier = await BookAsync(f, courtIndex: 1, startsInMinutes: 1, minutes: 15);

        var response = await ActivateAsync(f, box, await IdentCodeAsync(f));

        Assert.True(response.Activated);
        Assert.Equal(earlier.Id, response.BookingId);
        Assert.Equal(2, response.CourtNumber);

        Assert.NotNull((await f.Db.Bookings.AsNoTracking().FirstAsync(b => b.Id == earlier.Id)).CheckedInAt);
        Assert.Null((await f.Db.Bookings.AsNoTracking().FirstAsync(b => b.Id == later.Id)).CheckedInAt);
    }

    /// <summary>An ident code with a named court searches only that court.</summary>
    [Fact]
    public async Task An_ident_code_with_a_named_court_searches_only_that_court()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var box = await BoxOnAsync(f, 1, 2);
        var onCourt2 = await BookAsync(f, courtIndex: 1, startsInMinutes: 1, minutes: 15);

        var wrong = await ActivateAsync(f, box, await IdentCodeAsync(f), court: 1);
        Assert.False(wrong.Activated);
        Assert.Equal("no_booking", wrong.Reason);

        var right = await ActivateAsync(f, box, await IdentCodeAsync(f), court: 2);
        Assert.True(right.Activated);
        Assert.Equal(onCourt2.Id, right.BookingId);
    }

    [Fact]
    public async Task An_ident_code_with_nothing_booked_is_no_booking()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var box = await BoxOnAsync(f, 1, 2);

        var response = await ActivateAsync(f, box, await IdentCodeAsync(f));

        Assert.False(response.Activated);
        Assert.Equal("no_booking", response.Reason);
        Assert.Null(response.BookingId);
    }

    // ---- Too early --------------------------------------------------------

    /// <summary>
    /// Inside the forward window — the booking is found — but outside the cue window: the
    /// scan must not stamp attendance or cue the lights, and the box is told when to come
    /// back. Before this the two windows were the same two hours.
    /// </summary>
    [Fact]
    public async Task A_scan_inside_the_forward_window_but_outside_the_cue_window_is_too_early()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var settings = await f.Scope.ServiceProvider.GetRequiredService<TenantSettingsAccessor>().GetAsync(default);
        Assert.True(settings.ActivationCueWindowMinutes < settings.ActivationForwardWindowMinutes);
        var startsIn = settings.ActivationCueWindowMinutes + 30;
        Assert.True(startsIn < settings.ActivationForwardWindowMinutes);

        var box = await BoxOnAsync(f, 1);
        var booking = await BookAsync(f, courtIndex: 0, startsInMinutes: startsIn);

        var response = await ActivateAsync(f, box, await BookingCodeAsync(f, booking));

        Assert.False(response.Activated);
        Assert.Equal("too_early", response.Reason);
        Assert.Equal(booking.Id, response.BookingId);
        Assert.Equal(0, response.GrantedSeconds);
        Assert.InRange(response.StartsInSeconds ?? -1, startsIn * 60 - 5, startsIn * 60);

        var fresh = await f.Db.Bookings.AsNoTracking().FirstAsync(b => b.Id == booking.Id);
        Assert.Null(fresh.CheckedInAt);
        Assert.Null(fresh.LightsOnCuedAt);
        Assert.Empty(await f.Db.AuditLogs.Where(a => a.Action == "court.activated").ToListAsync());
    }

    /// <summary>Past the forward window the code still resolves, but the box is told there is nothing to light.</summary>
    [Fact]
    public async Task A_booking_beyond_the_forward_window_is_no_booking()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var settings = await f.Scope.ServiceProvider.GetRequiredService<TenantSettingsAccessor>().GetAsync(default);

        var box = await BoxOnAsync(f, 1);
        var booking = await BookAsync(f, courtIndex: 0, startsInMinutes: settings.ActivationForwardWindowMinutes + 60);

        var response = await ActivateAsync(f, box, await BookingCodeAsync(f, booking));

        Assert.False(response.Activated);
        Assert.Equal("no_booking", response.Reason);
    }

    // ---- Refusals ---------------------------------------------------------

    [Fact]
    public async Task An_expired_code_is_not_recognised()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var box = await BoxOnAsync(f, 1);
        await BookAsync(f, courtIndex: 0, startsInMinutes: 1);
        var expired = await TestAccessCodes.InsertExpiredAsync(f.Host.Services, f.Host.Tenant.Id, f.Host.PlayerUser.Id);

        var response = await ActivateAsync(f, box, expired);

        Assert.False(response.Activated);
        Assert.Equal("not_recognised", response.Reason);
        Assert.Null(response.BookingId);
    }

    [Theory]
    [InlineData("pin")]
    [InlineData("biometric")]
    [InlineData(null)]
    public async Task A_method_that_cannot_identify_globally_is_not_recognised(string? method)
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var box = await BoxOnAsync(f, 1);
        var booking = await BookAsync(f, courtIndex: 0, startsInMinutes: 1);

        var response = await ActivateAsync(f, box, await BookingCodeAsync(f, booking), method: method!);

        Assert.False(response.Activated);
        Assert.Equal("not_recognised", response.Reason);
    }

    /// <summary>
    /// The uncharged shape — a booking reserved without a debit — held by a member with
    /// nothing to pay it with. Identified, found, refused with the reason, and nothing stamped.
    /// </summary>
    [Fact]
    public async Task An_unaffordable_booking_is_refused_with_insufficient_balance_and_nothing_stamped()
    {
        var f = await CreateAsync(topUpMinutes: 0);
        await using var _ = f.Host;
        using var __ = f.Scope;

        var box = await BoxOnAsync(f, 1);
        var booking = await BookAsync(f, courtIndex: 0, startsInMinutes: 1, minutes: 15, charged: false);

        var response = await ActivateAsync(f, box, await BookingCodeAsync(f, booking));

        Assert.False(response.Activated);
        Assert.Equal("insufficient_balance", response.Reason);
        Assert.Equal(0, response.GrantedSeconds);
        Assert.Null((await f.Db.Bookings.AsNoTracking().FirstAsync(b => b.Id == booking.Id)).CheckedInAt);
    }

    /// <summary>
    /// Tenant A's code at tenant B's box identifies nobody. The two hosts share one
    /// database — the only arrangement in which this proves anything — and the refusal is
    /// the same not_recognised every other bad code gets, so the box cannot tell a foreign
    /// code from a dead one.
    /// </summary>
    [Fact]
    public async Task A_code_from_another_club_is_not_recognised_at_this_clubs_box()
    {
        var shared = $"crusaders-activate-{Guid.NewGuid():N}";
        var a = await CreateAsync(sharedDb: shared, slug: "club-a");
        var b = await CreateAsync(sharedDb: shared, slug: "club-b");
        await using var _ = a.Host;
        await using var __ = b.Host;
        using var ___ = a.Scope;
        using var ____ = b.Scope;

        // Tenant A: a booking starting now and its code.
        var bookingA = await BookAsync(a, courtIndex: 0, startsInMinutes: 1);
        var codeA = await BookingCodeAsync(a, bookingA);

        // Tenant B's box, resolving under tenant B's context.
        var boxB = await BoxOnAsync(b, 1, 2, 3, 4);
        var response = await ActivateAsync(b, boxB, codeA);

        Assert.False(response.Activated);
        Assert.Equal("not_recognised", response.Reason);
        Assert.Null(response.BookingId);

        // And nothing happened to tenant A's booking.
        Assert.Null((await a.Db.Bookings.AsNoTracking().FirstAsync(x => x.Id == bookingA.Id)).CheckedInAt);
    }
}
