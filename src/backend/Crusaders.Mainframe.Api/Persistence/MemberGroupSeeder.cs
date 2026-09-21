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
    /// Ensures both groups exist for one tenant. Idempotent by name, case-insensitively, which is
    /// the same test the unique index enforces — so re-running this after an admin has renamed a
    /// group creates a second one rather than resurrecting the first, and that is correct: the
    /// club renamed it on purpose.
    /// </summary>
    public static async Task EnsureAsync(MainframeDbContext db, Guid tenantId, CancellationToken ct = default)
    {
        var existing = await db.MemberGroups.IgnoreQueryFilters()
            .Where(g => g.TenantId == tenantId)
            .Select(g => g.Name.ToLower())
            .ToListAsync(ct);

        var sortOrder = 0;
        foreach (var name in new[] { LeagueMembers, NonLeagueMembers })
        {
            if (existing.Contains(name.ToLowerInvariant())) { sortOrder++; continue; }

            db.MemberGroups.Add(new MemberGroup
            {
                TenantId = tenantId,
                Name = name,
                Description = null,
                Status = MemberGroupStatus.Active,
                SortOrder = sortOrder++,
                PricingMode = GroupPricingMode.InheritCourt,
                // Null caps: inherit the club's own. Not zero, which would mean UNLIMITED and
                // would silently exempt every member of a seeded group from the per-day cap the
                // club has had since it opened.
                MaxSlotsPerDay = null,
                MaxMinutesPerDay = null,
                AdvanceBookingDays = null,
                IsSystemDefault = true,
            });
        }

        await db.SaveChangesAsync(ct);
    }
}
