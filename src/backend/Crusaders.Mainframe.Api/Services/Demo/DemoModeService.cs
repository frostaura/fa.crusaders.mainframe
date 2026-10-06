using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services.Demo;

/// <summary>
/// Demo mode: the two clubs an admin can work in, and the switch between them.
///
/// <para>
/// <b>Two tenants, not a flag.</b> Each real club has at most one demo club
/// (<see cref="Tenant.DemoOfTenantId"/>), created the first time one of its admins switches. An
/// admin switching in is given a session as their <b>mirror</b> — a user that exists only in the
/// demo club, with the admin's name, a non-routable address, no password and no passkey
/// (<see cref="User.DemoSourceUserId"/>). Every query that session makes is filtered to the demo
/// club by the same global filter that keeps two real clubs apart, so nothing it can do reaches a
/// real row. Switching back hands a session to the one real admin the mirror names, and only while
/// that admin's sessions have not been ended since (<see cref="User.DemoSourceEpoch"/>).
/// </para>
///
/// <para>
/// <b>Always current.</b> The made-up data is drawn relative to the moment it is generated
/// (<see cref="DemoDataGenerator"/>). Once it is older than <see cref="StaleAfter"/> the next entry
/// draws it again, so "today" always has a realistic past and future. Generation runs in one
/// transaction under an advisory lock on the demo club: two admins entering together generate it
/// once, and a generation that fails leaves the previous data standing.
/// </para>
/// </summary>
public sealed class DemoModeService
{
    /// <summary>How old the made-up data may get before the next entry draws it again.</summary>
    public static readonly TimeSpan StaleAfter = TimeSpan.FromHours(24);

    private readonly MainframeDbContext _db;
    private readonly ITenantContext _tenant;
    private readonly IServiceScopeFactory _scopes;
    private readonly TimeProvider _clock;
    private readonly ILogger<DemoModeService> _logger;
    private readonly CancellationToken _stopping;

    public DemoModeService(
        MainframeDbContext db, ITenantContext tenant, IServiceScopeFactory scopes, TimeProvider clock,
        IHostApplicationLifetime lifetime, ILogger<DemoModeService> logger)
    {
        _db = db;
        _tenant = tenant;
        _scopes = scopes;
        _clock = clock;
        _stopping = lifetime.ApplicationStopping;
        _logger = logger;
    }

    public static bool IsStale(Tenant demo, DateTimeOffset now) => demo.DemoGeneratedAt is not { } at || now - at > StaleAfter;

    /// <summary>The demo club of the current (real) club, or null when nobody has opened it yet.</summary>
    public Task<Tenant?> DemoOfCurrentAsync(CancellationToken ct) =>
        _db.Tenants.AsNoTracking().FirstOrDefaultAsync(t => t.DemoOfTenantId == _tenant.TenantId, ct);

    /// <summary>The club this request is in.</summary>
    public Task<Tenant> CurrentAsync(CancellationToken ct) => _db.Tenants.AsNoTracking().FirstAsync(t => t.Id == _tenant.TenantId, ct);

    /// <summary>Any club by id (clubs are not tenant-scoped rows).</summary>
    public Task<Tenant> ClubAsync(Guid id, CancellationToken ct) => _db.Tenants.AsNoTracking().FirstAsync(t => t.Id == id, ct);

    /// <summary>The account's session epoch as stored, for a session minted for it now.</summary>
    public Task<int> EpochOfAsync(Guid userId, CancellationToken ct) =>
        _db.Users.IgnoreQueryFilters().AsNoTracking().Where(u => u.Id == userId).Select(u => u.SessionEpoch).FirstOrDefaultAsync(ct);

    /// <summary>
    /// Ensures the current club's demo club, the caller's mirror in it and fresh data, and answers
    /// both. The current tenant must be the REAL club and <paramref name="realUserId"/> one of its admins.
    /// </summary>
    public async Task<DemoEntry> EnterAsync(Guid realUserId, CancellationToken ct)
    {
        var real = await CurrentAsync(ct);
        if (real.IsDemo) throw new InvalidOperationException("Already in a demo club.");
        var user = await _db.Users.IgnoreQueryFilters().AsNoTracking().FirstAsync(u => u.Id == realUserId && u.TenantId == real.Id, ct);

        var club = await EnsureClubAsync(real, ct);
        var (mirror, created) = await DemoMirrors.EnsureAsync(_db, club, user, ct);
        if (IsStale(club, _clock.GetUtcNow()))
        {
            await RegenerateAsync(club.Id, force: false, ct);
        }
        else if (created)
        {
            await DemoMirrors.OpeningBalanceAsync(_db, club.Id, mirror.Id, ct);
        }
        var fresh = await _db.Tenants.AsNoTracking().FirstAsync(t => t.Id == club.Id, ct);
        return new DemoEntry(fresh, mirror);
    }

    /// <summary>The real admin behind the caller's demo session, or why there is none.</summary>
    public async Task<DemoReturn> ReturnForAsync(Guid mirrorUserId, CancellationToken ct)
    {
        var club = await CurrentAsync(ct);
        if (club.DemoOfTenantId is not { } realClubId) return new DemoReturn.NotADemoSession();
        var mirror = await _db.Users.IgnoreQueryFilters().AsNoTracking()
            .FirstOrDefaultAsync(u => u.Id == mirrorUserId && u.TenantId == club.Id, ct);
        if (mirror?.DemoSourceUserId is not { } sourceId) return new DemoReturn.NotADemoSession();

        var real = await _db.Users.IgnoreQueryFilters().AsNoTracking()
            .FirstOrDefaultAsync(u => u.Id == sourceId && u.TenantId == realClubId, ct);
        if (real is null) return new DemoReturn.NotADemoSession();
        if (mirror.DemoSourceEpoch != real.SessionEpoch) return new DemoReturn.SessionEnded();
        var realClub = await _db.Tenants.AsNoTracking().FirstAsync(t => t.Id == realClubId, ct);
        return new DemoReturn.To(real, realClub);
    }

