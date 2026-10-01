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
/// for the full booking value whenever <c>AmountChargedMinutes &gt; 0</c>, with no check
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
        TestHost host, MainframeDbContext db, bool charged, int amount = 45,
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
            EndsAt = endsAt ?? DateTimeOffset.UtcNow.AddHours(-1).AddMinutes(amount),
            // The charge is the booking's length in minutes (§1.1), so the row says so too.
            SliceMinutes = amount,
            SliceCount = 1,
            AmountChargedMinutes = amount,
            Status = BookingStatus.Booked,
            CheckedInAt = null,
            ChargedAt = charged ? DateTimeOffset.UtcNow.AddHours(-1) : null,
        };
        db.Bookings.Add(booking);
        await db.SaveChangesAsync();
        return booking;
    }

    /// <summary>
    /// The regression test. Before the fix this credited the member 70% of the booking
    /// value — 32 minutes on a 45-minute court at 30%.
    /// </summary>
    [Fact]
    public async Task No_show_on_an_uncharged_booking_does_not_credit_the_member()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100, host.PlayerUser.Id), default);
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
    /// owed 32 minutes. The numbers on the notice must be the numbers in the ledger.
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
        Assert.Equal(0, Assert.IsType<int>(noShow.Data["refund_minutes"]));
        Assert.Equal(0, Assert.IsType<int>(noShow.Data["penalty_minutes"]));

        // And the email the member actually reads. 45 minutes at 30% would print a 13-minute
        // penalty and 32 back; neither figure may appear when nothing was taken.
        var mail = Assert.Single(host.EmailService.Sent, m => m.Subject.StartsWith("Missed booking", StringComparison.Ordinal));
        Assert.DoesNotContain("13 minutes", mail.HtmlBody);
        Assert.DoesNotContain("32 minutes", mail.HtmlBody);
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

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100, host.PlayerUser.Id), default);
        var booking = await AddBookingAsync(host, db, charged: true, amount: 45);
        // The charge itself, as CreateAsync would have posted it.
        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.BookingCharge, -45, host.PlayerUser.Id,
            RelatedBookingId: booking.Id), default);

        var before = await ledger.GetBalanceAsync(host.PlayerUser.Id, default);
        await CreateWorker(host).TickAsync(default);
        var after = await ledger.GetBalanceAsync(host.PlayerUser.Id, default);

        // 30% of 45 is 13.5: the penalty is rounded DOWN to 13 in the member's favour (§1.2),
        // where round-to-nearest or round-up would keep 14. 32 comes back.
        Assert.Equal(before + 45 - 13, after);
        Assert.True(after < before + 45, "the penalty must actually be retained");
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
    /// A booking swept after its own end — the worker was down, or the lookback reached
    /// it late — keeps its EndsAt. Extending it to the sweep clock grew the range forward
    /// into the next booking on the court and tripped the exclusion constraint, which
    /// threw inside the tick and stalled the sweep for every tenant. Found by the E2E
    /// scenario, not by a unit test, because the in-memory provider has no constraint.
    /// </summary>
    [Fact]
    public async Task Sweep_never_extends_a_booking_that_already_ended()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        var start = DateTimeOffset.UtcNow.AddHours(-3);
        var end = start.AddMinutes(60);
        var booking = await AddBookingAsync(host, db, charged: true, startsAt: start, endsAt: end);

        await CreateWorker(host).TickAsync(default);

        await db.Entry(booking).ReloadAsync();
        Assert.Equal(BookingStatus.NoShow, booking.Status);
        Assert.Equal(end, booking.EndsAt);
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

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100, host.PlayerUser.Id), default);

        var start = DateTimeOffset.UtcNow.AddMinutes(-30);
        await AddBookingAsync(host, db, charged: true, startsAt: start, endsAt: start.AddMinutes(60));

        await CreateWorker(host).TickAsync(default);

        // Inside the swept booking's original window — only the truncation makes this free.
        //
        // ActorIsAdmin is STATED rather than inferred from actorId != userId (D2-B13). This test
        // has always meant "book as an admin so the member rules stay out of the way" — its own
        // summary says so — and it used to get that exemption for free from the inference. It is
        // load-bearing here: the overlap predicate is the thing under test, and without the
        // exemption this booking is refused OutOfHours in the last few minutes of a UTC day,
        // which is the wall-clock trap memory/gotchas-clock.md records.
        var payer = new BookingPayer(host.PlayerUser.Id, host.AdminUser.Id, ActorIsAdmin: true);
        var result = await bookings.CreateAsync(
            host.Courts[0].Id, payer, DateTimeOffset.UtcNow.AddMinutes(5), sliceCount: 1, default);

        Assert.IsType<BookingResult.Ok>(result);
    }

    /// <summary>
    /// Late evidence of attendance undoes the settlement, and the sweep leaves it undone
    /// (review C6, the residual form).
    ///
    /// <para>
    /// A box offline past the grace window uploads its scan after the sweep has refunded
    /// and penalised the booking. The reversal posts two new rows — never an edit of the
    /// sweep's — puts the row back to <c>Booked</c> and stamps <c>CheckedInAt</c> at the
    /// scan; the next tick must then find nothing to do, because attendance is the one
    /// thing the sweep's predicate excludes. The status is what makes that true: a
    /// reversal that moved the money and left the row <c>NoShow</c> would be a member
    /// charged for a court the club's record still says they missed.
    /// </para>
    /// </summary>
    [Fact]
    public async Task A_reversed_no_show_is_not_swept_again()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var bookings = scope.ServiceProvider.GetRequiredService<BookingService>();
        var bus = host.Services.GetRequiredService<IEventBus>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100, host.PlayerUser.Id), default);
        var booking = await AddBookingAsync(host, db, charged: true, amount: 45);
        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.BookingCharge, -45, host.PlayerUser.Id,
            RelatedBookingId: booking.Id), default);

        var worker = CreateWorker(host);
        await worker.TickAsync(default);
        await db.Entry(booking).ReloadAsync();
        Assert.Equal(BookingStatus.NoShow, booking.Status);
        Assert.Equal(100 - 13, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));

        // Fifty minutes ago: inside the slot the sweep settled.
        var attendedAt = DateTimeOffset.FromUnixTimeSeconds(DateTimeOffset.UtcNow.AddMinutes(-50).ToUnixTimeSeconds());
        var result = await bookings.ReverseNoShowAsync(booking, attendedAt, Guid.Empty, default);
        var ok = Assert.IsType<NoShowReversalResult.Ok>(result);
        Assert.Equal(45, ok.RefundReversedMinutes);
        Assert.Equal(13, ok.PenaltyReversedMinutes);

        await db.Entry(booking).ReloadAsync();
        Assert.Equal(BookingStatus.Booked, booking.Status);
        Assert.Equal(attendedAt, booking.CheckedInAt);
        // Charged once, and that is all: the refund is back out and the penalty back in.
        Assert.Equal(55, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));

        await worker.TickAsync(default);

        await db.Entry(booking).ReloadAsync();
        Assert.Equal(BookingStatus.Booked, booking.Status);
        Assert.Equal(attendedAt, booking.CheckedInAt);
        Assert.Equal(55, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));

        // The charge, the sweep's two rows, and the two reversing them — four settlement
        // rows, each type netting to nothing, none of them netted into one.
        var rows = db.LedgerEntries.Where(l => l.RelatedBookingId == booking.Id).ToList();
        Assert.Equal(5, rows.Count);
        Assert.Equal(0, rows.Where(l => l.Type == LedgerEntryType.CancellationRefund).Sum(l => l.AmountMinutes));
        Assert.Equal(0, rows.Where(l => l.Type == LedgerEntryType.NoShowPenalty).Sum(l => l.AmountMinutes));
        Assert.Equal(2, rows.Count(l => l.Type == LedgerEntryType.CancellationRefund));
        Assert.Equal(2, rows.Count(l => l.Type == LedgerEntryType.NoShowPenalty));

        // The member is told, and the event stream learns — the mirror of booking.no_show.
        Assert.Contains(host.EmailService.Sent, m => m.Subject.StartsWith("No-show reversed", StringComparison.Ordinal));
        var emitted = new List<DomainEvent>();
        while (bus.Reader.TryRead(out var evt)) emitted.Add(evt);
        Assert.Single(emitted, e => e.Type == "booking.no_show");
        var reversed = Assert.Single(emitted, e => e.Type == "booking.no_show_reversed");
        Assert.Equal(45, Assert.IsType<int>(reversed.Data["refund_minutes"]));
        Assert.Equal(13, Assert.IsType<int>(reversed.Data["penalty_minutes"]));
        Assert.Equal(booking.Id, reversed.Data["booking_id"]);
    }

    /// <summary>
    /// The desk got there first, in the direction the form invites: an admin adjustment
    /// returning the <b>penalty</b> and naming the booking, posted before the box's evidence
    /// arrived. The reversal nets it against the leg it repaired and posts the other one.
    ///
    /// <para>
    /// This test previously asserted <b>100</b> — a played court, free — because the
    /// reversal read "a positive adjustment names this booking" as "the desk already fixed
    /// this" and dropped both money legs (round-3 finding 2). The honest answer is 55: the
    /// member played, so they owe the court's price, once. Settlement model I2, I3.
    /// </para>
    /// </summary>
    [Fact]
    public async Task A_desk_penalty_refund_nets_the_penalty_leg_and_the_refund_still_reverses()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var bookings = scope.ServiceProvider.GetRequiredService<BookingService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100, host.PlayerUser.Id), default);
        var booking = await AddBookingAsync(host, db, charged: true, amount: 45);
        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.BookingCharge, -45, host.PlayerUser.Id,
            RelatedBookingId: booking.Id), default);

        await CreateWorker(host).TickAsync(default);
        await db.Entry(booking).ReloadAsync();
        Assert.Equal(BookingStatus.NoShow, booking.Status);
        Assert.Equal(100 - 13, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));

        // The desk compensates by hand, naming the booking — the penalty back, say.
        var adjustment = await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.AdminAdjustment, 13, host.AdminUser.Id,
            RelatedBookingId: booking.Id, Reason: "Sorry — the box was offline"), default);
        Assert.Equal(100, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));

        var attendedAt = DateTimeOffset.FromUnixTimeSeconds(DateTimeOffset.UtcNow.AddMinutes(-50).ToUnixTimeSeconds());
        var result = await bookings.ReverseNoShowAsync(booking, attendedAt, Guid.Empty, default);
        var ok = Assert.IsType<NoShowReversalResult.Ok>(result);
        Assert.True(ok.ManuallyCompensated);
        Assert.Equal(45, ok.RefundReversedMinutes);     // the refund always comes back out
        Assert.Equal(0, ok.PenaltyReversedMinutes);     // the desk already returned it

        await db.Entry(booking).ReloadAsync();
        Assert.Equal(BookingStatus.Booked, booking.Status);
        Assert.Equal(attendedAt, booking.CheckedInAt);

        // 100 seeded − 45 charged: the member played, and owes the court once.
        Assert.Equal(55, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
        var refunds = db.LedgerEntries.Where(l => l.RelatedBookingId == booking.Id && l.Type == LedgerEntryType.CancellationRefund).ToList();
        Assert.Equal(2, refunds.Count);
        Assert.Equal(0, refunds.Sum(l => l.AmountMinutes));
        // One penalty row only — the sweep's. The desk's adjustment is what returned it.
        Assert.Single(db.LedgerEntries.Where(l => l.RelatedBookingId == booking.Id && l.Type == LedgerEntryType.NoShowPenalty));

        var audit = Assert.Single(db.AuditLogs.Where(a => a.Action == "booking.no_show_reversed"));
        Assert.Contains("manual_compensation", audit.DetailsJson);
        Assert.Contains(adjustment.Id.ToString(), audit.DetailsJson);   // the ids the netting used
    }

    /// <summary>
    /// The desk got there first in the <b>other</b> direction: a single negative adjustment
    /// undoing the whole settlement by hand. Matching compensation on sign alone never saw
    /// this one, so the reversal ran on top of it and charged the member twice — their next
    /// booking then refused on balance.
    ///
    /// <para>
    /// Netted per leg it lands on the same 55 as every other route: the refund leg is
    /// already 32 of the way back, so 13 comes out and 13 goes back in. Settlement
    /// model I3.
    /// </para>
    /// </summary>
    [Fact]
    public async Task A_desk_correction_in_the_other_direction_is_netted_and_not_applied_twice()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var bookings = scope.ServiceProvider.GetRequiredService<BookingService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100, host.PlayerUser.Id), default);
        var booking = await AddBookingAsync(host, db, charged: true, amount: 45);
        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.BookingCharge, -45, host.PlayerUser.Id,
            RelatedBookingId: booking.Id), default);

        await CreateWorker(host).TickAsync(default);
        await db.Entry(booking).ReloadAsync();
        Assert.Equal(100 - 13, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));

        // The desk undoes the whole settlement by hand: refund out, penalty back, net −32.
        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.AdminAdjustment, -32, host.AdminUser.Id,
            RelatedBookingId: booking.Id, Reason: "Box was offline — putting the sweep back"), default);
        Assert.Equal(55, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));

        var attendedAt = DateTimeOffset.FromUnixTimeSeconds(DateTimeOffset.UtcNow.AddMinutes(-50).ToUnixTimeSeconds());
        var ok = Assert.IsType<NoShowReversalResult.Ok>(
            await bookings.ReverseNoShowAsync(booking, attendedAt, Guid.Empty, default));
        Assert.Equal(13, ok.RefundReversedMinutes);
        Assert.Equal(13, ok.PenaltyReversedMinutes);

        // Still 55. The member is not corrected twice.
        Assert.Equal(55, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
        await db.Entry(booking).ReloadAsync();
        Assert.Equal(BookingStatus.Booked, booking.Status);
    }

    /// <summary>
    /// An adjustment naming this booking but sitting on <b>somebody else's</b> wallet is not
    /// compensation to this payer (round-3 finding 17). The reversal must run in full.
    /// Settlement model I4 — the endpoint now refuses to create the row at all, and this
    /// pins the service against rows that predate that validation.
    /// </summary>
    [Fact]
    public async Task An_adjustment_on_another_members_wallet_does_not_net_this_payers_legs()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var bookings = scope.ServiceProvider.GetRequiredService<BookingService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100, host.PlayerUser.Id), default);
        var booking = await AddBookingAsync(host, db, charged: true, amount: 45);
        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.BookingCharge, -45, host.PlayerUser.Id,
            RelatedBookingId: booking.Id), default);

        await CreateWorker(host).TickAsync(default);
        await db.Entry(booking).ReloadAsync();
        Assert.Equal(BookingStatus.NoShow, booking.Status);

        // The desk pays the admin's own wallet while pasting this member's booking id.
        await ledger.PostAsync(new LedgerPosting(host.AdminUser.Id, LedgerEntryType.AdminAdjustment, 13, host.AdminUser.Id,
            RelatedBookingId: booking.Id, Reason: "wrong wallet"), default);

        var attendedAt = DateTimeOffset.FromUnixTimeSeconds(DateTimeOffset.UtcNow.AddMinutes(-50).ToUnixTimeSeconds());
        var ok = Assert.IsType<NoShowReversalResult.Ok>(
            await bookings.ReverseNoShowAsync(booking, attendedAt, Guid.Empty, default));
        Assert.False(ok.ManuallyCompensated);
        Assert.Equal(45, ok.RefundReversedMinutes);
        Assert.Equal(13, ok.PenaltyReversedMinutes);
        Assert.Equal(55, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
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
            AmountChargedMinutes = 8,
            Status = BookingStatus.Booked,
        };
        db.Bookings.Add(ancient);
        await db.SaveChangesAsync();

        await CreateWorker(host).TickAsync(default);

        await db.Entry(ancient).ReloadAsync();
        Assert.Equal(BookingStatus.Booked, ancient.Status);
    }

    /// <summary>
    /// <b>R3 K-F2, the money test.</b> The mail and the webhook quote the <b>two</b> figures
    /// the ledger holds, and neither of them quotes a third one that does not exist.
    ///
    /// <para>
    /// The sweep posted <c>CancellationRefund +50.00</c> and <c>NoShowPenalty −15.00</c> — the
    /// two rows I11 requires and forbids netting — and then mailed the member "Refunded to your
    /// credit: 35.00 credits. Late-cancellation penalty applied: 15.00 credits." 35.00 appears
    /// nowhere in the ledger, so a member reconciling the mail against <c>/wallet</c> cannot
    /// make the two agree; read as English the two sentences deduct the 15 twice; and
    /// <c>booking.no_show</c> carried the same 35 to every programmatic consumer. The identical
    /// template on the *cancellation* path passed the gross leg, so one sentence meant two
    /// different things depending on which worker sent it.
    /// </para>
    ///
    /// <para>
    /// Mutation-proved: restoring <c>b.AmountChargedMinutes - penalty</c> in <c>SweepOneAsync</c>
    /// puts 35.00 back into both the mail and the event, and this test fails on the refund
    /// figure in each. The fixture varies the length so the arithmetic cannot coincide — at
    /// 45 minutes and 30% the gross (45), the net (32) and the penalty (13, rounded down from
    /// 13.5 in the member's favour) are three distinct numbers.
    /// </para>
    /// </summary>
    [Fact]
    public async Task A_swept_no_show_quotes_the_gross_refund_and_names_the_penalty_a_no_show_penalty()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var bus = host.Services.GetRequiredService<IEventBus>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 200, host.PlayerUser.Id), default);
        var booking = await AddBookingAsync(host, db, charged: true, amount: 45);
        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.BookingCharge, -45, host.PlayerUser.Id,
            RelatedBookingId: booking.Id), default);

        await CreateWorker(host).TickAsync(default);

        // What the ledger actually holds: two rows, never netted.
        var rows = db.LedgerEntries.Where(l => l.RelatedBookingId == booking.Id).ToList();
        Assert.Equal(45, Assert.Single(rows, l => l.Type == LedgerEntryType.CancellationRefund).AmountMinutes);
        Assert.Equal(-13, Assert.Single(rows, l => l.Type == LedgerEntryType.NoShowPenalty).AmountMinutes);

        var mail = Assert.Single(host.EmailService.Sent, m => m.Subject.StartsWith("Missed booking", StringComparison.Ordinal));

        // The gross leg, as posted. 32 is the netted figure and belongs nowhere.
        Assert.Contains(MoneyFormat.Minutes(45), mail.HtmlBody);
        Assert.DoesNotContain(MoneyFormat.Minutes(32), mail.HtmlBody);

        // A NoShowPenalty is not a late-cancellation penalty, and the member cancelled nothing.
        Assert.Contains("No-show penalty", mail.HtmlBody);
        Assert.DoesNotContain("Late-cancellation", mail.HtmlBody);
        Assert.DoesNotContain("Cancelled", mail.HtmlBody);
        Assert.DoesNotContain("(no-show)", mail.Subject);

        // And the webhook mirrors the same event stream — §9 — so it carries the same figure.
        var emitted = new List<DomainEvent>();
        while (bus.Reader.TryRead(out var evt)) emitted.Add(evt);
        var noShow = Assert.Single(emitted, e => e.Type == "booking.no_show");
        Assert.Equal(45, Assert.IsType<int>(noShow.Data["refund_minutes"]));
        Assert.Equal(13, Assert.IsType<int>(noShow.Data["penalty_minutes"]));
    }
}
