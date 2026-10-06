using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services.Demo;

/// <summary>What one generation is drawn from: the dice and the instant every date is relative to.</summary>
/// <param name="Seed">The same seed and the same <paramref name="Now"/> draw the same club.</param>
public sealed record DemoSeed(int Seed, DateTimeOffset Now)
{
    /// <summary>How many made-up members a club gets.</summary>
    public int Members { get; init; } = 52;

    /// <summary>How far back the history goes, in days.</summary>
    public int HistoryDays { get; init; } = 90;

    /// <summary>How far ahead the bookings go, in days (never past the club's own advance window).</summary>
    public int AheadDays { get; init; } = 14;
}

/// <summary>What a generation wrote, for the log and the tests.</summary>
public sealed record DemoSummary(int Members, int Bookings, int LedgerRows, int Results);

/// <summary>
/// Fills an EMPTY demo club (its configuration already copied, its mirror admins in place) with a
/// realistic club's worth of made-up history and future: members across the groups, applications
/// waiting, a couple suspended; ~90 days of games with partners and splits, no-shows, late
/// cancellations, results and streaks; the next fortnight at evening-heavy occupancy with
/// invites still open; league nights; purchases and desk sales; boards, faults and the door log;
/// the admins' feed and the members' inboxes.
///
/// <para>
/// <b>Every date is relative to <see cref="DemoSeed.Now"/></b>, so the club always has a
/// yesterday and a tomorrow, and <b>the dice are seeded</b>, so a test that draws twice draws the
/// same club.
/// </para>
///
/// <para>
/// <b>The money follows the club's own rules, row for row.</b> History cannot be booked through
/// <see cref="BookingService"/> (it refuses the past), so the generator writes the rows the
/// services would have written, in the shapes they write them: the charge at booking, the refund
/// and penalty of a cancellation (settlement S1–S5), the share pairs of a split
/// (<c>share:{seat}:{seq}:out|in</c>), purchases with their purchase lock, desk sales. Every
/// member's money is replayed in time order and topped up with a purchase before it would go
/// below zero, so no balance is ever negative at any instant. What can be done by the real
/// services is: future league nights are materialised by <see cref="BookingScheduleService"/>,
/// badges are awarded by <see cref="PlayEvaluator"/>.
/// </para>
/// </summary>
public sealed partial class DemoDataGenerator
{
    private readonly MainframeDbContext _db;
    private readonly ITenantContext _tenant;
    private readonly TenantSettingsAccessor _settings;
    private readonly BookingScheduleService _schedules;
    private readonly ILogger<DemoDataGenerator> _logger;

    public DemoDataGenerator(
        MainframeDbContext db, ITenantContext tenant, TenantSettingsAccessor settings,
        BookingScheduleService schedules, ILogger<DemoDataGenerator> logger)
    {
        _db = db;
        _tenant = tenant;
        _settings = settings;
        _schedules = schedules;
        _logger = logger;
    }

    /// <summary>Generates into the CURRENT tenant, which must be an empty demo club.</summary>
    public async Task<DemoSummary> GenerateAsync(DemoSeed seed, CancellationToken ct)
    {
        if (!DemoTenants.IsDemo(_tenant.TenantId))
            throw new InvalidOperationException("The demo generator only writes into a demo club.");

        var world = await LoadWorldAsync(seed, ct);
        var members = PlanPeople(world, seed.Members);
        await _db.SaveChangesAsync(ct);
        await PlanSchedulesAsync(world, ct);

        // Thousands of rows, every one of them Added: change detection on each tracker read (the
        // save's own staging reads the tracker per seat) would make the save quadratic. Nothing
        // below modifies a row it has already saved, so nothing needs detecting.
        _db.ChangeTracker.AutoDetectChangesEnabled = false;
        try
        {
            var bookings = PlanBookings(world, seed);
            await _db.SaveChangesAsync(ct);
            foreach (var seat in bookings.SelectMany(g => g.Partners).Select(p => p.Seat)) _db.BookingParticipants.Add(seat);
            await _db.SaveChangesAsync(ct);

            var ledger = SettleMoney(world);
            var results = PlanResults(world, bookings);
            PlanClub(world, bookings);
            PlanNotices(world, members);
            await _db.SaveChangesAsync(ct);
            await InboxAsync(world, bookings, ct);
            await _db.SaveChangesAsync(ct);
            _db.ChangeTracker.Clear();

            _logger.LogInformation(
                "Demo club {Tenant} generated: {Members} members, {Bookings} bookings, {Ledger} ledger rows, {Results} results",
                _tenant.TenantId, members.Count, bookings.Count, ledger, results);
            return new DemoSummary(members.Count, bookings.Count, ledger, results);
        }
        finally
        {
            _db.ChangeTracker.AutoDetectChangesEnabled = true;
        }
    }

    /// <summary>
    /// Badges, the way the club awards them: <see cref="PlayEvaluator"/> over every player, after
    /// the history is committed (the evaluator opens its own transaction). The mirrors' badge
    /// celebrations are marked seen — an admin switching in is not greeted by a pop-up for a
    /// game they never played.
    /// </summary>
    public async Task AwardBadgesAsync(PlayEvaluator evaluator, DateTimeOffset now, CancellationToken ct)
    {
        var players = await _db.Memberships.AsNoTracking()
            .Where(m => m.Status == MembershipStatus.Active).Select(m => m.UserId).ToListAsync(ct);
        foreach (var userId in players) await evaluator.EvaluateAsync(userId, now, ct);

        var mirrors = await _db.Users.AsNoTracking().Where(u => u.DemoSourceUserId != null).Select(u => u.Id).ToListAsync(ct);
        await _db.PlayCelebrations.Where(c => mirrors.Contains(c.UserId) && c.SeenAt == null)
            .ExecuteUpdateAsync(u => u.SetProperty(c => c.SeenAt, now.Storable()), ct);
    }

    private async Task<DemoWorld> LoadWorldAsync(DemoSeed seed, CancellationToken ct)
    {
        return new DemoWorld
        {
            Rng = new Random(seed.Seed),
            Now = seed.Now.Storable(),
            TenantId = _tenant.TenantId,
            Settings = await _settings.GetAsync(ct),
            Courts = await _db.Courts.AsNoTracking().Where(c => c.IsActive).OrderBy(c => c.CourtNumber).ToListAsync(ct),
            Groups = await _db.MemberGroups.AsNoTracking().Where(g => g.Status == MemberGroupStatus.Active).OrderBy(g => g.SortOrder).ToListAsync(ct),
            Packages = await _db.MinutePackages.AsNoTracking()
                .Where(p => p.Status == MinutePackageStatus.Active && p.GroupId == null).OrderBy(p => p.Minutes).ToListAsync(ct),
            Mirrors = await _db.Users.AsNoTracking().Where(u => u.DemoSourceUserId != null).OrderBy(u => u.CreatedAt).ToListAsync(ct),
        };
    }
}
