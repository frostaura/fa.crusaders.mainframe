using Crusaders.Mainframe.Api.Domain;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services.Demo;

/// <summary>The demo club's own row — its creation, its slug, and the lock and seed that name it.</summary>
public sealed partial class DemoModeService
{
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
