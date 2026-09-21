using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Webhooks;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
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

    private sealed record Club(Guid TenantId, string Slug, Guid CourtId, Guid MemberId, Guid VolunteerId, Guid DeviceId);

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
            // A wide advance window, a high per-day cap and no peak-hours block, so these
            // tests are about the RACE and not about the booking rules. The cap especially:
            // two 60-minute bookings total 120 minutes, and the default 60-minute cap would
            // otherwise refuse the second for the cap rather than the balance — and which
            // limit a concurrent attempt hits first is exactly the timing this test must not
            // depend on.
            SettingsJson = """{"slice_minutes":15,"day_start_minute":0,"day_end_minute":1440,"slice_price_credits":8,"grace_window_minutes":5,"penalty_pct":30,"penalty_window_minutes":15,"advance_booking_days":30,"member_per_day_max_minutes":600,"timezone":"UTC"}""",
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

        // One box driving both courts, for the walk-up race.
        var device = new Device
        {
            TenantId = tenant.Id,
            DeviceCode = "court-box-1",
            Name = "Race box",
            Kind = DeviceKind.CourtBox,
            MacAddress = "ee0000000001",
            CourtNumbers = [1, 2],
        };
        db.Devices.Add(device);

        db.LedgerEntries.AddRange(
            new LedgerEntry { TenantId = tenant.Id, UserId = member.Id, Type = LedgerEntryType.TopUp, AmountCredits = 200m, ActorUserId = member.Id, Reason = "seed" },
            new LedgerEntry { TenantId = tenant.Id, UserId = volunteer.Id, Type = LedgerEntryType.TopUp, AmountCredits = 200m, ActorUserId = volunteer.Id, Reason = "seed" });

        await db.SaveChangesAsync();
        return new Club(tenant.Id, slug, court.Id, member.Id, volunteer.Id, device.Id);
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

    /// <summary>
    /// Two back-to-back bookings on one court, both long finished — the shape the sweep meets
    /// after an API outage, when the lookback reaches bookings past their own end.
    /// </summary>
    private static async Task<(Guid First, Guid Second, DateTimeOffset FirstEnd)> SeedTwoEndedBookingsAsync(
        TestWebAppFactory factory, Club club)
    {
        using var scope = RequestScope(factory, club);
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        // Storable, not raw UtcNow: firstEnd is asserted for equality against the row read
        // back, and a Postgres timestamptz cannot hold the 100 ns remainder a Linux clock
        // puts on UtcNow. See TestHost.Storable — this exact line was five red CI runs.
        var firstStart = TestHost.UtcNowStorable().AddHours(-3);
        var firstEnd = firstStart.AddMinutes(60);
        var ids = new List<Guid>();
        foreach (var (start, end) in new[] { (firstStart, firstEnd), (firstEnd, firstEnd.AddMinutes(60)) })
        {
            var booking = new Booking
            {
                TenantId = club.TenantId,
                CourtId = club.CourtId,
                UserId = club.MemberId,
                BookedByUserId = club.MemberId,
                PaidByUserId = club.MemberId,
                ActorUserId = club.MemberId,
                StartsAt = start,
                EndsAt = end,
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
            ids.Add(booking.Id);
        }
        await db.SaveChangesAsync();
        return (ids[0], ids[1], firstEnd);
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
    /// Two uploads of the same late evidence reverse a swept no-show once.
    ///
    /// <para>
    /// A box that lost the acknowledgement re-offers its queue, and a flapping link can
    /// have two uploads in flight together. Each loads the <c>NoShow</c> row, each decides
    /// to reverse it; the payer lock serialises them and the concurrency token refuses the
    /// second's write, so the loser reports <see cref="NoShowReversalResult.Lost"/> with
    /// nothing written — and the reference on each reversal row is the backstop if the
    /// token ever did not. Genuinely concurrent, from a shared start signal, because in
    /// sequence the second would simply find the row already <c>Booked</c>.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task Concurrent_late_activations_reverse_a_swept_no_show_once()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory);
        var bookingId = await SeedDueNoShowAsync(factory, club);

        await Worker(factory).TickAsync(default);
        var penalty = Math.Round(BookingCost * 0.30m, 2, MidpointRounding.AwayFromZero);
        Assert.Equal(200m - penalty, await BalanceAsync(factory, club, club.MemberId));

        // Twenty minutes ago: inside the slot the sweep settled.
        var attendedAt = DateTimeOffset.FromUnixTimeSeconds(DateTimeOffset.UtcNow.AddMinutes(-20).ToUnixTimeSeconds());

        // Both uploads hold the NoShow row as they read it BEFORE either acts — loaded
        // here, not inside the attempt, or the second's read can land after the first's
        // commit and find the row already Booked, which is the sequential case and not
        // the race.
        using var a = RequestScope(factory, club);
        using var b = RequestScope(factory, club);
        var rowA = await a.ServiceProvider.GetRequiredService<MainframeDbContext>().Bookings.FirstAsync(x => x.Id == bookingId);
        var rowB = await b.ServiceProvider.GetRequiredService<MainframeDbContext>().Bookings.FirstAsync(x => x.Id == bookingId);
        Assert.Equal(BookingStatus.NoShow, rowA.Status);
        Assert.Equal(BookingStatus.NoShow, rowB.Status);

        using var gate = new SemaphoreSlim(0);

        async Task<NoShowReversalResult> Attempt(IServiceScope scope, Booking row)
        {
            var bookings = scope.ServiceProvider.GetRequiredService<BookingService>();
            await gate.WaitAsync();
            return await bookings.ReverseNoShowAsync(row, attendedAt, Guid.Empty, default);
        }

        var first = Attempt(a, rowA);
        var second = Attempt(b, rowB);
        gate.Release(2);
        var results = await Task.WhenAll(first, second);

        var shape = string.Join(", ", results.Select(r => r.GetType().Name));
        Assert.True(results.Count(r => r is NoShowReversalResult.Ok) == 1, $"results were: {shape}");
        Assert.True(results.Count(r => r is NoShowReversalResult.Lost) == 1, $"results were: {shape}");

        // Charged once, refunded once, penalised once, and each of those undone once.
        Assert.Equal(200m - BookingCost, await BalanceAsync(factory, club, club.MemberId));
        Assert.Equal(2, await CountAsync(factory, club, bookingId, LedgerEntryType.CancellationRefund));
        Assert.Equal(2, await CountAsync(factory, club, bookingId, LedgerEntryType.NoShowPenalty));

        using var check = RequestScope(factory, club);
        var db = check.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var after = await db.Bookings.AsNoTracking().FirstAsync(x => x.Id == bookingId);
        Assert.Equal(BookingStatus.Booked, after.Status);
        Assert.Equal(attendedAt, after.CheckedInAt);
        Assert.Single(await db.AuditLogs.Where(a => a.Action == "booking.no_show_reversed").ToListAsync());
    }

    /// <summary>
    /// The sweep-versus-upload race (closing re-review #18). The upload reads a Booked row
    /// that is due; the 30-second sweep settles it — NoShow, refund, penalty — between that
    /// read and the upload's stamp; the stamp loses on the concurrency token. Re-running
    /// the activation against the reloaded row used to answer not_chargeable: the member
    /// on a lit court, refunded, penalised, recorded a no-show, and the box's evidence
    /// released. The reload is now looked at, and a row that became NoShow underneath the
    /// upload is reversed.
    /// </summary>
    [SkippableFact]
    public async Task An_upload_that_loses_its_stamp_to_the_sweep_reverses_the_no_show_instead_of_refusing()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory);
        var bookingId = await SeedDueNoShowAsync(factory, club);

        // The upload's read: Booked, as it stood before the sweep tick began.
        using var upload = RequestScope(factory, club);
        var db = upload.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var stale = await db.Bookings.FirstAsync(b => b.Id == bookingId);
        var court = await db.Courts.FirstAsync(c => c.Id == club.CourtId);
        Assert.Equal(BookingStatus.Booked, stale.Status);

        // The sweep commits underneath it.
        await Worker(factory).TickAsync(default);
        var penalty = Math.Round(BookingCost * 0.30m, 2, MidpointRounding.AwayFromZero);
        Assert.Equal(200m - penalty, await BalanceAsync(factory, club, club.MemberId));

        var scannedAt = DateTimeOffset.FromUnixTimeSeconds(DateTimeOffset.UtcNow.AddMinutes(-20).ToUnixTimeSeconds());
        var services = new DeviceEventServices(
            db,
            upload.ServiceProvider.GetRequiredService<ITenantContext>(),
            upload.ServiceProvider.GetRequiredService<AccessCodeService>(),
            upload.ServiceProvider.GetRequiredService<CourtActivationService>(),
            upload.ServiceProvider.GetRequiredService<BookingService>(),
            upload.ServiceProvider.GetRequiredService<TenantSettingsAccessor>(),
            upload.ServiceProvider.GetRequiredService<CourtLightStateService>(),
            upload.ServiceProvider.GetRequiredService<IServiceScopeFactory>(),
            upload.ServiceProvider.GetRequiredService<ILoggerFactory>());

        var outcome = await DeviceEventEndpoints.ActivateOrReverseAsync(
            services, new LateActivation(court, stale, club.MemberId, "offline", scannedAt, 2_700_000), default);

        Assert.Equal("reversed_no_show", outcome);
        Assert.Equal(200m - BookingCost, await BalanceAsync(factory, club, club.MemberId));
        Assert.Equal(2, await CountAsync(factory, club, bookingId, LedgerEntryType.CancellationRefund));
        Assert.Equal(2, await CountAsync(factory, club, bookingId, LedgerEntryType.NoShowPenalty));

        using var check = RequestScope(factory, club);
        var after = await check.ServiceProvider.GetRequiredService<MainframeDbContext>().Bookings.AsNoTracking().FirstAsync(x => x.Id == bookingId);
        Assert.Equal(BookingStatus.Booked, after.Status);
        Assert.Equal(scannedAt, after.CheckedInAt);
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
    /// A settled no-show releases the court at the schema layer too (review H5, decision
    /// 2026-08-24).
    ///
    /// <para>
    /// The GiST exclusion constraint exempts only Cancelled, and that is deliberate — a
    /// NoShow row must keep holding its slot until the sweep has settled the money. What
    /// frees the tail is the sweep truncating <c>EndsAt</c> to its own clock in the same
    /// save as the settlement. This runs the whole chain against real Postgres: sweep,
    /// truncation, then a rebooking over the freed tail that has to pass both the
    /// application overlap predicate and <c>ck_bookings_no_overlapping_slot</c> — the
    /// in-memory variant in <c>NoShowWorkerTests</c> cannot see the constraint at all.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task Rebooking_after_swept_no_show_passes_the_exclusion_constraint()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory);

        // Starts 30 minutes ago, ends 30 minutes from now — swept mid-slot.
        var bookingId = await SeedDueNoShowAsync(factory, club);

        await Worker(factory).TickAsync(default);

        using (var check = RequestScope(factory, club))
        {
            var db = check.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var swept = await db.Bookings.AsNoTracking().FirstAsync(x => x.Id == bookingId);
            Assert.Equal(BookingStatus.NoShow, swept.Status);
            Assert.True(swept.EndsAt <= DateTimeOffset.UtcNow, "the sweep must truncate EndsAt to its own clock");
        }

        // Rebook inside the swept booking's original hour. CommitAsync surfaces a 23P01
        // from the exclusion constraint as SlotTaken, so Ok here proves the schema admitted
        // the row, not merely that the application predicate did.
        using var scope = RequestScope(factory, club);
        var bookings = scope.ServiceProvider.GetRequiredService<BookingService>();
        var result = await bookings.CreateAsync(
            club.CourtId, club.MemberId, club.MemberId,
            DateTimeOffset.UtcNow.AddMinutes(5), sliceCount: 1, default);

        Assert.IsType<BookingResult.Ok>(result);
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
        var shape = string.Join(", ", results.Select(r => r.GetType().Name));
        Assert.True(results.Count(r => r is BookingResult.Ok) == 1, $"results were: {shape}");
        Assert.True(results.Count(r => r is BookingResult.InsufficientBalance) == 1, $"results were: {shape}");

        // The invariant that actually matters, whichever way the race fell.
        var balance = await BalanceAsync(factory, club, club.MemberId);
        Assert.True(balance >= 0m, $"balance went negative: {balance}");
        Assert.Equal(0m, balance);

        using var check = RequestScope(factory, club);
        var db = check.ServiceProvider.GetRequiredService<MainframeDbContext>();
        Assert.Equal(1, await db.Bookings.CountAsync(b => b.UserId == club.MemberId && b.StartsAt == startsAt));
    }

    // ---- Walk-up retries and payer locks ----------------------------------

    private static WalkUpServices WalkUpServicesOf(IServiceScope scope) => new(
        scope.ServiceProvider.GetRequiredService<MainframeDbContext>(),
        scope.ServiceProvider.GetRequiredService<BookingService>(),
        scope.ServiceProvider.GetRequiredService<CourtActivationService>(),
        scope.ServiceProvider.GetRequiredService<IdentificationResolver>(),
        scope.ServiceProvider.GetRequiredService<TenantSettingsAccessor>(),
        scope.ServiceProvider.GetRequiredService<LedgerService>());

    private static (int Status, JsonElement Body) Unwrap(IResult result) => (
        (result as IStatusCodeHttpResult)?.StatusCode ?? StatusCodes.Status200OK,
        JsonSerializer.SerializeToElement((result as IValueHttpResult)?.Value));

    /// <summary>
    /// An uncharged booking for the member on the given court, starting a minute ago — the
    /// shape that reaches the never-charged branch of <c>ChargeOnActivationAsync</c>.
    /// </summary>
    private static async Task<Guid> SeedUnchargedLiveBookingAsync(TestWebAppFactory factory, Club club, int courtNumber, Guid? chargedBy = null)
    {
        using var scope = RequestScope(factory, club);
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var courtId = await db.Courts.Where(c => c.CourtNumber == courtNumber).Select(c => c.Id).FirstAsync();
        var startsAt = DateTimeOffset.UtcNow.AddMinutes(-1);
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
            ChargedAt = chargedBy is null ? null : DateTimeOffset.UtcNow,
        };
        db.Bookings.Add(booking);
        if (chargedBy is { } payer)
        {
            db.LedgerEntries.Add(new LedgerEntry
            {
                TenantId = club.TenantId, UserId = payer, Type = LedgerEntryType.BookingCharge,
                AmountCredits = -BookingCost, ActorUserId = payer, RelatedBookingId = booking.Id, Reason = "seed charge",
            });
        }
        await db.SaveChangesAsync();
        return booking.Id;
    }

    private static async Task SpendDownToOneBookingAsync(TestWebAppFactory factory, Club club, Guid userId)
    {
        using var scope = RequestScope(factory, club);
        await scope.ServiceProvider.GetRequiredService<LedgerService>().PostAsync(
            new LedgerPosting(userId, LedgerEntryType.AdminAdjustment, -(200m - BookingCost), userId,
                Reason: "spend down to one booking"), default);
        Assert.Equal(BookingCost, await BalanceAsync(factory, club, userId));
    }

    /// <summary>
    /// Two identical walk-ups in flight together — the box retried before its first attempt
    /// answered — debit once and answer the same grant twice (review H3).
    ///
    /// <para>
    /// The read-first replay check cannot catch this: neither attempt has committed when
    /// the other looks. What catches it is the filtered unique index on the ledger's
    /// external reference, or the slot the first attempt has just taken — and either way the
    /// loser re-reads the reference and answers with the winner's grant, so a box holding
    /// either response can <c>!ON</c>. Genuinely concurrent, from a shared start signal,
    /// because in sequence the replay check alone would pass it.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task Walkup_same_nonce_race_charges_once()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory);
        // Both attempts buy an hour from the service's own UtcNow, and the club shuts at
        // local midnight — so run this in a zone where the hour fits, or the race is decided
        // by closing time for the last hour of every day. See TestHost.DayZoneFor.
        using (var zoneScope = factory.Services.CreateScope())
        {
            await TestHost.ClearOfClosingAsync(
                zoneScope.ServiceProvider.GetRequiredService<MainframeDbContext>(), club.TenantId, 60);
        }

        var code = await TestAccessCodes.MintIdentAsync(factory.Services, club.TenantId, club.Slug, club.MemberId);
        const string nonce = "9f2a4c6e8b0d1f3a";

        using var gate = new SemaphoreSlim(0);

        async Task<(int Status, JsonElement Body)> Attempt()
        {
            using var scope = RequestScope(factory, club);
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var device = await db.Devices.FirstAsync(d => d.Id == club.DeviceId);
            var services = WalkUpServicesOf(scope);
            await gate.WaitAsync();
            return Unwrap(await DeviceEventEndpoints.WalkUpForDeviceAsync(
                device, new WalkUpRequest(device.MacAddress, 60, "qr", code, 2, nonce), services, default));
        }

        var first = Attempt();
        var second = Attempt();
        gate.Release(2);
        var results = await Task.WhenAll(first, second);

        var shape = string.Join(", ", results.Select(r => $"{r.Status} {r.Body.GetRawText()}"));
        Assert.All(results, r => Assert.True(r.Status == 200, $"results were: {shape}"));

        // The same grant, twice — and exactly one of them was the purchase.
        var bookingIds = results.Select(r => r.Body.GetProperty("booking_id").GetGuid()).Distinct().ToList();
        Assert.Single(bookingIds);
        Assert.Equal(1, results.Count(r => !r.Body.GetProperty("replayed").GetBoolean()));
        Assert.Equal(1, results.Count(r => r.Body.GetProperty("replayed").GetBoolean()));
        Assert.All(results, r => Assert.Equal(60, r.Body.GetProperty("granted_minutes").GetInt32()));

        // One booking, one debit, one attendance stamp.
        Assert.Equal(200m - BookingCost, await BalanceAsync(factory, club, club.MemberId));
        using var check = RequestScope(factory, club);
        var checkDb = check.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var booking = Assert.Single(await checkDb.Bookings.Where(b => b.UserId == club.MemberId).ToListAsync());
        Assert.Equal(bookingIds[0], booking.Id);
        Assert.NotNull(booking.CheckedInAt);
        Assert.Single(await checkDb.LedgerEntries
            .Where(l => l.ExternalReference == DeviceEventEndpoints.WalkUpReference(club.DeviceId, nonce)).ToListAsync());
        Assert.Single(await checkDb.AuditLogs.Where(a => a.Action == "court.activated").ToListAsync());
    }

    /// <summary>
    /// A walk-up the court refuses gives every credit back, and the released slot and the
    /// refund land together. <b>Postgres only</b>: the undo sets the booking's status and
    /// posts the refund through one <c>SaveChanges</c>, and on the in-memory provider that
    /// is not one transaction at all — <c>memory/gotchas.md</c> records a test that "proved"
    /// exactly this shape while demonstrating the failure it was written to catch.
    ///
    /// <para>
    /// The refusal itself is forced (see <see cref="RefusingActivation"/>); everything the
    /// assertions read — the booking row, both ledger legs, the balance — is written by the
    /// real services against a real database.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task Walkup_refused_at_activation_returns_every_credit_and_releases_the_slot()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory);
        using (var zoneScope = factory.Services.CreateScope())
        {
            await TestHost.ClearOfClosingAsync(
                zoneScope.ServiceProvider.GetRequiredService<MainframeDbContext>(), club.TenantId, 60);
        }

        var opening = await BalanceAsync(factory, club, club.MemberId);
        var code = await TestAccessCodes.MintIdentAsync(factory.Services, club.TenantId, club.Slug, club.MemberId);
        const string nonce = "1a2b3c4d5e6f7081";

        (int Status, JsonElement Body) refused;
        using (var scope = RequestScope(factory, club))
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var device = await db.Devices.FirstAsync(d => d.Id == club.DeviceId);
            var services = WalkUpServicesOf(scope) with { Activation = new RefusingActivation(scope) };
            refused = Unwrap(await DeviceEventEndpoints.WalkUpForDeviceAsync(
                device, new WalkUpRequest(device.MacAddress, 60, "qr", code, 2, nonce), services, default));
        }

        Assert.Equal(409, refused.Status);
        Assert.Equal("activation_refused", refused.Body.GetProperty("error").GetString());

        // Nothing is stranded. Left standing, this booking would have been settled as an
        // ordinary no-show at the grace deadline and carried the club penalty.
        Assert.Equal(opening, await BalanceAsync(factory, club, club.MemberId));

        using var check = RequestScope(factory, club);
        var checkDb = check.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var booking = Assert.Single(await checkDb.Bookings.Where(b => b.UserId == club.MemberId).ToListAsync());
        Assert.Equal(BookingStatus.Cancelled, booking.Status);
        Assert.Null(booking.CheckedInAt);

        // Both legs, same type, opposite sign (I11), each under its own reference so a retry
        // of either cannot post it twice.
        var purchase = Assert.Single(await checkDb.LedgerEntries
            .Where(l => l.ExternalReference == DeviceEventEndpoints.WalkUpReference(club.DeviceId, nonce)).ToListAsync());
        var undo = Assert.Single(await checkDb.LedgerEntries
            .Where(l => l.ExternalReference ==
                DeviceEventEndpoints.VoidReference(DeviceEventEndpoints.WalkUpReference(club.DeviceId, nonce))).ToListAsync());
        Assert.Equal(LedgerEntryType.LightsPurchase, purchase.Type);
        Assert.Equal(LedgerEntryType.LightsPurchase, undo.Type);
        Assert.Equal(-purchase.AmountCredits, undo.AmountCredits);
        Assert.True(undo.AmountCredits > 0m);

        // The court was never lit, so nothing claims it was.
        Assert.Empty(await checkDb.AuditLogs.Where(a => a.Action == "court.activated").ToListAsync());
        Assert.Single(await checkDb.AuditLogs.Where(a => a.Action == "booking.walk_up_voided").ToListAsync());
    }

    /// <summary>
    /// Two uncharged bookings, one payer, credits for one: two concurrent activations debit
    /// once. This is the never-charged branch of <c>ChargeOnActivationAsync</c>, which read
    /// an unlocked <c>SUM</c> and debited — the same race <c>CommitAsync</c> closes for a
    /// booking, left open at the court. <b>Postgres only</b>: the payer lock is a no-op on
    /// the in-memory provider, so nothing but this proves it.
    /// </summary>
    [SkippableFact]
    public async Task Concurrent_activation_debits_same_payer_from_two_bookings_cannot_overspend()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory);
        await SpendDownToOneBookingAsync(factory, club, club.MemberId);

        var onCourt1 = await SeedUnchargedLiveBookingAsync(factory, club, courtNumber: 1);
        var onCourt2 = await SeedUnchargedLiveBookingAsync(factory, club, courtNumber: 2);

        using var gate = new SemaphoreSlim(0);

        async Task<ChargeResult> Attempt(Guid bookingId)
        {
            using var scope = RequestScope(factory, club);
            var bookings = scope.ServiceProvider.GetRequiredService<BookingService>();
            await gate.WaitAsync();
            return await bookings.ChargeOnActivationAsync(bookingId, null, club.MemberId, default);
        }

        var first = Attempt(onCourt1);
        var second = Attempt(onCourt2);
        gate.Release(2);
        var results = await Task.WhenAll(first, second);

        var shape = string.Join(", ", results.Select(r => r.GetType().Name));
        Assert.True(results.Count(r => r is ChargeResult.Ok) == 1, $"results were: {shape}");
        Assert.True(results.Count(r => r is ChargeResult.InsufficientBalance) == 1, $"results were: {shape}");

        var balance = await BalanceAsync(factory, club, club.MemberId);
        Assert.True(balance >= 0m, $"balance went negative: {balance}");
        Assert.Equal(0m, balance);

        using var check = RequestScope(factory, club);
        var db = check.ServiceProvider.GetRequiredService<MainframeDbContext>();
        Assert.Equal(1, await db.Bookings.CountAsync(b => b.UserId == club.MemberId && b.ChargedAt != null));
    }

    /// <summary>
    /// The other branch: two charged bookings, one volunteer pressing "I'll pay" at both
    /// courts at once with credits for one. The booker is refunded once and the volunteer
    /// pays once; the second reassignment is refused for balance rather than half-applied.
    /// </summary>
    [SkippableFact]
    public async Task Concurrent_payer_reassignment_from_two_bookings_cannot_overspend()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory);
        await SpendDownToOneBookingAsync(factory, club, club.VolunteerId);

        var onCourt1 = await SeedUnchargedLiveBookingAsync(factory, club, courtNumber: 1, chargedBy: club.MemberId);
        var onCourt2 = await SeedUnchargedLiveBookingAsync(factory, club, courtNumber: 2, chargedBy: club.MemberId);
        var bookerBefore = await BalanceAsync(factory, club, club.MemberId);

        using var gate = new SemaphoreSlim(0);

        async Task<ChargeResult> Attempt(Guid bookingId)
        {
            using var scope = RequestScope(factory, club);
            var bookings = scope.ServiceProvider.GetRequiredService<BookingService>();
            await gate.WaitAsync();
            return await bookings.ChargeOnActivationAsync(bookingId, club.VolunteerId, club.VolunteerId, default);
        }

        var first = Attempt(onCourt1);
        var second = Attempt(onCourt2);
        gate.Release(2);
        var results = await Task.WhenAll(first, second);

        var shape = string.Join(", ", results.Select(r => r.GetType().Name));
        Assert.True(results.Count(r => r is ChargeResult.Ok) == 1, $"results were: {shape}");
        Assert.True(results.Count(r => r is ChargeResult.InsufficientBalance) == 1, $"results were: {shape}");

        var volunteer = await BalanceAsync(factory, club, club.VolunteerId);
        Assert.True(volunteer >= 0m, $"volunteer balance went negative: {volunteer}");
        Assert.Equal(0m, volunteer);

        // The booker is made whole for exactly one court.
        Assert.Equal(bookerBefore + BookingCost, await BalanceAsync(factory, club, club.MemberId));

        using var check = RequestScope(factory, club);
        var db = check.ServiceProvider.GetRequiredService<MainframeDbContext>();
        Assert.Equal(1, await db.Bookings.CountAsync(b => b.PaidByUserId == club.VolunteerId));
    }

    /// <summary>
    /// The sweep truncates a no-show's EndsAt to free the tail — and must never EXTEND one.
    /// A booking swept after its own end (the worker was down; the lookback reached it late)
    /// that had its EndsAt pushed forward to the sweep clock grew into the next booking on
    /// the court, the exclusion constraint threw inside the tick, and the sweep stalled for
    /// every tenant. Only Postgres enforces the constraint, so only this suite can prove it.
    /// Found by the end-to-end scenario, not by a unit test.
    /// </summary>
    [SkippableFact]
    public async Task Sweeping_bookings_after_their_end_never_extends_one_into_the_next()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory);
        var (first, second, firstEnd) = await SeedTwoEndedBookingsAsync(factory, club);

        await Worker(factory).TickAsync(default);

        using var scope = RequestScope(factory, club);
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var rows = await db.Bookings.Where(b => b.Id == first || b.Id == second).ToListAsync();
        Assert.All(rows, b => Assert.Equal(BookingStatus.NoShow, b.Status));
        Assert.Equal(firstEnd, rows.Single(b => b.Id == first).EndsAt);
        Assert.Equal(1, await CountAsync(factory, club, first, LedgerEntryType.NoShowPenalty));
        Assert.Equal(1, await CountAsync(factory, club, second, LedgerEntryType.NoShowPenalty));
    }

    /// <summary>
    /// A fixture instant a test compares for equality has to be one the database can hold.
    ///
    /// <para>
    /// The pin on <see cref="TestHost.Storable"/>, and it manufactures its own hazard rather
    /// than waiting for a clock to supply one. <c>timestamptz</c> stores whole microseconds
    /// and a .NET tick is 100&#160;ns, so an instant carrying a sub-microsecond remainder comes
    /// back changed. macOS never produces one from <c>UtcNow</c> and Linux produces one nine
    /// times in ten, which is exactly the shape that cannot be found on the machine it passes
    /// on — the test above was red on five consecutive CI runs, at four different hours of the
    /// day, and green here every time. Adding the remainder explicitly makes both platforms
    /// agree, so deleting the truncation is red everywhere.
    /// </para>
    ///
    /// <para>
    /// Both halves are asserted deliberately. The first says the hazard is real; without it a
    /// future column with nanosecond resolution would leave the second half passing for a
    /// reason that no longer holds, and the truncation would look load-bearing when it was not.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task A_seeded_instant_survives_the_database_unchanged()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory);

        // Three ticks past a whole microsecond: what a Linux clock hands a fixture for free.
        var hostile = TestHost.Storable(DateTimeOffset.UtcNow).AddTicks(3);
        var readBack = await RoundTripEndsAtAsync(factory, club, hostile);
        var storableReadBack = await RoundTripEndsAtAsync(factory, club, TestHost.Storable(hostile));

        Assert.NotEqual(hostile, readBack);
        Assert.Equal(TestHost.Storable(hostile), storableReadBack);
    }

    /// <summary>
    /// Writes one booking ending at <paramref name="endsAt"/> and reads that column back.
    ///
    /// <para>
    /// <c>Cancelled</c> on purpose: the overlap exclusion is defined <c>WHERE "Status" &lt;&gt; 1</c>
    /// (AddBookingOverlapExclusion), so two calls a few hundred nanoseconds apart on the same
    /// court do not collide, and the no-show sweep only looks at <c>Booked</c> rows.
    /// </para>
    /// </summary>
    private static async Task<DateTimeOffset> RoundTripEndsAtAsync(
        TestWebAppFactory factory, Club club, DateTimeOffset endsAt)
    {
        Guid id;
        using (var write = RequestScope(factory, club))
        {
            var db = write.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var booking = new Booking
            {
                TenantId = club.TenantId,
                CourtId = club.CourtId,
                UserId = club.MemberId,
                BookedByUserId = club.MemberId,
                PaidByUserId = club.MemberId,
                ActorUserId = club.MemberId,
                StartsAt = endsAt.AddMinutes(-60),
                EndsAt = endsAt,
                SliceMinutes = 15,
                SliceCount = 4,
                AmountChargedCredits = BookingCost,
                Status = BookingStatus.Cancelled,
                ChargedAt = DateTimeOffset.UtcNow,
            };
            db.Bookings.Add(booking);
            await db.SaveChangesAsync();
            id = booking.Id;
        }

        using var read = RequestScope(factory, club);
        var fresh = read.ServiceProvider.GetRequiredService<MainframeDbContext>();
        return (await fresh.Bookings.AsNoTracking().FirstAsync(b => b.Id == id)).EndsAt;
    }
}
