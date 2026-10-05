using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Webhooks;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 13, E13-1 (I12 refined). A late check-in that reverses a no-show AFTER its off cue
/// gets one more <c>booking.lights_off</c>. It was stamped at the tick that sent it, so after a
/// collided reversal — the restored session ends where another member's booking starts — it
/// arrived after that member's <c>lights_on</c> and a per-court mirror read the court dark through
/// their paid session.
///
/// <para>
/// The rule: the extra off is said at the instant the court is next free from the restored end
/// on. Nobody holds it then → <c>occurred_at</c> = the restored end. Another live booking holds it
/// and its own off is still to come → no extra off at all (that booking's off closes the court,
/// later by arrival and by <c>occurred_at</c>). The holder is already over and cued off → the extra
/// off is stamped at the end of that holding, never inside it.
/// </para>
/// </summary>
public class R13LightsCueCollisionTests
{
    private static Booking NewBooking(TestHost host, DateTimeOffset startsAt, int minutes, BookingStatus status = BookingStatus.Booked,
        DateTimeOffset? checkedInAt = null, Guid? user = null) => new()
        {
            TenantId = host.Tenant.Id,
            CourtId = host.Courts[0].Id,
            UserId = user ?? host.PlayerUser.Id,
            BookedByUserId = user ?? host.PlayerUser.Id,
            PaidByUserId = user ?? host.PlayerUser.Id,
            StartsAt = startsAt,
            EndsAt = startsAt.AddMinutes(minutes),
            SliceMinutes = 15,
            SliceCount = minutes / 15,
            AmountChargedMinutes = minutes,
            Status = status,
            CheckedInAt = checkedInAt,
        };

    /// <summary>A reversed no-show whose reversal came after its off cue, ending at <paramref name="restoredEnd"/>.</summary>
    private static Booking Relit(TestHost host, DateTimeOffset restoredEnd)
    {
        var a = NewBooking(host, restoredEnd.AddMinutes(-30), 30, checkedInAt: restoredEnd.AddMinutes(-29));
        a.LightsOffCuedAt = restoredEnd.AddMinutes(-20);
        a.NoShowReversedAt = restoredEnd.AddMinutes(-10);
        return a;
    }

    private static async Task<List<DomainEvent>> TickAsync(TestHost host)
    {
        var worker = new LightsCueWorker(host.Services, host.Services.GetRequiredService<IEventBus>(), NullLogger<LightsCueWorker>.Instance);
        await worker.TickAsync(default);
        await worker.TickAsync(default);
        var bus = host.Services.GetRequiredService<IEventBus>();
        var emitted = new List<DomainEvent>();
        while (bus.Reader.TryRead(out var evt)) emitted.Add(evt);
        return emitted;
    }

    private static List<DomainEvent> OffsOf(List<DomainEvent> emitted, Booking b) =>
        [.. emitted.Where(e => e.Type == "booking.lights_off" && Equals(e.Data["booking_id"], b.Id))];

    private static async Task SeedAsync(TestHost host, params Booking[] bookings)
    {
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        db.Bookings.AddRange(bookings);
        await db.SaveChangesAsync();
    }

    /// <summary>Nobody else on the court: one off, said at the restored end — never at the tick that sent it.</summary>
    [Fact]
    public async Task With_the_court_free_the_extra_off_is_at_the_restored_end()
    {
        await using var host = await TestHost.CreateAsync();
        var end = DateTimeOffset.UtcNow.AddMinutes(-5);
        var a = Relit(host, end);
        await SeedAsync(host, a);

        var emitted = await TickAsync(host);

        var off = Assert.Single(OffsOf(emitted, a));
        Assert.True((off.OccurredAt - end).Duration() < TimeSpan.FromMilliseconds(1), $"occurred_at {off.OccurredAt:o}, restored end {end:o}");
        Assert.True(((DateTimeOffset)off.Data["ends_at"]! - end).Duration() < TimeSpan.FromMilliseconds(1));
        Assert.Single(emitted, e => e.Type == "booking.completed" && Equals(e.Data["booking_id"], a.Id));
    }

