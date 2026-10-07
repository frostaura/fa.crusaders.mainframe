using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services.Demo;

/// <summary>
/// The mirror admin: the one account in a demo club that stands for a real admin — and, beside it,
/// the same admin's member-view persona.
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
/// <b>The persona is a second mirror, not a mode on the first.</b> Same shape — the same real
/// admin, the same reserved address domain, no password and no passkey, the same epoch stamp — but
/// <see cref="User.IsAdmin"/> is false (re-asserted on every entry, so a role change made inside the
/// demo does not stick), so every admin route refuses it by the ordinary role policy and every
/// member screen is the member's own. It plays like the admin mirror does: the generator gives it
/// a wallet, games and open invites, because it is found by the same <see cref="User.DemoSourceUserId"/>.
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
    public static Task<(User Mirror, bool Created)> EnsureAsync(MainframeDbContext db, Tenant club, User realUser, CancellationToken ct) =>
        EnsureAsync(db, club, realUser, memberView: false, ct);

    /// <summary>
    /// The demo account for <paramref name="realUser"/> — the mirror admin, or with
    /// <paramref name="memberView"/> the member-view persona — created on first use, with its
    /// access and its epoch stamp restated; whether it was just created.
    /// </summary>
    public static async Task<(User Mirror, bool Created)> EnsureAsync(
        MainframeDbContext db, Tenant club, User realUser, bool memberView, CancellationToken ct)
    {
        var realMembership = await db.Memberships.IgnoreQueryFilters().AsNoTracking()
            .FirstOrDefaultAsync(m => m.UserId == realUser.Id && m.TenantId == realUser.TenantId, ct);
        var realName = realMembership?.FullName ?? realUser.Email.Split('@')[0];
        var name = memberView ? Clip($"{realName} (member view)", 255) : realName;
        var prefix = memberView ? "MEMBER-" : "ADMIN-";
        var mirror = await db.Users.IgnoreQueryFilters()
            .FirstOrDefaultAsync(u => u.TenantId == club.Id && u.DemoSourceUserId == realUser.Id && u.DemoMemberView == memberView, ct);
        var created = mirror is null;
        if (mirror is null)
        {
            mirror = new User
            {
                TenantId = club.Id,
                Email = $"{(memberView ? "member" : "admin")}.{realUser.Id:N}@{DemoTenants.EmailDomain}",
                EmailVerified = true,
                IsAdmin = !memberView,
                Status = "active",
                DemoSourceUserId = realUser.Id,
                DemoMemberView = memberView,
            };
            db.Users.Add(mirror);
            var count = await db.Memberships.IgnoreQueryFilters().CountAsync(m => m.TenantId == club.Id && m.MembershipNumber.StartsWith(prefix), ct);
            db.Memberships.Add(new Membership
            {
                TenantId = club.Id,
                UserId = mirror.Id,
                FullName = name,
                MembershipNumber = $"{prefix}{count + 1:D3}",
                PhotoUrl = DemoNames.Avatar(name, count),
                Status = MembershipStatus.Active,
            });
            await AddPreferencesAsync(db, club.Id, mirror.Id, realUser, memberView, ct);
        }

        mirror.IsAdmin = !memberView;
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

    private static string Clip(string s, int max) => s.Length <= max ? s : s[..max];

    /// <summary>
    /// The admin's theme, and every tour marked done — they know the app; the demo is for showing it.
    /// The persona's member tour is left to run: it is what a new member meets first, and testing
    /// the member experience includes it.
    /// </summary>
    private static async Task AddPreferencesAsync(
        MainframeDbContext db, Guid clubId, Guid mirrorId, User realUser, bool memberView, CancellationToken ct)
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
            MemberOnboardingCompletedAt = memberView ? null : now,
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
