using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Webhooks;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Money-correctness tests for the no-show sweep.
///
/// <para>
/// The worker used to post a positive <see cref="LedgerEntryType.CancellationRefund"/>
/// for the full booking value whenever <c>AmountChargedCredits &gt; 0</c>, with no check
/// that anything had ever been debited. Under charge-on-activation a no-show by
/// definition never checked in — that is the selection predicate — so no
/// <see cref="LedgerEntryType.BookingCharge"/> existed to refund. It then subtracted
/// the 30% penalty, netting the player <em>+70% of the booking value for failing to
/// turn up</em>.
/// </para>
///
/// <para>
/// The governing rule, and what these tests exist to hold: <b>a no-show can never
/// increase a member's balance.</b>
/// </para>
/// </summary>
public class NoShowWorkerTests
{
    private static NoShowWorker CreateWorker(TestHost host) =>
        new(host.Services, host.Services.GetRequiredService<IEventBus>(), NullLogger<NoShowWorker>.Instance);

    private static async Task<Booking> AddBookingAsync(
        TestHost host, MainframeDbContext db, bool charged, decimal amount = 8m,
        DateTimeOffset? startsAt = null, DateTimeOffset? endsAt = null)
    {
        var booking = new Booking
        {
            TenantId = host.Tenant.Id,
            CourtId = host.Courts[0].Id,
            UserId = host.PlayerUser.Id,
            BookedByUserId = host.PlayerUser.Id,
            PaidByUserId = host.PlayerUser.Id,
            StartsAt = startsAt ?? DateTimeOffset.UtcNow.AddHours(-1),
            EndsAt = endsAt ?? DateTimeOffset.UtcNow.AddMinutes(-45),
            SliceMinutes = 15,
            SliceCount = 1,
            AmountChargedCredits = amount,
            Status = BookingStatus.Booked,
            CheckedInAt = null,
            ChargedAt = charged ? DateTimeOffset.UtcNow.AddHours(-1) : null,
        };
        db.Bookings.Add(booking);
        await db.SaveChangesAsync();
        return booking;
    }

