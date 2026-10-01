using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Booking semantics as they actually are.
///
/// <para>
/// These five tests were left deliberately red for months (recorded in
/// <c>memory/decisions.md</c>) because they encoded the pre-blueprint economics:
/// R50 per 30-minute slice. The fixture has since moved to <b>8 credits per
/// 15-minute slice</b>, so they were asserting a system that no longer existed.
/// </para>
///
/// <para>
/// Worth noting for anyone reading the old failures: the overlap test was failing
/// because at 15-minute slices a booking at <c>startsAt + 15</c> is <em>adjacent</em>
/// to one at <c>startsAt</c>, not overlapping — accepting it was correct. It was
/// not, as it first appeared, a double-booking bug.
/// </para>
///
/// <para>
/// <b>The debit happens at booking.</b> That is the founder's decision and it
/// contradicts blueprint A.9, which debits on lights-on; the deviation is recorded
/// in <c>docs/specs/client-blueprint-deltas.md</c> for committee sign-off, and the
/// <c>CLAUDE.md</c> invariant was rewritten in the commit that moved it. What that
/// buys is a cancellation story with only one moving part: refund what was taken,
/// less a penalty if it is late, and refund nothing at all once someone has actually
/// checked in.
/// </para>
/// </summary>
public class BookingTests
{
    // TestHost fixture: slice_minutes 15, court price 8 credits, penalty_pct 30,
    // penalty_window_minutes 15.
    private const decimal SlicePriceCredits = 8;