    /// <summary>
    /// Wipes the demo club's made-up data and draws it again, unless (<paramref name="force"/>
    /// false) another request drew it while this one waited for the lock. Answers when the data
    /// now standing was generated.
    ///
    /// <para>
    /// <b>Finishes even when the caller has gone.</b> On the club's Pi a whole club takes longer than
    /// the gateway or Cloudflare holds a request open. Bound to the request, a cut-off connection
    /// cancelled the draw and rolled it back, so every retry started from nothing and none ever
    /// finished. It now runs to the end unless the app itself is stopping — the caller's
    /// <paramref name="requestAborted"/> is honoured only before it starts — and the app's retry
    /// finds the club drawn, or waits on the lock for the draw still running.
    /// </para>
    /// </summary>
    public async Task<DateTimeOffset> RegenerateAsync(Guid demoTenantId, bool force, CancellationToken requestAborted)
    {
        requestAborted.ThrowIfCancellationRequested();
        var ct = _stopping;
        var started = _clock.GetTimestamp();
        using var scope = _scopes.CreateScope();
        var tenant = scope.ServiceProvider.GetRequiredService<ITenantContext>();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var club = await db.Tenants.AsNoTracking().FirstAsync(t => t.Id == demoTenantId && t.DemoOfTenantId != null, ct);
        DemoTenants.Register(club.Id);
        tenant.Set(club.Id, club.Slug);

        var now = _clock.GetUtcNow();
        await using (var tx = await db.Database.BeginTransactionAsync(ct))
        {
            await db.Database.ExecuteSqlRawAsync("SELECT pg_advisory_xact_lock({0})", [LockKey(club.Id)], ct);
            var current = await db.Tenants.FirstAsync(t => t.Id == club.Id, ct);
            if (!force && !IsStale(current, now)) return current.DemoGeneratedAt!.Value;

            await DemoWiper.WipeAsync(db, club.Id, ct);
            var actor = await db.Users.AsNoTracking().Where(u => u.DemoSourceUserId != null).OrderBy(u => u.CreatedAt).Select(u => u.Id).FirstOrDefaultAsync(ct);
            await DemoConfigCopier.CopyAsync(db, club.DemoOfTenantId!.Value, club.Id, actor, ct);
            var generator = scope.ServiceProvider.GetRequiredService<DemoDataGenerator>();
            await generator.GenerateAsync(new DemoSeed(SeedFor(club.Id, now), now), ct);

            current = await db.Tenants.FirstAsync(t => t.Id == club.Id, ct);
            current.DemoGeneratedAt = now.Storable();
            await db.SaveChangesAsync(ct);
            await tx.CommitAsync(ct);
        }

        await scope.ServiceProvider.GetRequiredService<DemoDataGenerator>()
            .AwardBadgesAsync(scope.ServiceProvider.GetRequiredService<PlayEvaluator>(), now, ct);
        _logger.LogInformation("Demo club {Slug} regenerated in {Seconds:F1}s", club.Slug, _clock.GetElapsedTime(started).TotalSeconds);
        return now.Storable();
    }

    /// <summary>The current club's demo club, created on first use.</summary>
    private async Task<Tenant> EnsureClubAsync(Tenant real, CancellationToken ct)
    {
        var existing = await _db.Tenants.FirstOrDefaultAsync(t => t.DemoOfTenantId == real.Id, ct);
        if (existing is not null)
        {
            DemoTenants.Register(existing.Id);
            return existing;
        }

        var club = new Tenant
        {
            Slug = await FreeSlugAsync(real.Slug, ct),
            DisplayName = Clip($"{real.DisplayName} (demo)", 255),
            Status = "active",
            DemoOfTenantId = real.Id,
        };
        // Registered before it can be written to: the very first row in it must already be silent.
        DemoTenants.Register(club.Id);
        _db.Tenants.Add(club);
        try
        {
            await _db.SaveChangesAsync(ct);
            return club;
        }
        catch (DbUpdateException)
        {
            // Another admin of the same club created it a moment ago (the unique index on DemoOfTenantId).
            _db.ChangeTracker.Clear();
            var winner = await _db.Tenants.FirstAsync(t => t.DemoOfTenantId == real.Id, ct);
            DemoTenants.Register(winner.Id);
            return winner;
        }
    }

    private async Task<string> FreeSlugAsync(string realSlug, CancellationToken ct)
    {
        var slug = Clip(realSlug, 59) + "-demo";
        if (!await _db.Tenants.AnyAsync(t => t.Slug == slug, ct)) return slug;
        return Clip(realSlug, 50) + "-demo-" + Guid.NewGuid().ToString("N")[..8];
    }

    private static string Clip(string s, int max) => s.Length <= max ? s : s[..max];

    private static long LockKey(Guid id) => BitConverter.ToInt64(id.ToByteArray(), 0);

    /// <summary>A new draw each day, the same draw within one day.</summary>
    private static int SeedFor(Guid demo, DateTimeOffset now) => (int)(LockKey(demo) ^ (now.UtcTicks / TimeSpan.TicksPerDay));
}
