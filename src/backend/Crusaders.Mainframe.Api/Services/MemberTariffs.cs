using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// One group as the tariff needs it: its package discount (null has no say), its peak say (true grants, false withholds,
/// null has no say), its handle.
/// </summary>
public sealed record TariffGroup(
    Guid Id, string Name, string? SystemKey, int? PackageDiscountBps, bool? PeakPriority, int SortOrder);

/// <summary>
/// What a member's groups add up to for money and for the peak window.
/// </summary>
/// <param name="PackageDiscountBps">The discount on club packages, in basis points; null when no group sets one (P13).</param>
/// <param name="DiscountGroup">The group the discount came from, or null when there is none.</param>
/// <param name="PeakPriority">Whether the member may book inside the peak window at any time.</param>
/// <param name="Groups">Every ACTIVE group the member is in, in the club's own order.</param>
public sealed record MemberTariff(
    int? PackageDiscountBps, TariffGroup? DiscountGroup, bool PeakPriority, IReadOnlyList<TariffGroup> Groups)
{
    /// <summary>
    /// The groups that are withholding peak priority — every active group that explicitly says
    /// no. Empty when nothing withholds it and nothing grants it either, whose lack of priority
    /// is the club default rather than any group's doing, so a refusal names only a group that
    /// actually stopped them.
    /// </summary>
    public IReadOnlyList<string> PeakWithheldBy
        => PeakPriority ? [] : Groups.Where(g => g.PeakPriority == false).Select(g => g.Name).ToList();

    /// <summary>
    /// The deprecated <c>member_class</c> wire value, derived for ONE release: a member of the
    /// league system group reads as <c>LeagueOrSenior</c>, everyone else as <c>Regular</c>.
    /// Derived from the league group rather than from the discount or the peak, because that is
    /// exactly the set the migration moved the <c>LeagueOrSenior</c> members into.
    /// </summary>
    public string LegacyMemberClass => LegacyClassOf(Groups);

    /// <inheritdoc cref="LegacyMemberClass"/>
    public static string LegacyClassOf(IEnumerable<TariffGroup> groups)
        => groups.Any(g => g.SystemKey == MemberGroupSystemKeys.League)
            ? MemberGroupSystemKeys.LeagueClassName
            : MemberGroupSystemKeys.RegularClassName;
}

/// <summary>
/// D2: groups replace the member class. The class used to answer two questions — what did this
/// member's money buy (since P13: what discount do they get on the club's minutes packages), and
/// may they book the peak window early — and a member is in
/// several groups, so "which of their groups answers" needs a rule two readers cannot disagree on.
///
/// <para>
/// <b>The most restrictive rule wins, in both cases</b> — "lowest discount; peak only if all
/// groups grant", the same reading <see cref="GroupRules"/> already gives windows and caps. It is
/// the only direction that is safe under admin error: putting a member into one more group can
/// never make their money worth MORE or open a window to them by accident. A mis-click that costs
/// a member is visible to them on the buy screen before they pay; the inverse costs the club revenue nobody ever notices, and this club's admins are
/// volunteers.
/// </para>
///
/// <para>
/// <b>Discount: the LOWEST <see cref="MemberGroup.PackageDiscountBps"/> across the member's
/// active groups that SET one; none when no group does</b> (P13, which replaced D2's top-up
/// rate). A group with a null discount has no opinion about money and is skipped rather than read
/// as zero — a "Juniors" group created only to hold a booking window must not quietly take a
/// league member's discount away. Ties go to the club's own order.
/// </para>
///
/// <para>
/// <b>Peak: granted when at least one active group GRANTS it and no active group WITHHOLDS it.</b>
/// A group's <see cref="MemberGroup.PeakPriority"/> is tri-state exactly like its discount: true
/// grants, false withholds, null has no say. "All groups grant" is read over the groups that
/// have a say — a window-only group has none, so it can no more take a league member's
/// priority away than a discount-less group can take their discount (review D2-P1: with a
/// two-state flag every group that predated D2 was born "withholding", and the migration took
/// the priority from every league member who was also in any other group). An explicit false
/// still wins over any number of grants — most restrictive — and the refusal names the group
/// that said it (<see cref="MemberTariff.PeakWithheldBy"/>). No grant at all is "no": a member
/// nobody has classified has no priority, as under blueprint A.12, where a member was Regular
/// until an admin said otherwise.
/// </para>
///
/// <para>
/// <b>Archived groups contribute nothing</b>, as in <see cref="GroupRules"/>. <b>The club's
/// <c>member_groups_enabled</c> switch does NOT turn the tariff off.</b> That switch governs the
/// booking restrictions a group adds (windows, caps); the discount and the peak priority are
/// the tariff the member class used to carry, which no switch ever turned off, and a club that
/// disabled restrictions must not silently take every league member's discount away.
/// </para>
/// </summary>
public static class MemberTariffs
{
    /// <summary>The tariff for one member, read from their active groups.</summary>
    public static async Task<MemberTariff> ForAsync(MainframeDbContext db, Guid userId, CancellationToken ct)
        => Resolve(await GroupsOfAsync(db, userId, ct));

