using Crusaders.Mainframe.Api.Domain;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Persistence;

/// <summary>
/// The two groups GOAL item 3 names — "the default groups can be non-league members and league
/// members" — seeded per tenant, <b>with no members and no restrictions at all</b>.
///
/// <para>
/// <b>Both start unrestricted and inheriting, and that is the whole point.</b> Installing this
/// feature must change NOTHING for any existing club until an admin edits a group and puts
/// somebody in it. A seed that invented "non-league members may not book 17:00–21:00" would be
/// the software making a commercial decision on the club's behalf, on a live money system, in the
/// same deploy that introduced the concept. The names come from the founder; the restrictions are
/// the club's to write.
/// </para>
///
/// <para>
/// It also avoids the one hazard intersection semantics have. A member wrongly placed in BOTH
/// seeded groups would, if each carried real windows, end up with an empty allowed set and a grid
/// on which nothing at all is bookable. Seeded unrestricted, the intersection of the two is the
/// club's own hours, which is exactly what an admin reading those two names would expect.
/// </para>
///
/// <para>
/// <b>Since D2 the league group carries the tariff the <c>LeagueOrSenior</c> class did</b> — the
/// blueprint A.8 league rate and A.12 peak priority — and is found by its
/// <see cref="MemberGroup.SystemKey"/>, not its name, so an admin may rename it. Seeded with no
/// members it still changes nothing for anybody; the migration <c>GroupsReplaceClass</c> is what
/// moved the existing league members into it.
/// </para>
///
/// <para>
/// <see cref="MemberGroup.IsSystemDefault"/> on both: renameable and editable, not deletable, so
/// the groups screen always has two rows to explain the feature with.
/// </para>
/// </summary>
public static class MemberGroupSeeder
{
    /// <summary>The names GOAL item 3 gives. Kept here so the seeder and the tests agree on them.</summary>
    public const string LeagueMembers = "League members";
    public const string NonLeagueMembers = "Non-league members";

    /// <summary>
    /// The league rate a NEW club's league group starts at: blueprint A.8's R100 → 240 credits,
    /// the same number <c>credits_per_zar_league</c> defaulted to before D2 moved it here. An
    /// existing club's league group carries whatever that setting held, by migration.
    /// </summary>
    public const decimal DefaultLeagueCreditsPerZar = 2.4m;

    /// <summary>
    /// Ensures both groups exist for one tenant. The league group is found by its system key;
    /// the non-league group by name, case-insensitively, which is the same test the unique index
    /// enforces — so re-running this after an admin has renamed that one creates a second rather
    /// than resurrecting the first, and that is correct: the club renamed it on purpose. Never
    /// mutates an existing group.
    /// </summary>
    public static async Task EnsureAsync(MainframeDbContext db, Guid tenantId, CancellationToken ct = default)
    {
        var existing = await db.MemberGroups.IgnoreQueryFilters()
            .Where(g => g.TenantId == tenantId)
            .Select(g => new { Name = g.Name.ToLower(), g.SystemKey })
            .ToListAsync(ct);
        var names = existing.Select(g => g.Name).ToHashSet();

        if (existing.All(g => g.SystemKey != MemberGroupSystemKeys.League))
        {
            // The seeded name when it is free; otherwise the first free fallback, because a group
            // an admin already made under that name is theirs and is never taken over.
            var name = new[] { LeagueMembers, "League", "League (system)" }
                .First(n => !names.Contains(n.ToLowerInvariant()));
            names.Add(name.ToLowerInvariant());
            db.MemberGroups.Add(Seeded(tenantId, name, sortOrder: 0, league: true));
        }

        if (!names.Contains(NonLeagueMembers.ToLowerInvariant()))
        {
            db.MemberGroups.Add(Seeded(tenantId, NonLeagueMembers, sortOrder: 1, league: false));
        }

        await db.SaveChangesAsync(ct);
    }

    // Block body, not an expression one — the lizard object-initialiser trap in memory/gotchas.md.
    private static MemberGroup Seeded(Guid tenantId, string name, int sortOrder, bool league)
    {
        return new MemberGroup
        {
            TenantId = tenantId,
            Name = name,
            Description = null,
            Status = MemberGroupStatus.Active,
            SortOrder = sortOrder,
            PricingMode = GroupPricingMode.InheritCourt,
            // Null caps: inherit the club's own. Not zero, which would mean UNLIMITED and would
            // silently exempt every member of a seeded group from the per-day cap the club has had
            // since it opened.
            MaxSlotsPerDay = null,
            MaxMinutesPerDay = null,
            AdvanceBookingDays = null,
            IsSystemDefault = true,
            SystemKey = league ? MemberGroupSystemKeys.League : null,
            CreditsPerZar = league ? DefaultLeagueCreditsPerZar : null,
            // The non-league group has no say (null), not "withholds" — a league member who is
            // also put in it must keep the priority the league group grants.
            PeakPriority = league ? true : null,
        };
    }
}
