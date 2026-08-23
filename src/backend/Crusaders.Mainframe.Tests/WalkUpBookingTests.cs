using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Walk-ups: a member buying light time at the court, there and then.
///
/// <para>
/// The decision on record is that a walk-up is a <b>real booking</b> — in the member's name,
/// visible online immediately, charged and refunded by the same rules as one made from the
/// app. That is what keeps there being one money path instead of two, and it is why these
/// tests assert on ledger rows and schedule visibility rather than on a bespoke result type.
/// </para>
///
/// <para>
/// Two things are genuinely new. A walk-up is <b>truncated at the next booking</b>, and it is
/// therefore <b>charged pro rata</b> — the first fractional price in the system. Before this,
/// <c>SliceCount</c> was an integer and the tariff a flat multiple of it, so a twenty-minute
/// sale at a fifteen-minute tariff had no representation at all.
/// </para>
/// </summary>
public class WalkUpBookingTests
{
    // TestHost fixture: 15-minute slices at 8 credits, so 0.5333… credits per minute.
    private const decimal SlicePriceCredits = 8m;
    private const int SliceMinutes = 15;

    private sealed record Fixture(
        TestHost Host, IServiceScope Scope, BookingService Bookings,
        LedgerService Ledger, MainframeDbContext Db);

    private static async Task<Fixture> CreateAsync(decimal topUpCredits = 200m)
    {
        var host = await TestHost.CreateAsync();
        var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();

        if (topUpCredits > 0)
        {
            await ledger.PostAsync(
                new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, topUpCredits, host.PlayerUser.Id), default);
        }

