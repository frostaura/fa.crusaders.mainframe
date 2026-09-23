using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>One group as the tariff needs it: its top-up rate, its peak priority, its handle.</summary>
public sealed record TariffGroup(
    Guid Id, string Name, string? SystemKey, decimal? CreditsPerZar, bool PeakPriority, int SortOrder);

/// <summary>
/// What a member's groups add up to for money and for the peak window.
/// </summary>
/// <param name="TopUpRate">Credits per one unit of the club's currency, as a top-up is quoted.</param>
/// <param name="RateGroup">The group the rate came from, or null when it is the tenant's default.</param>
/// <param name="PeakPriority">Whether the member may book inside the peak window at any time.</param>
/// <param name="Groups">Every ACTIVE group the member is in, in the club's own order.</param>
public sealed record MemberTariff(
    decimal TopUpRate, TariffGroup? RateGroup, bool PeakPriority, IReadOnlyList<TariffGroup> Groups)
{
    /// <summary>
    /// The groups that are withholding peak priority — every active group that does not grant
    /// it. Empty for a member in no group at all, whose lack of priority is the club default
    /// rather than any group's doing, so a refusal can name the group that actually stopped them.
    /// </summary>
    public IReadOnlyList<string> PeakWithheldBy
        => PeakPriority ? [] : Groups.Where(g => !g.PeakPriority).Select(g => g.Name).ToList();

    /// <summary>
    /// The deprecated <c>member_class</c> wire value, derived for ONE release: a member of the
    /// league system group reads as <c>LeagueOrSenior</c>, everyone else as <c>Regular</c>.
    /// Derived from the league group rather than from the rate or the peak, because that is
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
/// D2: groups replace the member class. The class used to answer two questions — what rate does
/// this member's top-up convert at, and may they book the peak window early — and a member is in
/// several groups, so "which of their groups answers" needs a rule two readers cannot disagree on.
///
/// <para>
/// <b>The most restrictive rule wins, in both cases</b> — the plan's words, "min rate; peak only
/// if all groups grant", and the same reading <see cref="GroupRules"/> already gives windows,
/// prices and caps. It is the only direction that is safe under admin error: putting a member
/// into one more group can never make their money worth MORE or open a window to them by
/// accident. A mis-click that costs a member is visible to them on the top-up screen before they
/// pay; the inverse costs the club revenue nobody ever notices, and this club's admins are
/// volunteers.
/// </para>
///
/// <para>
/// <b>Rate: the minimum <see cref="MemberGroup.CreditsPerZar"/> across the member's active groups
/// that SET one; the tenant's <c>credits_per_zar_regular</c> when none does.</b> A group with a
/// null rate has no opinion about money and is skipped rather than read as the default — a
/// "Juniors" group created only to hold a booking window must not quietly drag a league member
/// back to the regular rate. The tenant default is NOT folded into the minimum either: a group
/// that sets a rate replaces the default for its members, which is what "this group tops up at
/// 2.4" means to an admin typing it.
/// </para>
///
/// <para>
/// <b>Peak: granted only when the member is in at least one active group and EVERY active group
/// they are in grants it.</b> "All groups grant" is vacuously true of no groups, and reading it
/// that way would hand peak priority to every member nobody has classified — the opposite of the
/// blueprint A.12 rule, under which a member was Regular until an admin said otherwise. So the
/// empty set is "no", stated here because it is the one case the plan's phrase does not decide.
/// The cost is known and accepted: a league member an admin adds to a pricing-only group that
/// does not grant peak loses the priority. The refusal names that group (<see
/// cref="MemberTariff.PeakWithheldBy"/>) so the member and the desk can see why.
/// </para>
///
/// <para>
/// <b>Archived groups contribute nothing</b>, as in <see cref="GroupRules"/>. <b>The club's
/// <c>member_groups_enabled</c> switch does NOT turn the tariff off.</b> That switch governs the
/// booking restrictions a group adds (windows, price, caps); the rate and the peak priority are
/// the tariff the member class used to carry, which no switch ever turned off, and a club that
/// disabled restrictions must not silently move every league member to the regular rate.
/// </para>
/// </summary>
public static class MemberTariffs
{
    /// <summary>The tariff for one member, read from their active groups.</summary>
    public static async Task<MemberTariff> ForAsync(
        MainframeDbContext db, Guid userId, TenantSettingsView settings, CancellationToken ct)
        => Resolve(await GroupsOfAsync(db, userId, ct), settings.CreditsPerZarRegular);

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
                (m, g) => new { m.UserId, g.Id, g.Name, g.SystemKey, g.CreditsPerZar, g.PeakPriority, g.SortOrder })
            .ToListAsync(ct);

        return rows
            .GroupBy(r => r.UserId)
            .ToDictionary(
                x => x.Key,
                x => (IReadOnlyList<TariffGroup>)x
                    .Select(r => new TariffGroup(r.Id, r.Name, r.SystemKey, r.CreditsPerZar, r.PeakPriority, r.SortOrder))
                    .OrderBy(g => g.SortOrder).ThenBy(g => g.Name, StringComparer.Ordinal).ThenBy(g => g.Id)
                    .ToList());
    }

    /// <summary>A group entity as the tariff reads it.</summary>
    public static TariffGroup From(MemberGroup g)
        => new(g.Id, g.Name, g.SystemKey, g.CreditsPerZar, g.PeakPriority, g.SortOrder);

    /// <summary>
    /// The rule itself, pure, so it can be pinned without a database. <paramref name="groups"/>
    /// must already be the ACTIVE groups; ties on the rate go to the club's own order, so the
    /// group a top-up row names is deterministic.
    /// </summary>
    public static MemberTariff Resolve(IReadOnlyList<TariffGroup> groups, decimal tenantDefaultRate)
    {
        var ordered = groups
            .OrderBy(g => g.SortOrder).ThenBy(g => g.Name, StringComparer.Ordinal).ThenBy(g => g.Id)
            .ToList();

        TariffGroup? rateGroup = null;
        foreach (var group in ordered)
        {
            if (group.CreditsPerZar is not { } rate || rate <= 0) continue;
            if (rateGroup is null || rate < rateGroup.CreditsPerZar!.Value) rateGroup = group;
        }

        var peak = ordered.Count > 0 && ordered.All(g => g.PeakPriority);
        return new MemberTariff(rateGroup?.CreditsPerZar ?? tenantDefaultRate, rateGroup, peak, ordered);
    }
}