    /// <summary>
    /// The collision: B starts where A's restored session ends, checked in, still playing. No extra
    /// off for A — B's own off closes the court. Varied: B checked in early (before A's end), and B
    /// covering A's end rather than starting on it.
    /// </summary>
    [Theory]
    [InlineData(0, -2)]
    [InlineData(0, 1)]
    [InlineData(-15, -14)]
    public async Task Another_booking_still_holding_the_court_is_never_darkened(int bStartOffset, int bScanOffset)
    {
        await using var host = await TestHost.CreateAsync();
        var end = DateTimeOffset.UtcNow.AddMinutes(-5);
        var a = Relit(host, end);
        var b = NewBooking(host, end.AddMinutes(bStartOffset), 60, checkedInAt: end.AddMinutes(bScanOffset), user: host.LeaguePlayerUser.Id);
        await SeedAsync(host, a, b);

        var emitted = await TickAsync(host);

        Assert.Empty(OffsOf(emitted, a));
        Assert.Empty(OffsOf(emitted, b));
        Assert.Single(emitted, e => e.Type == "booking.completed" && Equals(e.Data["booking_id"], a.Id));
    }

    /// <summary>
    /// The upload came after B's session was over and cued off. A's lights_on arrived last, so A
    /// still needs its off — stamped at the end of B's holding (and of C's, back to back after it),
    /// so no ordering by occurred_at puts the court dark inside either session.
    /// </summary>
    [Fact]
    public async Task A_holding_already_over_puts_the_extra_off_at_its_end()
    {
        await using var host = await TestHost.CreateAsync();
        var end = DateTimeOffset.UtcNow.AddMinutes(-60);
        var a = Relit(host, end);
        var b = NewBooking(host, end, 15, BookingStatus.Completed, checkedInAt: end.AddMinutes(-1), user: host.LeaguePlayerUser.Id);
        b.LightsOffCuedAt = end.AddMinutes(15);
        var c = NewBooking(host, end.AddMinutes(15), 15, BookingStatus.Completed, checkedInAt: end.AddMinutes(15), user: host.AdminUser.Id);
        c.LightsOffCuedAt = end.AddMinutes(30);
        a.NoShowReversedAt = end.AddMinutes(40);
        a.LightsOffCuedAt = end.AddMinutes(-20);
        await SeedAsync(host, a, b, c);

        var emitted = await TickAsync(host);

        var off = Assert.Single(OffsOf(emitted, a));
        Assert.True((off.OccurredAt - end.AddMinutes(30)).Duration() < TimeSpan.FromMilliseconds(1), $"occurred_at {off.OccurredAt:o}");
        Assert.True(((DateTimeOffset)off.Data["ends_at"]! - end).Duration() < TimeSpan.FromMilliseconds(1));
    }

    /// <summary>A cancelled booking and a club block light nothing and hold nothing: the off is at the restored end.</summary>
    [Fact]
    public async Task A_cancelled_booking_or_a_block_does_not_hold_the_court()
    {
        await using var host = await TestHost.CreateAsync();
        var end = DateTimeOffset.UtcNow.AddMinutes(-5);
        var a = Relit(host, end);
        var cancelled = NewBooking(host, end, 60, BookingStatus.Cancelled, user: host.LeaguePlayerUser.Id);
        var block = NewBooking(host, end, 60, BookingStatus.AdminBlock);
        block.UserId = null;
        await SeedAsync(host, a, cancelled, block);

        var emitted = await TickAsync(host);

        var off = Assert.Single(OffsOf(emitted, a));
        Assert.True((off.OccurredAt - end).Duration() < TimeSpan.FromMilliseconds(1));
    }

    // ------------------------------------------------------------------ the ordinary end-of-slot off