    [Fact]
    public async Task Booking_succeeds_when_balance_covers_cost_and_slot_free()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 200, host.PlayerUser.Id), default);
        var startsAt = TestHost.BookableSlot(2);
        var result = await booking.CreateAsync(host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, startsAt, sliceCount: 1, default);

        var ok = Assert.IsType<BookingResult.Ok>(result);
        Assert.Equal(BookingStatus.Booked, ok.Booking.Status);

        // Booking reserves the slot AND debits, in one unit of work. The balance
        // returned is what the member has left, which is what the confirmation email
        // and the booking.created event both quote.
        Assert.Equal(200 - SlicePriceCredits, ok.BalanceAfterMinutes);
        Assert.Equal(200 - SlicePriceCredits, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
        Assert.NotNull(ok.Booking.ChargedAt);
    }

    [Fact]
    public async Task Booking_fails_with_insufficient_balance()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();

        var startsAt = TestHost.BookableSlot(2);
        var result = await booking.CreateAsync(host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, startsAt, 1, default);

        var ib = Assert.IsType<BookingResult.InsufficientBalance>(result);
        Assert.Equal(0, ib.CurrentMinutes);
        Assert.Equal(SlicePriceCredits, ib.RequiredMinutes);
    }

    [Fact]
    public async Task Booking_fails_when_slot_overlaps_existing_booking()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 500, host.PlayerUser.Id), default);
        var startsAt = TestHost.BookableSlot(2);

        // Two slices = 30 minutes, so a booking 15 minutes in genuinely overlaps.
        var first = await booking.CreateAsync(host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, startsAt, sliceCount: 2, default);
        Assert.IsType<BookingResult.Ok>(first);

        var overlapping = await booking.CreateAsync(host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, startsAt.AddMinutes(15), 1, default);
        Assert.IsType<BookingResult.SlotTaken>(overlapping);
    }

    [Fact]
    public async Task Booking_immediately_after_another_is_allowed()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 500, host.PlayerUser.Id), default);
        var startsAt = TestHost.BookableSlot(2);

        Assert.IsType<BookingResult.Ok>(
            await booking.CreateAsync(host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, startsAt, 1, default));

        // Back-to-back, not overlapping — the first ends exactly where this begins.
        Assert.IsType<BookingResult.Ok>(
            await booking.CreateAsync(host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, startsAt.AddMinutes(15), 1, default));
    }

    [Fact]
    public async Task Cancellation_inside_penalty_window_charges_the_penalty_only()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 200, host.PlayerUser.Id), default);

        // Starts in 5 minutes — inside the 15-minute penalty window — and therefore ENDS in
        // twenty. That is a slot that cannot be moved without leaving the window the test is
        // about, so the club is moved instead: the fixture closes at local midnight, and
        // from 23:41 local onwards this booking is refused OutOfHours and the test dies with
        // an InvalidCastException naming OutOfHours inside a test about cancellation
        // penalties. `now` comes FROM the move so the two cannot drift apart.
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var startsAt = (await TestHost.NowClearOfClosingAsync(db, host.Tenant.Id, 20)).AddMinutes(5);
        var booked = (BookingResult.Ok)await booking.CreateAsync(host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, startsAt, 1, default);

        var cancelled = (CancellationResult.Ok)await booking.CancelAsync(booked.Booking.Id, host.PlayerUser.Id, actorIsAdmin: false, waivePenalty: false, default);

        // The 8 credits taken at booking come back in full, and the penalty is taken as
        // its own movement rather than netted off the refund: a single net row cannot
        // answer "how much penalty did I pay?", which is the question a disputed
        // cancellation actually asks. 30% of 8 credits = 2.40.
        Assert.Equal(SlicePriceCredits, cancelled.RefundedMinutes);
        Assert.Equal(2.40m, cancelled.PenaltyMinutes);
        Assert.Equal(200 - 2.40m, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));

        // Both movements are on the statement, in full.
        var entries = await ledger.GetEntriesAsync(
            host.PlayerUser.Id, DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(1), default);
        Assert.Contains(entries, e => e.Type == LedgerEntryType.CancellationRefund && e.AmountMinutes == SlicePriceCredits);
        Assert.Contains(entries, e => e.Type == LedgerEntryType.LateCancellationPenalty && e.AmountMinutes == -2.40m);
    }

    [Fact]
    public async Task Cancellation_outside_penalty_window_costs_nothing()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 200, host.PlayerUser.Id), default);
        var startsAt = TestHost.BookableSlot(3);
        var booked = (BookingResult.Ok)await booking.CreateAsync(host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, startsAt, 1, default);

        var cancelled = (CancellationResult.Ok)await booking.CancelAsync(booked.Booking.Id, host.PlayerUser.Id, actorIsAdmin: false, waivePenalty: false, default);

        // Cancelled in good time: the booking charge comes straight back and no penalty
        // is taken, so the member is where they started.
        Assert.Equal(SlicePriceCredits, cancelled.RefundedMinutes);
        Assert.Equal(0, cancelled.PenaltyMinutes);
        Assert.Equal(200, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
    }

    /// <summary>
    /// The fix for a flake, tested at every hour instead of at the hour the suite runs.
    ///
    /// <para>
    /// Two cancellation tests here booked <c>UtcNow.AddHours(3)</c> and failed every
    /// afternoon, because the fixture's peak window is 16:00–19:00 UTC and blueprint A.12
    /// refuses a Regular member a peak slot more than an hour ahead. The symptom was an
    /// <c>InvalidCastException</c> naming <c>PeakHoursLeagueOnly</c> in a test about
    /// refunds — which reads as a broken cancellation and is not one.
    /// </para>
    /// </summary>
    [Fact]
    public void A_bookable_slot_is_never_inside_peak_hours_whatever_time_it_is()
    {
        foreach (var (from, ahead) in EveryStartingPoint())
        {
            var slot = TestHost.BookableSlotFrom(from, ahead);
            var where = $"(from {from:HH:mm}, +{ahead}h)";

            Assert.False(slot.Hour is >= 16 and < 19, $"slot at {slot:HH:mm} lands in peak {where}");
            Assert.True(slot > from, "a bookable slot must be in the future");

            // ...and clear of CLOSING time, which is the same promise from the other end
            // of the day and was not being kept. The hours rule is evaluated on the
            // slot's END, `day_end_minute` is 1440 here, and callers book up to four
            // slices on one slot — so an hour of headroom is what a bookable slot has to
            // leave. A slot at 23:50 ends at 00:05 and is refused OutOfHours, which made
            // MoneySurfaceTests red for about a quarter of an hour every night and green
            // for the rest of the day.
            var endsAtMinute = (slot.Hour * 60) + slot.Minute + 60;
            Assert.True(endsAtMinute <= 24 * 60, $"an hour booked from {slot:HH:mm} runs past midnight {where}");
        }
    }

    /// <summary>
    /// Every clock this helper could be handed, crossed with every lead time its callers
    /// use.
    ///
    /// <para>
    /// MINUTES as well as hours, and that is not thoroughness for its own sake: sweeping
    /// only on the hour is what let the closing-time hole above survive its first fix.
    /// Every slot an on-the-hour sweep produces lands at :00, an hour booked from 23:00
    /// ends at exactly midnight, and the new assertion passed — while a slot at 23:50,
    /// which is what the real clock hands <c>MoneySurfaceTests</c>, did not.
    /// </para>
    /// </summary>
    private static IEnumerable<(DateTimeOffset From, double Ahead)> EveryStartingPoint()
    {
        var midnight = new DateTimeOffset(2026, 9, 1, 0, 0, 0, TimeSpan.Zero);
        foreach (var minute in new[] { 0, 1, 30, 45, 50, 59 })
        {
            for (var hour = 0; hour < 24; hour++)
            {
                foreach (var ahead in new[] { 1.0, 2.0, 3.0, 5.0 })
                {
                    yield return (midnight.AddHours(hour).AddMinutes(minute), ahead);
                }
            }
        }
    }

    /// <summary>
    /// The one decision that survives from "charge on lights-on": <b>no refund once the
    /// lights have been on</b>. Under charge-at-booking that is the only branch where the
    /// member keeps nothing, so it is the branch worth guarding — get it wrong and every
    /// played game is refundable.
    ///
    /// <para>
    /// Cancelled by an admin, because a member cannot self-cancel a booking whose start
    /// has passed. Attendance is read from <c>CheckedInAt</c>, never from the clock.
    /// </para>
    /// </summary>
    [Fact]
    public async Task Cancellation_after_check_in_refunds_nothing()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();
        var db = scope.ServiceProvider.GetRequiredService<Crusaders.Mainframe.Api.Persistence.MainframeDbContext>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 200, host.PlayerUser.Id), default);

        // Thirty minutes ahead of a raw UtcNow is thirty minutes past closing for the last
        // quarter-hour of the club's day: day_end_minute is 1440, the operating-hours rule is
        // evaluated on the slot's END, and a 15-minute slice starting after 23:45 ends at 1441.
        // Real UTC 23:16 to 23:29, every night, this money test died with an
        // InvalidCastException naming OutOfHours — which reads as a broken refund and is not.
        // Taking `now` from the move makes the two one statement: delete it and this no longer
        // compiles. 30 ahead + 15 of court is 45 minutes of the club's day.
        var now = await TestHost.NowClearOfClosingAsync(db, host.Tenant.Id, minutesNeeded: 45);
        var booked = (BookingResult.Ok)await booking.CreateAsync(
            host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, now.AddMinutes(30), 1, default);
        Assert.Equal(200 - SlicePriceCredits, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));

        // They turned up and played. The clock is irrelevant; this stamp is not.
        var row = await db.Bookings.FirstAsync(b => b.Id == booked.Booking.Id);
        row.CheckedInAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync();

        var cancelled = (CancellationResult.Ok)await booking.CancelAsync(
            booked.Booking.Id, host.AdminUser.Id, actorIsAdmin: true, waivePenalty: false, default);

        Assert.Equal(0, cancelled.RefundedMinutes);
        Assert.Equal(0, cancelled.PenaltyMinutes);
        Assert.Equal(200 - SlicePriceCredits, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
    }

    /// <summary>
    /// A court a club prices at zero posts no ledger row for the booking at all (I10).
    /// </summary>
    /// <remarks>
    /// <para>
    /// Nothing exercised this branch, and it was writing a 0.00 <c>BookingCharge</c> — a row
    /// that moves no money and reads on the member's statement as a movement that did not
    /// happen, which is the harm I10 is written against, in the one place with no
    /// idempotency reference to justify it. Free courts are not hypothetical: a club running
    /// an open morning or a junior session sets <c>SlicePriceCredits</c> to zero and every
    /// booking made in it left a phantom line.
    /// </para>
    /// <para>
    /// The booking itself is unaffected — it is made, it holds the slot, and it is
    /// cancellable. Only the row is gone. The flush that inserts it still happens inside the
    /// same try that catches the overlap violation, so the slot race is decided exactly as
    /// it is on a priced court; the second half of this test is that assertion.
    /// </para>
    /// </remarks>
    [Fact]
    public Task A_court_priced_at_zero_books_the_slot_and_posts_no_ledger_row()
    {
        // P13-B1: courts carry no price; a booking always costs its length in minutes (§1.1)
        Assert.Fail($"P13-B1: courts carry no price; a booking always costs its length in minutes (§1.1)");
        return Task.CompletedTask;
    }
}
