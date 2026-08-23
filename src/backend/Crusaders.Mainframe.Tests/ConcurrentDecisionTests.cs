using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Webhooks;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// What happens when two people decide the same booking at once.
///
/// <para>
/// A booking is acted on by several parties — the member cancelling, an admin cancelling on
/// their behalf, the court box checking somebody in, the no-show sweep reversing a charge —
/// and every one of them read the row, decided, and wrote, with nothing in between. Two of
/// those races moved real money, and neither needed anything exotic to provoke: a double-tap
/// on a phone, or a member arriving at the pad a few seconds after a sweep began.
/// </para>
///
/// <para>
/// These drive the race deterministically rather than by threading. Two services on two
/// contexts, each holding the row as it read it, is exactly the state two concurrent HTTP
/// requests are in at the moment the second one writes — and it fails the same way every
/// run, which a <c>Task.WhenAll</c> would not.
/// </para>
///
/// <para>
/// <b>Postgres, not the in-memory provider.</b> Every guarantee here rests on one
/// SaveChanges being one transaction: the refusal has to take the ledger rows down with it,
/// or the booking is merely left un-cancelled while the money has already moved. The
/// in-memory provider has no transactions — it warns about it — so it applies the inserts
/// and then throws on the concurrency check, which is precisely the failure these tests
/// exist to catch. Written against it, they would have passed while proving the opposite.
/// </para>
/// </summary>
[Collection(HttpTestCollection.Name)]
public sealed class ConcurrentDecisionTests
{
    private readonly PostgresFixture _pg;

    public ConcurrentDecisionTests(PostgresFixture pg) => _pg = pg;

    private const decimal SlicePriceCredits = 8m;
    private const decimal BookingCost = SlicePriceCredits * 4m;

    private sealed record Club(Guid TenantId, string Slug, Guid CourtId, Guid MemberId, Guid VolunteerId);

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    /// <summary>One tenant, one court, a funded member and a funded volunteer.</summary>
    private static async Task<Club> SeedAsync(TestWebAppFactory factory)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Database.MigrateAsync();

        var slug = $"race-{Guid.NewGuid():N}"[..20];
        var tenant = new Tenant { Slug = slug, DisplayName = "Race Club" };
        db.Tenants.Add(tenant);
        db.TenantSettings.Add(new TenantSettings
        {
            TenantId = tenant.Id,
            // A wide advance window and no peak-hours block, so these tests are about the
            // race rather than about the booking rules.
            SettingsJson = """{"slice_minutes":15,"slice_price_credits":8,"grace_window_minutes":5,"penalty_pct":30,"penalty_window_minutes":15,"advance_booking_days":30,"timezone":"UTC"}""",
        });

        var member = new User { TenantId = tenant.Id, Email = $"m-{slug}@test.local", PasswordHash = "x", EmailVerified = true };
        var volunteer = new User { TenantId = tenant.Id, Email = $"v-{slug}@test.local", PasswordHash = "x", EmailVerified = true };
        db.Users.AddRange(member, volunteer);
        db.Memberships.AddRange(
            new Membership { TenantId = tenant.Id, UserId = member.Id, FullName = "Race Member", MembershipNumber = $"M-{slug}", Status = MembershipStatus.Active },
            new Membership { TenantId = tenant.Id, UserId = volunteer.Id, FullName = "Race Volunteer", MembershipNumber = $"V-{slug}", Status = MembershipStatus.Active });

        var court = new Court { TenantId = tenant.Id, CourtNumber = 1, Name = "Court 1", SlicePriceCredits = SlicePriceCredits };
        var court2 = new Court { TenantId = tenant.Id, CourtNumber = 2, Name = "Court 2", SlicePriceCredits = SlicePriceCredits };
        db.Courts.AddRange(court, court2);

        db.LedgerEntries.AddRange(
            new LedgerEntry { TenantId = tenant.Id, UserId = member.Id, Type = LedgerEntryType.TopUp, AmountCredits = 200m, ActorUserId = member.Id, Reason = "seed" },
            new LedgerEntry { TenantId = tenant.Id, UserId = volunteer.Id, Type = LedgerEntryType.TopUp, AmountCredits = 200m, ActorUserId = volunteer.Id, Reason = "seed" });

