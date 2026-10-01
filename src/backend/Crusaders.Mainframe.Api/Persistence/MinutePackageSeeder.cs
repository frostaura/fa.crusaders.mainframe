using Crusaders.Mainframe.Api.Domain;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Persistence;

/// <summary>
/// The club's opening shelf (P13 §4.6): three club packages, written only when the club has no
/// <c>minute_packages</c> row at all — active or archived. Idempotent, and it never touches a
/// shelf an admin has edited, emptied by archiving, or built from scratch.
///
/// <para>
/// <b>Why seed at all.</b> A club with no packages has a buy screen with nothing on it, and every
/// member's first experience of paying is a dead end until an admin finds the Packages page. The
/// three are the blueprint's old R100/R1000 range restated as whole hours, cheaper per hour as
/// they grow, so the shelf shows its saving from day one. The league group starts with no discount
/// (<see cref="MemberGroupSeeder"/>); a club that wants one sets it.
/// </para>
/// </summary>
public static class MinutePackageSeeder
{
    /// <summary>The opening shelf: name, minutes, list price, shelf order.</summary>
    public static readonly (string Name, int Minutes, decimal PriceZar, int SortOrder)[] Defaults =
    [
        ("1 hour", 60, 120.00m, 0),
        ("5 hours", 300, 550.00m, 1),
        ("10 hours", 600, 1000.00m, 2),
    ];

    /// <summary>
    /// Writes the opening shelf for <paramref name="tenantId"/> if, and only if, it has never had a
    /// package. Returns whether it wrote anything. Operates above tenancy (the caller may not have
    /// set the tenant yet), so every read names the tenant itself.
    /// </summary>
    public static async Task<bool> EnsureAsync(MainframeDbContext db, Guid tenantId, Guid createdByUserId, CancellationToken ct = default)
    {
        if (await db.MinutePackages.IgnoreQueryFilters().AnyAsync(p => p.TenantId == tenantId, ct)) return false;

        foreach (var (name, minutes, price, order) in Defaults)
        {
            db.MinutePackages.Add(new MinutePackage
            {
                TenantId = tenantId,
                GroupId = null,
                Name = name,
                Minutes = minutes,
                PriceZar = price,
                SortOrder = order,
                CreatedByUserId = createdByUserId,
            });
        }
        await db.SaveChangesAsync(ct);
        return true;
    }
}
