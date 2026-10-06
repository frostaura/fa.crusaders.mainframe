using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services.Demo;

/// <summary>
/// The mirror admin: the one account in a demo club that stands for a real admin.
///
/// <para>
/// Same name as the admin, an address on the reserved <c>.invalid</c> domain that no mail can
/// reach, no password, no passkey, and the admin role. It is reachable only through the mode
/// switch — a demo club is never resolved from a host name or by a sign-in form — and it names
/// exactly one real user (<see cref="User.DemoSourceUserId"/>), which is the only account the way
/// back can ever lead to. Every entry restamps the real account's session epoch on it, so ending
/// the real sessions also closes the way back from the demo.
/// </para>
///
/// <para>
/// Written with <c>IgnoreQueryFilters</c> and explicit club ids throughout: it runs on the REAL
/// club's request, whose filters would hide every demo row.
/// </para>
/// </summary>
public static class DemoMirrors
{
    /// <summary>The demo admin for <paramref name="realUser"/>, created on first entry; whether it was just created.</summary>
    public static async Task<(User Mirror, bool Created)> EnsureAsync(MainframeDbContext db, Tenant club, User realUser, CancellationToken ct)
    {
        var realMembership = await db.Memberships.IgnoreQueryFilters().AsNoTracking()
            .FirstOrDefaultAsync(m => m.UserId == realUser.Id && m.TenantId == realUser.TenantId, ct);
        var name = realMembership?.FullName ?? realUser.Email.Split('@')[0];
        var mirror = await db.Users.IgnoreQueryFilters()
            .FirstOrDefaultAsync(u => u.TenantId == club.Id && u.DemoSourceUserId == realUser.Id, ct);
        var created = mirror is null;
        if (mirror is null)
        {
            mirror = new User
            {
                TenantId = club.Id,
                Email = $"admin.{realUser.Id:N}@{DemoTenants.EmailDomain}",
                EmailVerified = true,
                IsAdmin = true,
                Status = "active",
                DemoSourceUserId = realUser.Id,
            };
            db.Users.Add(mirror);
            var count = await db.Memberships.IgnoreQueryFilters().CountAsync(m => m.TenantId == club.Id && m.MembershipNumber.StartsWith("ADMIN-"), ct);
            db.Memberships.Add(new Membership
            {
                TenantId = club.Id,
                UserId = mirror.Id,
                FullName = name,
                MembershipNumber = $"ADMIN-{count + 1:D3}",
                PhotoUrl = DemoNames.Avatar(name, count),
                Status = MembershipStatus.Active,
            });
            await AddPreferencesAsync(db, club.Id, mirror.Id, realUser, ct);
        }

        mirror.IsAdmin = true;
        mirror.Status = "active";
        mirror.DemoSourceEpoch = realUser.SessionEpoch;
        var membership = await db.Memberships.IgnoreQueryFilters().FirstOrDefaultAsync(m => m.UserId == mirror.Id && m.TenantId == club.Id, ct);
        if (membership is not null)
        {
            membership.FullName = name;
            membership.Status = MembershipStatus.Active;
        }
        await db.SaveChangesAsync(ct);
        return (mirror, created);
    }

    /// <summary>The admin's theme, and every tour marked done — they know the app; the demo is for showing it.</summary>
    private static async Task AddPreferencesAsync(MainframeDbContext db, Guid clubId, Guid mirrorId, User realUser, CancellationToken ct)
    {
        var theme = await db.UserPreferences.IgnoreQueryFilters().AsNoTracking()
            .Where(p => p.UserId == realUser.Id && p.TenantId == realUser.TenantId).Select(p => p.Theme).FirstOrDefaultAsync(ct);
        var now = DateTimeOffset.UtcNow.Storable();
        db.UserPreferences.Add(new UserPreferences
        {
            TenantId = clubId,
            UserId = mirrorId,
            Theme = theme ?? "system",
            Findable = true,
            ShowInLeaderboards = true,
            MemberOnboardingCompletedAt = now,
            AdminOnboardingCompletedAt = now,
            UpdatedAt = now,
        });
    }

    /// <summary>
    /// A second admin arriving in a demo that is already drawn joins it rather than redrawing it
    /// under the first admin's feet: they get a few hours on their wallet to book with.
    /// </summary>
    public static async Task OpeningBalanceAsync(MainframeDbContext db, Guid clubId, Guid mirrorId, CancellationToken ct)
    {
        db.LedgerEntries.Add(new LedgerEntry
        {
            TenantId = clubId,
            UserId = mirrorId,
            Type = LedgerEntryType.AdminTopUp,
            AmountMinutes = 300,
            ZarPaid = 0m,
            ActorUserId = mirrorId,
            Reason = "Opening minutes for the demo club",
            ExternalReference = $"demo-opening:{clubId:N}:{mirrorId:N}",
            CreatedAt = DateTimeOffset.UtcNow.Storable(),
        });
        await db.SaveChangesAsync(ct);
    }
}