        await db.SaveChangesAsync();
        return new Club(tenant.Id, slug, court.Id, member.Id, volunteer.Id);
    }

    /// <summary>A scope with the tenant resolved — one HTTP request's worth of services.</summary>
    private static IServiceScope RequestScope(TestWebAppFactory factory, Club club)
    {
        var scope = factory.Services.CreateScope();
        scope.ServiceProvider.GetRequiredService<ITenantContext>().Set(club.TenantId, club.Slug);
        return scope;
    }

    private static async Task<decimal> BalanceAsync(TestWebAppFactory factory, Club club, Guid userId)
    {
        using var scope = RequestScope(factory, club);
        return await scope.ServiceProvider.GetRequiredService<LedgerService>().GetBalanceAsync(userId, default);
    }

    /// <summary>A charged booking a long way ahead, so no booking rule refuses it.</summary>
    private static async Task<Guid> BookAsync(TestWebAppFactory factory, Club club)
    {
        using var scope = RequestScope(factory, club);
        var bookings = scope.ServiceProvider.GetRequiredService<BookingService>();
        var result = await bookings.CreateAsync(
            club.CourtId, club.MemberId, club.MemberId, TestHost.BookableSlot(48), sliceCount: 4, default);
        return Assert.IsType<BookingResult.Ok>(result).Booking.Id;
    }

    /// <summary>A booking already past its grace window, seeded rather than created.</summary>
    private static Task<Guid> SeedDueNoShowAsync(TestWebAppFactory factory, Club club)
        => SeedDueNoShowOnAsync(factory, club, courtNumber: 1);

    private static async Task<Guid> SeedDueNoShowOnAsync(TestWebAppFactory factory, Club club, int courtNumber)
    {
        using var scope = RequestScope(factory, club);
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var courtId = await db.Courts.Where(c => c.CourtNumber == courtNumber).Select(c => c.Id).FirstAsync();
        var startsAt = DateTimeOffset.UtcNow.AddMinutes(-30);
        var booking = new Booking
        {
            TenantId = club.TenantId,
            CourtId = courtId,
            UserId = club.MemberId,
            BookedByUserId = club.MemberId,
            PaidByUserId = club.MemberId,
            ActorUserId = club.MemberId,
            StartsAt = startsAt,
            EndsAt = startsAt.AddMinutes(60),
            SliceMinutes = 15,
            SliceCount = 4,
            AmountChargedCredits = BookingCost,
            Status = BookingStatus.Booked,
            ChargedAt = DateTimeOffset.UtcNow,
        };
        db.Bookings.Add(booking);
        db.LedgerEntries.Add(new LedgerEntry
        {
            TenantId = club.TenantId, UserId = club.MemberId, Type = LedgerEntryType.BookingCharge,
            AmountCredits = -BookingCost, ActorUserId = club.MemberId, RelatedBookingId = booking.Id, Reason = "seed charge",
        });
        await db.SaveChangesAsync();
        return booking.Id;
    }

    private static NoShowWorker Worker(TestWebAppFactory factory) =>
        new(factory.Services,
            factory.Services.GetRequiredService<IEventBus>(),
            NullLogger<NoShowWorker>.Instance);

    private static async Task<int> CountAsync(TestWebAppFactory factory, Club club, Guid bookingId, LedgerEntryType type)
    {
        using var scope = RequestScope(factory, club);
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        return await db.LedgerEntries.CountAsync(l => l.RelatedBookingId == bookingId && l.Type == type);
    }

    /// <summary>
    /// Cancelling twice refunds once.
    ///
    /// <para>
    /// Both requests load a <c>Booked</c> row, both pass the status check, and both post a
    /// full refund — so a booking paid back double. There was no concurrency token, no
    /// transaction and no conditional update anywhere in the API, and the cancel route has no
    /// rate limiter either: a double-tap on the PWA is all it took.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task Cancelling_the_same_booking_twice_refunds_once()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory);
        var bookingId = await BookAsync(factory, club);

        Assert.Equal(200m - BookingCost, await BalanceAsync(factory, club, club.MemberId));

        // Two requests, each holding the row as it read it — the state two concurrent
        // cancellations are in at the moment the second one writes.
        using var a = RequestScope(factory, club);
        using var b = RequestScope(factory, club);
        await a.ServiceProvider.GetRequiredService<MainframeDbContext>().Bookings.FirstAsync(x => x.Id == bookingId);
        await b.ServiceProvider.GetRequiredService<MainframeDbContext>().Bookings.FirstAsync(x => x.Id == bookingId);

        var first = await a.ServiceProvider.GetRequiredService<BookingService>()
            .CancelAsync(bookingId, club.MemberId, actorIsAdmin: false, waivePenalty: false, default);
        var second = await b.ServiceProvider.GetRequiredService<BookingService>()
            .CancelAsync(bookingId, club.MemberId, actorIsAdmin: false, waivePenalty: false, default);

        Assert.IsType<CancellationResult.Ok>(first);
        Assert.IsType<CancellationResult.NotFound>(second);

        // Back where they started, not a booking's worth better off.
        Assert.Equal(200m, await BalanceAsync(factory, club, club.MemberId));
        Assert.Equal(1, await CountAsync(factory, club, bookingId, LedgerEntryType.CancellationRefund));
    }

    /// <summary>
    /// A member who checked in is not swept as a no-show.
    ///
    /// <para>
    /// <b>What this proves and what it does not.</b> It pins the selection rule: attendance
    /// is <c>CheckedInAt</c>, and a booking carrying one is not reversed. It does <i>not</i>
    /// reproduce the interleaving the audit described — a check-in landing after the tick has
    /// materialised its due list but before it writes, which the blocking email send per
    /// booking makes a window of seconds rather than microseconds. Driving that needs a seam
    /// inside the worker's loop that does not exist, and inventing one to make a test go red
    /// would be testing the seam.
    /// </para>
    ///
    /// <para>
    /// That narrower window is closed by construction instead: the status and both movements
    /// now go in one save, so the concurrency token on the booking decides the whole sweep at
    /// once and a check-in that moved <c>Version</c> makes it match nothing.
    /// <see cref="Cancelling_the_same_booking_twice_refunds_once"/> and
    /// <see cref="Two_volunteers_at_once_reassign_the_payer_once"/> exercise that same
    /// mechanism directly, and both fail without it.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task A_member_who_checked_in_is_not_swept_as_a_no_show()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory);
        var bookingId = await SeedDueNoShowAsync(factory, club);

        var beforeSweep = await BalanceAsync(factory, club, club.MemberId);

        // The member reaches the pad before the sweep acts on its list.
        using (var pad = RequestScope(factory, club))
        {
            var padDb = pad.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var row = await padDb.Bookings.FirstAsync(x => x.Id == bookingId);
            row.CheckedInAt = DateTimeOffset.UtcNow;
            await padDb.SaveChangesAsync();
        }

        await Worker(factory).TickAsync(default);

        using var check = RequestScope(factory, club);
        var db = check.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var after = await db.Bookings.AsNoTracking().FirstAsync(x => x.Id == bookingId);

        Assert.NotNull(after.CheckedInAt);
        Assert.NotEqual(BookingStatus.NoShow, after.Status);
        Assert.Equal(beforeSweep, await BalanceAsync(factory, club, club.MemberId));
        Assert.Equal(0, await CountAsync(factory, club, bookingId, LedgerEntryType.NoShowPenalty));
    }

    /// <summary>A genuine no-show is still swept, so the guard above is a check and not a hole.</summary>
    [SkippableFact]
    public async Task A_member_who_never_arrived_is_still_swept()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory);
        var bookingId = await SeedDueNoShowAsync(factory, club);

        await Worker(factory).TickAsync(default);

        using var check = RequestScope(factory, club);
        var db = check.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var after = await db.Bookings.AsNoTracking().FirstAsync(x => x.Id == bookingId);

        Assert.Equal(BookingStatus.NoShow, after.Status);
        Assert.Equal(1, await CountAsync(factory, club, bookingId, LedgerEntryType.CancellationRefund));
        Assert.Equal(1, await CountAsync(factory, club, bookingId, LedgerEntryType.NoShowPenalty));
    }

    /// <summary>
    /// A second sweep of the same booking does not reverse it a second time.
    ///
    /// <para>
    /// The status that makes the sweep idempotent used to be set <i>after</i> the refund and
    /// penalty had already committed — <c>PostAsync</c> saves per call — so anything failing
    /// in between left the money moved and the row still <c>Booked</c>. The next tick, thirty
    /// seconds later, matched it again. Across the seven-day lookback that is roughly twenty
    /// thousand attempts at the same refund.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task Sweeping_twice_reverses_the_charge_once()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory);
        var bookingId = await SeedDueNoShowAsync(factory, club);

        var worker = Worker(factory);
        await worker.TickAsync(default);
        await worker.TickAsync(default);

        Assert.Equal(1, await CountAsync(factory, club, bookingId, LedgerEntryType.CancellationRefund));
        Assert.Equal(1, await CountAsync(factory, club, bookingId, LedgerEntryType.NoShowPenalty));

        // Charged once, refunded once, penalised once.
        var penalty = Math.Round(BookingCost * 0.30m, 2, MidpointRounding.AwayFromZero);
        Assert.Equal(200m - penalty, await BalanceAsync(factory, club, club.MemberId));
    }

    /// <summary>
    /// Two volunteers pressing "I'll pay" at once do not refund the booker twice.
    ///
    /// <para>
    /// The refund, the charge and <c>PaidByUserId</c> were three independent commits. Two
    /// concurrent scans both read a <c>currentPayer</c> the other had not yet changed, so both
    /// looked like a fresh reassignment: the booker was refunded twice against a single
    /// charge, netting a booking's worth of credits from nothing. The same happened with no
    /// concurrency at all if the first attempt died between its commits and the terminal
    /// simply rescanned.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task Two_volunteers_at_once_reassign_the_payer_once()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory);
        var bookingId = await BookAsync(factory, club);

        var bookerAfterBooking = await BalanceAsync(factory, club, club.MemberId);

        using var a = RequestScope(factory, club);
        using var b = RequestScope(factory, club);
        await a.ServiceProvider.GetRequiredService<MainframeDbContext>().Bookings.FirstAsync(x => x.Id == bookingId);
        await b.ServiceProvider.GetRequiredService<MainframeDbContext>().Bookings.FirstAsync(x => x.Id == bookingId);

        var first = await a.ServiceProvider.GetRequiredService<BookingService>()
            .ChargeOnActivationAsync(bookingId, club.VolunteerId, club.VolunteerId, default);
        var second = await b.ServiceProvider.GetRequiredService<BookingService>()
            .ChargeOnActivationAsync(bookingId, club.VolunteerId, club.VolunteerId, default);

        Assert.IsType<ChargeResult.Ok>(first);
        Assert.IsNotType<ChargeResult.Ok>(second);

        // The booker is made whole exactly once; the volunteer pays exactly once.
        Assert.Equal(bookerAfterBooking + BookingCost, await BalanceAsync(factory, club, club.MemberId));
        Assert.Equal(200m - BookingCost, await BalanceAsync(factory, club, club.VolunteerId));
    }

    /// <summary>
    /// A booking whose member is gone is still swept, and does not stop the sweep.
    ///
    /// <para>
    /// Found while writing these tests rather than by the audit, and it is the more serious
    /// of the two. <c>RetentionWorker</c> anonymises an old booking by pointing
    /// <c>UserId</c> at a sentinel Guid that has no <c>users</c> row, and the sweep looked
    /// its subject up with <c>First()</c>. That throw escapes <c>TickAsync</c>, so one
    /// anonymised booking took down the whole tick — for every tenant, on every run, every
    /// thirty seconds — until it aged past <c>no_show_lookback_days</c>. Nothing enforces
    /// that <c>retention_days</c> exceeds the lookback, and both are tenant settings, so an
    /// admin setting retention to 3 days and lookback to 7 stops their club's no-show sweep
    /// for good.
    /// </para>
    ///
    /// <para>
    /// The second booking here is the assertion that matters: it is only reached if the
    /// first one did not abort the tick.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task A_booking_with_no_subject_is_swept_without_stopping_the_sweep()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory);

        var orphaned = await SeedDueNoShowAsync(factory, club);
        var intact = await SeedDueNoShowOnAsync(factory, club, courtNumber: 2);

        // The subject disappears, exactly as retention leaves it.
        using (var scope = RequestScope(factory, club))
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var row = await db.Bookings.FirstAsync(x => x.Id == orphaned);
            row.UserId = Guid.Parse("00000000-0000-0000-0000-000000000001");
            row.PaidByUserId = club.MemberId;   // the money still belongs to whoever paid it
            await db.SaveChangesAsync();
        }

        await Worker(factory).TickAsync(default);

        using var check = RequestScope(factory, club);
        var bookings = check.ServiceProvider.GetRequiredService<MainframeDbContext>().Bookings.AsNoTracking();

        Assert.Equal(BookingStatus.NoShow, (await bookings.FirstAsync(x => x.Id == orphaned)).Status);

        // The one that proves the tick survived the first.
        Assert.Equal(BookingStatus.NoShow, (await bookings.FirstAsync(x => x.Id == intact)).Status);
        Assert.Equal(1, await CountAsync(factory, club, intact, LedgerEntryType.NoShowPenalty));
    }

    /// <summary>
    /// A member cannot spend the same credits on two courts at once.
    ///
    /// <para>
    /// Balance is the sum of immutable ledger entries and never a stored field, so there is
    /// no row to constrain: <c>GetBalanceAsync</c> is an unlocked <c>SUM</c>. Two requests
    /// for the same member on different courts both read the same balance, both find it
    /// sufficient, and both debit — leaving a member who could afford one court holding two
    /// and a balance of −32. The GiST exclusion constraint protects the slot; nothing
    /// protected the wallet.
    /// </para>
    ///
    /// <para>
    /// <b>This one has to be genuinely concurrent.</b> Run in sequence it passes either way,
    /// because the second request reads the balance the first already spent — the bug only
    /// exists in the window between the read and the write. So the two run in parallel from a
    /// shared start signal, and the assertion is on the outcome rather than the timing:
    /// exactly one booking, and a balance that never goes below zero.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task A_member_cannot_spend_the_same_credits_on_two_courts_at_once()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory);

        // Spend the member down to exactly one booking's worth.
        using (var scope = RequestScope(factory, club))
        {
            await scope.ServiceProvider.GetRequiredService<LedgerService>().PostAsync(
                new LedgerPosting(club.MemberId, LedgerEntryType.AdminAdjustment, -(200m - BookingCost), club.MemberId,
                    Reason: "spend down to one booking"), default);
        }
        Assert.Equal(BookingCost, await BalanceAsync(factory, club, club.MemberId));

        var courtIds = new List<Guid>();
        using (var scope = RequestScope(factory, club))
        {
            courtIds = await scope.ServiceProvider.GetRequiredService<MainframeDbContext>()
                .Courts.OrderBy(c => c.CourtNumber).Select(c => c.Id).ToListAsync();
        }

        var startsAt = TestHost.BookableSlot(72);
        using var gate = new SemaphoreSlim(0);

        async Task<BookingResult> Attempt(Guid courtId)
        {
            using var scope = RequestScope(factory, club);
            var bookings = scope.ServiceProvider.GetRequiredService<BookingService>();
            await gate.WaitAsync();
            return await bookings.CreateAsync(courtId, club.MemberId, club.MemberId, startsAt, sliceCount: 4, default);
        }

        var first = Attempt(courtIds[0]);
        var second = Attempt(courtIds[1]);
        gate.Release(2);
        var results = await Task.WhenAll(first, second);

        // One court, not two — and it does not matter which.
        Assert.Equal(1, results.Count(r => r is BookingResult.Ok));
        Assert.Equal(1, results.Count(r => r is BookingResult.InsufficientBalance));

        // The invariant that actually matters, whichever way the race fell.
        var balance = await BalanceAsync(factory, club, club.MemberId);
        Assert.True(balance >= 0m, $"balance went negative: {balance}");
        Assert.Equal(0m, balance);

        using var check = RequestScope(factory, club);
        var db = check.ServiceProvider.GetRequiredService<MainframeDbContext>();
        Assert.Equal(1, await db.Bookings.CountAsync(b => b.UserId == club.MemberId && b.StartsAt == startsAt));
    }
}