    /// <summary>
    /// A per-court mirror's two orderings, checked for <paramref name="holder"/>'s session: by ARRIVAL,
    /// the holder is checked in — its <c>lights_on</c> went out at its scan, before this tick — so no
    /// off for the court may be emitted by the tick at all; by <c>occurred_at</c>, no off may fall
    /// inside the holder's lit session (from its scan, or its start if earlier, to its end).
    /// </summary>
    private static void AssertMirrorStaysLit(List<DomainEvent> emitted, Booking holder)
    {
        var offs = emitted.Where(e => e.Type == "booking.lights_off" && Equals(e.Data["court_id"], holder.CourtId)
                                      && !Equals(e.Data["booking_id"], holder.Id)).ToList();
        Assert.True(offs.Count == 0, $"by arrival: {offs.Count} off(s) for the court after {holder.Id}'s lights_on");
        var litFrom = holder.CheckedInAt is { } scan && scan < holder.StartsAt ? scan : holder.StartsAt;
        Assert.DoesNotContain(emitted, e => e.Type == "booking.lights_off" && Equals(e.Data["court_id"], holder.CourtId)
                                            && !Equals(e.Data["booking_id"], holder.Id)
                                            && e.OccurredAt >= litFrom && e.OccurredAt < holder.EndsAt);
    }

    /// <summary>
    /// Back to back: A's slot ends where B's starts and B is already checked in — early (before A's
    /// end), on time, or after A's end with the sweep running late. A's end-of-slot off would land
    /// after B's lights_on and read B's paid session dark: it is not sent; B's own off closes the court.
    /// A still completes, once, and is not cued twice.
    /// </summary>
    [Theory]
    [InlineData(-2)]
    [InlineData(0)]
    [InlineData(1)]
    public async Task The_end_of_slot_off_never_darkens_the_next_session_already_lit(int bScanOffset)
    {
        await using var host = await TestHost.CreateAsync();
        var end = DateTimeOffset.UtcNow.AddMinutes(-3);
        var a = NewBooking(host, end.AddMinutes(-30), 30, checkedInAt: end.AddMinutes(-29));
        var b = NewBooking(host, end, 60, checkedInAt: end.AddMinutes(bScanOffset), user: host.LeaguePlayerUser.Id);
        await SeedAsync(host, a, b);

        var emitted = await TickAsync(host);

        AssertMirrorStaysLit(emitted, b);
        Assert.Single(emitted, e => e.Type == "booking.completed" && Equals(e.Data["booking_id"], a.Id));
    }

    /// <summary>
    /// The next booking is not lit — nobody has checked in — so the court IS dark after A, and says
    /// so: one off, at A's end (never the tick's later instant, which could fall inside the next
    /// session once its member arrives). Varied: the next one a swept no-show, and a cancelled one.
    /// </summary>
    [Theory]
    [InlineData(BookingStatus.Booked)]
    [InlineData(BookingStatus.NoShow)]
    [InlineData(BookingStatus.Cancelled)]
    public async Task An_unlit_next_booking_does_not_hold_the_court(BookingStatus next)
    {
        await using var host = await TestHost.CreateAsync();
        var end = DateTimeOffset.UtcNow.AddMinutes(-3);
        var a = NewBooking(host, end.AddMinutes(-30), 30, checkedInAt: end.AddMinutes(-29));
        var b = NewBooking(host, end, 60, next, user: host.LeaguePlayerUser.Id);
        await SeedAsync(host, a, b);

        var emitted = await TickAsync(host);

        var off = Assert.Single(OffsOf(emitted, a));
        Assert.True((off.OccurredAt - end).Duration() < TimeSpan.FromMilliseconds(1), $"occurred_at {off.OccurredAt:o}, end {end:o}");
    }

    /// <summary>E13-1's late reversal follows the same rule: an adjacent booking nobody checked in on lights nothing.</summary>
    [Fact]
    public async Task A_relit_reversal_beside_an_unlit_booking_is_cued_off_at_its_restored_end()
    {
        await using var host = await TestHost.CreateAsync();
        var end = DateTimeOffset.UtcNow.AddMinutes(-5);
        var a = Relit(host, end);
        var b = NewBooking(host, end, 60, user: host.LeaguePlayerUser.Id);
        await SeedAsync(host, a, b);

        var emitted = await TickAsync(host);

        var off = Assert.Single(OffsOf(emitted, a));
        Assert.True((off.OccurredAt - end).Duration() < TimeSpan.FromMilliseconds(1));
    }
}