    /// <summary>
    /// The regression test. Before the fix this asserted +5.60 credits on the
    /// default 8-credit / 30% settings.
    /// </summary>
    [Fact]
    public async Task No_show_on_an_uncharged_booking_does_not_credit_the_member()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100m, host.PlayerUser.Id), default);
        var before = await ledger.GetBalanceAsync(host.PlayerUser.Id, default);

        await AddBookingAsync(host, db, charged: false);
        await CreateWorker(host).TickAsync(default);

        var after = await ledger.GetBalanceAsync(host.PlayerUser.Id, default);
        Assert.True(after <= before,
            $"a no-show must never increase a balance — went from {before} to {after}");
        Assert.Equal(before, after);
    }

    /// <summary>
    /// The same rule applied to what the member is <em>told</em>. The ledger rows are
    /// suppressed on an uncharged booking, but the no-show email and the
    /// <c>booking.no_show</c> webhook payload quote figures of their own — and quoting a
    /// refund and a penalty that never happened is how a member arrives convinced they are
    /// owed 5.60 credits. The numbers on the notice must be the numbers in the ledger.
    /// </summary>
    [Fact]
    public async Task No_show_on_an_uncharged_booking_quotes_zero_refund_and_zero_penalty()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        var bus = host.Services.GetRequiredService<IEventBus>();

        await AddBookingAsync(host, db, charged: false);
        await CreateWorker(host).TickAsync(default);

        // Drain what the tick emitted. The bus is a channel, so this is everything and
        // nothing else — no other producer ran.
        var emitted = new List<DomainEvent>();
        while (bus.Reader.TryRead(out var evt)) emitted.Add(evt);

        var noShow = Assert.Single(emitted, e => e.Type == "booking.no_show");
        Assert.Equal(0m, Assert.IsType<decimal>(noShow.Data["refund_credits"]));
        Assert.Equal(0m, Assert.IsType<decimal>(noShow.Data["penalty_credits"]));

        // And the email the member actually reads. 8 credits at 30% would print 2.40
        // penalty and 5.60 back; neither figure may appear when nothing was taken.
        var mail = Assert.Single(host.EmailService.Sent, m => m.Subject.Contains("ancel", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain("2.40", mail.HtmlBody);
        Assert.DoesNotContain("5.60", mail.HtmlBody);
    }

    /// <summary>
    /// Nothing was charged, so there is nothing to refund and nothing to take a
    /// penalty from. Posting either would invent money.
    /// </summary>
    [Fact]
    public async Task No_show_on_an_uncharged_booking_posts_no_ledger_rows()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        var booking = await AddBookingAsync(host, db, charged: false);
        await CreateWorker(host).TickAsync(default);

        var rows = db.LedgerEntries.Where(l => l.RelatedBookingId == booking.Id).ToList();
        Assert.Empty(rows);
    }

    /// <summary>
    /// When the player <em>was</em> charged, the club keeps the penalty and returns
    /// the rest — the behaviour the club actually wants, and the one the old code
    /// only appeared to implement.
    /// </summary>
    [Fact]
    public async Task No_show_on_a_charged_booking_refunds_the_remainder_and_keeps_the_penalty()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100m, host.PlayerUser.Id), default);
        var booking = await AddBookingAsync(host, db, charged: true, amount: 8m);
        // The charge itself, as ChargeOnActivationAsync would have posted it.
        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8m, host.PlayerUser.Id,
            RelatedBookingId: booking.Id), default);

        var before = await ledger.GetBalanceAsync(host.PlayerUser.Id, default);
        await CreateWorker(host).TickAsync(default);
        var after = await ledger.GetBalanceAsync(host.PlayerUser.Id, default);

        // 30% of 8 = 2.40 kept; 5.60 comes back.
        Assert.Equal(before + 8m - 2.40m, after);
        Assert.True(after < before + 8m, "the penalty must actually be retained");
    }

    /// <summary>
    /// The booking is still marked NoShow either way — attendance is recorded
    /// independently of whether money moved.
    /// </summary>
    [Fact]
    public async Task No_show_status_is_recorded_even_when_nothing_was_charged()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        var booking = await AddBookingAsync(host, db, charged: false);
        await CreateWorker(host).TickAsync(default);

        // The worker runs in its own DI scope with its own DbContext, so this one
        // still holds the pre-tick entity. Reload rather than read the cached copy.
        await db.Entry(booking).ReloadAsync();
        Assert.Equal(BookingStatus.NoShow, booking.Status);
    }

    /// <summary>
    /// Settling a no-show releases the court (review H5, decision 2026-08-24). The sweep
    /// truncates <c>EndsAt</c> to its own clock in the same save as the status change, so
    /// the row keeps only its elapsed portion and the rest of the slot is free to resell —
    /// without it, a member no-showing an hour keeps the club's court dark and unsellable
    /// until the original EndsAt, refund already paid.
    /// </summary>
    [Fact]
    public async Task Sweep_truncates_ends_at_to_now()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        // Past the grace window, but with most of the slot still ahead of it.
        var start = DateTimeOffset.UtcNow.AddMinutes(-30);
        var booking = await AddBookingAsync(host, db, charged: true,
            startsAt: start, endsAt: start.AddMinutes(60));

        var beforeTick = DateTimeOffset.UtcNow;
        await CreateWorker(host).TickAsync(default);
        var afterTick = DateTimeOffset.UtcNow;

        await db.Entry(booking).ReloadAsync();
        Assert.Equal(BookingStatus.NoShow, booking.Status);
        Assert.InRange(booking.EndsAt, beforeTick, afterTick);
        Assert.True(booking.EndsAt > booking.StartsAt, "the row must keep a non-empty elapsed portion");
    }

    /// <summary>
    /// The point of the truncation: the freed tail is genuinely rebookable through
    /// <c>BookingService.CreateAsync</c>'s overlap predicate, which exempts only Cancelled.
    /// Booked as an admin actor so the member-class rules stay out of the way — the overlap
    /// predicate is the thing under test.
    /// </summary>
    [Fact]
    public async Task Booking_after_swept_no_show_succeeds()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var bookings = scope.ServiceProvider.GetRequiredService<BookingService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100m, host.PlayerUser.Id), default);

        var start = DateTimeOffset.UtcNow.AddMinutes(-30);
        await AddBookingAsync(host, db, charged: true, startsAt: start, endsAt: start.AddMinutes(60));

        await CreateWorker(host).TickAsync(default);

        // Inside the swept booking's original window — only the truncation makes this free.
        var result = await bookings.CreateAsync(
            host.Courts[0].Id, host.PlayerUser.Id, host.AdminUser.Id,
            DateTimeOffset.UtcNow.AddMinutes(5), sliceCount: 1, default);

        Assert.IsType<BookingResult.Ok>(result);
    }

    /// <summary>
    /// Without a lower bound on StartsAt, enabling terminal check-in over a backlog
    /// of historical un-checked-in Booked rows would sweep all of them on the first
    /// 30-second tick.
    /// </summary>
    [Fact]
    public async Task Bookings_older_than_the_lookback_window_are_left_alone()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        var ancient = new Booking
        {
            TenantId = host.Tenant.Id,
            CourtId = host.Courts[0].Id,
            UserId = host.PlayerUser.Id,
            StartsAt = DateTimeOffset.UtcNow.AddDays(-400),
            EndsAt = DateTimeOffset.UtcNow.AddDays(-400).AddMinutes(15),
            SliceMinutes = 15,
            SliceCount = 1,
            AmountChargedCredits = 8m,
            Status = BookingStatus.Booked,
        };
        db.Bookings.Add(ancient);
        await db.SaveChangesAsync();

        await CreateWorker(host).TickAsync(default);

        await db.Entry(ancient).ReloadAsync();
        Assert.Equal(BookingStatus.Booked, ancient.Status);
    }
}