        return new Fixture(
            host, scope,
            scope.ServiceProvider.GetRequiredService<BookingService>(),
            ledger,
            scope.ServiceProvider.GetRequiredService<MainframeDbContext>());
    }

    /// <summary>
    /// Someone else's booking on the same court, placed relative to now.
    ///
    /// <para>
    /// The half-minute cushion is what makes the truncation assertions deterministic. The
    /// walk-up floors its granted time to whole minutes — it must never sell past the next
    /// booking's start — so a blocking booking placed at exactly <c>now + 20m</c> is
    /// <c>now + 19m 59.9s</c> by the time the service reads the clock, and the sale is
    /// nineteen minutes. That is the service behaving correctly and the test measuring
    /// carelessly. Offsetting by 30 seconds puts the boundary well inside a minute, so the
    /// floor lands on the same number however slowly the test runs.
    /// </para>
    /// </summary>
    private static async Task AddBookingAsync(Fixture f, int startsInMinutes, int minutes, int plusSeconds = 30)
    {
        var startsAt = DateTimeOffset.UtcNow.AddMinutes(startsInMinutes).AddSeconds(plusSeconds);
        f.Db.Bookings.Add(new Booking
        {
            TenantId = f.Host.Tenant.Id,
            CourtId = f.Host.Courts[0].Id,
            UserId = f.Host.LeaguePlayerUser.Id,
            BookedByUserId = f.Host.LeaguePlayerUser.Id,
            PaidByUserId = f.Host.LeaguePlayerUser.Id,
            ActorUserId = f.Host.LeaguePlayerUser.Id,
            StartsAt = startsAt,
            EndsAt = startsAt.AddMinutes(minutes),
            SliceMinutes = SliceMinutes,
            SliceCount = minutes / SliceMinutes,
            AmountChargedCredits = SlicePriceCredits * (minutes / SliceMinutes),
            Status = BookingStatus.Booked,
            ChargedAt = DateTimeOffset.UtcNow,
        });
        await f.Db.SaveChangesAsync();
    }

    private static Task<BookingResult> WalkUpAsync(Fixture f, int minutes) =>
        f.Bookings.CreateWalkUpAsync(
            f.Host.Courts[0].Id, f.Host.PlayerUser.Id, f.Host.PlayerUser.Id, minutes, default);

    // ---- Pricing ----------------------------------------------------------

    /// <summary>
    /// A clear court sells exactly what was asked for, at the flat tariff. An hour is four
    /// fifteen-minute slices, so pro rata and per-slice must agree here — if they disagree
    /// on the easy case the arithmetic is wrong before truncation is even involved.
    /// </summary>
    [Fact]
    public async Task A_walk_up_on_a_clear_court_costs_the_ordinary_tariff()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var ok = Assert.IsType<BookingResult.Ok>(await WalkUpAsync(f, 60));

        Assert.Equal(32m, ok.Booking.AmountChargedCredits);   // 4 slices at 8
        Assert.Equal(200m - 32m, await f.Ledger.GetBalanceAsync(f.Host.PlayerUser.Id, default));
        Assert.Equal(60, (int)(ok.Booking.EndsAt - ok.Booking.StartsAt).TotalMinutes);
    }

    /// <summary>
    /// The case the flat tariff could not express. Twenty minutes at 8 credits per fifteen
    /// is 10.666…, and the ledger works to two places — so the member is charged 10.67 and
    /// the club is not left holding a third of a cent it cannot account for.
    /// </summary>
    [Fact]
    public async Task A_partial_slice_is_charged_pro_rata_and_rounded_to_the_ledger_scale()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        // Someone has the court in 20 minutes, so that is all there is to sell.
        await AddBookingAsync(f, startsInMinutes: 20, minutes: 30);

        var ok = Assert.IsType<BookingResult.Ok>(await WalkUpAsync(f, 60));

        Assert.Equal(20, (int)(ok.Booking.EndsAt - ok.Booking.StartsAt).TotalMinutes);
        Assert.Equal(10.67m, ok.Booking.AmountChargedCredits);
        Assert.Equal(200m - 10.67m, await f.Ledger.GetBalanceAsync(f.Host.PlayerUser.Id, default));
    }

    /// <summary>
    /// The row has to describe the time it actually sold. Every other booking satisfies
    /// <c>SliceMinutes × SliceCount == EndsAt − StartsAt</c>, and a walk-up that broke that
    /// would misreport its own duration to the schedule, the reports and the court box.
    /// </summary>
    [Fact]
    public async Task A_truncated_walk_up_describes_its_real_duration()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        await AddBookingAsync(f, startsInMinutes: 25, minutes: 30);

        var ok = Assert.IsType<BookingResult.Ok>(await WalkUpAsync(f, 60));
        var b = ok.Booking;

        Assert.Equal(
            (int)(b.EndsAt - b.StartsAt).TotalMinutes,
            b.SliceMinutes * b.SliceCount);
        Assert.Equal(25, b.SliceMinutes * b.SliceCount);
    }

    // ---- Truncation edges -------------------------------------------------

    /// <summary>A court someone is playing on right now has no time to sell at any price.</summary>
    [Fact]
    public async Task A_walk_up_on_a_court_that_is_in_use_is_refused()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        await AddBookingAsync(f, startsInMinutes: -5, minutes: 30, plusSeconds: 0);

        Assert.IsType<BookingResult.SlotTaken>(await WalkUpAsync(f, 30));
        Assert.Equal(200m, await f.Ledger.GetBalanceAsync(f.Host.PlayerUser.Id, default));
    }

    /// <summary>
    /// Truncated to nothing. Reported apart from <see cref="BookingResult.SlotTaken"/> on
    /// purpose: the court is free and the next player is simply imminent, and a 16×2 LCD
    /// saying "court busy" when nobody is on it sends the member away for no reason.
    /// </summary>
    [Fact]
    public async Task A_walk_up_with_no_time_before_the_next_booking_is_refused_as_such()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        // Strictly ahead — so the court is genuinely free — but not by a whole minute, which
        // is the smallest unit that can be sold.
        await AddBookingAsync(f, startsInMinutes: 0, minutes: 30, plusSeconds: 30);

        var refused = Assert.IsType<BookingResult.NoTimeAvailable>(await WalkUpAsync(f, 30));
        Assert.Equal(30, refused.RequestedMinutes);
        Assert.Equal(200m, await f.Ledger.GetBalanceAsync(f.Host.PlayerUser.Id, default));
    }

    /// <summary>A cancelled booking is history, not an obstruction — its slot is on sale.</summary>
    [Fact]
    public async Task A_cancelled_booking_does_not_truncate_a_walk_up()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        await AddBookingAsync(f, startsInMinutes: 20, minutes: 30);
        var blocking = await f.Db.Bookings.FirstAsync(b => b.UserId == f.Host.LeaguePlayerUser.Id);
        blocking.Status = BookingStatus.Cancelled;
        await f.Db.SaveChangesAsync();

        var ok = Assert.IsType<BookingResult.Ok>(await WalkUpAsync(f, 60));
        Assert.Equal(60, (int)(ok.Booking.EndsAt - ok.Booking.StartsAt).TotalMinutes);
    }

    // ---- It is a real booking ---------------------------------------------

    /// <summary>
    /// The point of the decision. A walk-up is in the member's name, in the schedule, and
    /// paid for out of the same ledger — not a side channel that reconciles separately.
    /// </summary>
    [Fact]
    public async Task A_walk_up_is_an_ordinary_booking_in_the_members_name()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var ok = Assert.IsType<BookingResult.Ok>(await WalkUpAsync(f, 30));

        var stored = await f.Db.Bookings.AsNoTracking().FirstAsync(b => b.Id == ok.Booking.Id);
        Assert.Equal(f.Host.PlayerUser.Id, stored.UserId);
        Assert.Equal(f.Host.PlayerUser.Id, stored.PaidByUserId);
        Assert.Equal(BookingStatus.Booked, stored.Status);
        Assert.NotNull(stored.ChargedAt);

        var charge = Assert.Single(await f.Db.LedgerEntries
            .Where(l => l.RelatedBookingId == ok.Booking.Id && l.Type == LedgerEntryType.BookingCharge)
            .ToListAsync());
        Assert.Equal(-16m, charge.AmountCredits);

        Assert.Single(await f.Db.AuditLogs.Where(a => a.Action == "booking.walk_up_created").ToListAsync());
    }

    /// <summary>
    /// Attendance is not stamped here. It comes from <c>CourtActivationService</c> like every
    /// other identification, so there is still exactly one producer of <c>CheckedInAt</c> and
    /// <c>booking.lights_on</c> — the whole point of extracting that service.
    /// </summary>
    [Fact]
    public async Task A_walk_up_is_checked_in_by_the_activation_path_not_at_creation()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var ok = Assert.IsType<BookingResult.Ok>(await WalkUpAsync(f, 30));
        Assert.Null(ok.Booking.CheckedInAt);

        var activation = f.Scope.ServiceProvider.GetRequiredService<CourtActivationService>();
        var result = await activation.ActivateAsync(
            f.Host.Courts[0], ok.Booking, f.Host.PlayerUser.Id, null, "qr", default);

        var activated = Assert.IsType<ActivationResult.Activated>(result);
        Assert.False(activated.AlreadyActive);

        var stored = await f.Db.Bookings.AsNoTracking().FirstAsync(b => b.Id == ok.Booking.Id);
        Assert.NotNull(stored.CheckedInAt);

        // Charged once, at creation — activation settles who pays, it does not re-charge.
        Assert.Single(await f.Db.LedgerEntries
            .Where(l => l.RelatedBookingId == ok.Booking.Id && l.Type == LedgerEntryType.BookingCharge)
            .ToListAsync());
        Assert.Equal(200m - 16m, await f.Ledger.GetBalanceAsync(f.Host.PlayerUser.Id, default));
    }

    /// <summary>
    /// The court does not light up on credit. Same rule as an online booking, and the same
    /// consequence: nothing is written, so there is nothing to unwind.
    /// </summary>
    [Fact]
    public async Task A_walk_up_the_member_cannot_afford_is_refused_and_writes_nothing()
    {
        var f = await CreateAsync(topUpCredits: 5m);
        await using var _ = f.Host;
        using var __ = f.Scope;

        var refused = Assert.IsType<BookingResult.InsufficientBalance>(await WalkUpAsync(f, 30));
        Assert.Equal(5m, refused.CurrentCredits);
        Assert.Equal(16m, refused.RequiredCredits);

        Assert.Empty(await f.Db.Bookings.ToListAsync());
        Assert.Equal(5m, await f.Ledger.GetBalanceAsync(f.Host.PlayerUser.Id, default));
    }
}