    /// <summary>
    /// The same tariff; <paramref name="settings"/> is not read. Since P13 no club setting takes
    /// part in it — the club-wide top-up rate it once fell back to is gone, and a member in no
    /// group simply has no discount. Kept as an overload so the callers outside this lane move to
    /// the three-argument form on their own schedule; delete it when nothing calls it.
    /// </summary>
    public static Task<MemberTariff> ForAsync(
        MainframeDbContext db, Guid userId, TenantSettingsView settings, CancellationToken ct)
        => ForAsync(db, userId, ct);

    /// <summary>A member's active groups, in the club's order. Two indexed reads, no N+1.</summary>
    public static async Task<IReadOnlyList<TariffGroup>> GroupsOfAsync(
        MainframeDbContext db, Guid userId, CancellationToken ct)
    {
        var map = await GroupsOfManyAsync(db, [userId], ct);
        return map.TryGetValue(userId, out var groups) ? groups : [];
    }

    /// <summary>
    /// Every listed member's active groups at once — the members list reads a whole club, and a
    /// read per row would be the N+1 the booking path already avoids.
    /// </summary>
    public static async Task<Dictionary<Guid, IReadOnlyList<TariffGroup>>> GroupsOfManyAsync(
        MainframeDbContext db, IReadOnlyCollection<Guid> userIds, CancellationToken ct)
    {
        var ids = userIds.Distinct().ToList();
        var rows = await db.MemberGroupMembers.AsNoTracking()
            .Where(m => ids.Contains(m.UserId))
            .Join(db.MemberGroups.AsNoTracking().Where(g => g.Status == MemberGroupStatus.Active),
                m => m.GroupId, g => g.Id,
                (m, g) => new { m.UserId, g.Id, g.Name, g.SystemKey, g.PackageDiscountBps, g.PeakPriority, g.SortOrder })
            .ToListAsync(ct);

        return rows
            .GroupBy(r => r.UserId)
            .ToDictionary(
                x => x.Key,
                x => (IReadOnlyList<TariffGroup>)x
                    .Select(r => new TariffGroup(r.Id, r.Name, r.SystemKey, r.PackageDiscountBps, r.PeakPriority, r.SortOrder))
                    .OrderBy(g => g.SortOrder).ThenBy(g => g.Name, StringComparer.Ordinal).ThenBy(g => g.Id)
                    .ToList());
    }

    /// <summary>A group entity as the tariff reads it.</summary>
    public static TariffGroup From(MemberGroup g)
        => new(g.Id, g.Name, g.SystemKey, g.PackageDiscountBps, g.PeakPriority, g.SortOrder);

    /// <summary>
    /// The rule itself, pure, so it can be pinned without a database. <paramref name="groups"/>
    /// must already be the ACTIVE groups; ties on the discount go to the club's own order, so the
    /// group a purchase row names is deterministic.
    /// </summary>
    public static MemberTariff Resolve(IReadOnlyList<TariffGroup> groups)
    {
        var ordered = groups
            .OrderBy(g => g.SortOrder).ThenBy(g => g.Name, StringComparer.Ordinal).ThenBy(g => g.Id)
            .ToList();

        TariffGroup? discountGroup = null;
        foreach (var group in ordered)
        {
            if (group.PackageDiscountBps is not { } bps) continue;
            if (discountGroup is null || bps < discountGroup.PackageDiscountBps!.Value) discountGroup = group;
        }

        var peak = ordered.Any(g => g.PeakPriority == true) && ordered.All(g => g.PeakPriority != false);
        return new MemberTariff(discountGroup?.PackageDiscountBps, discountGroup, peak, ordered);
    }
}
