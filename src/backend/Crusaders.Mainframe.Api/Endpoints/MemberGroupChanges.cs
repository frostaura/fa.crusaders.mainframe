using Crusaders.Mainframe.Api.Domain;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// What a member-group edit changed, in the shape the club's change record stores: the changed
/// fields only, before and after.
///
/// <para>
/// <b>Why groups are recorded at all.</b> A group decides what its members may book, when, and
/// what they pay — changing one moves money and court time for every member in it, with no
/// screen showing any of them that it happened. The vocabulary has carried
/// <c>group.created</c>, <c>group.updated</c>, <c>group.archived</c> and
/// <c>group.members_changed</c> since the change record was built, and nothing wrote any of
/// them (decision R19's change-log gap list, 2026-09-23).
/// </para>
///
/// <para>
/// Its own file rather than helpers in <see cref="MemberGroupEndpoints"/>: that file is long
/// already, and lizard charges an extracted helper to the file it lands in
/// (<c>memory/gotchas-gates.md</c>).
/// </para>
/// </summary>
internal static class MemberGroupChanges
{
    /// <summary>
    /// Every field an admin can edit, as the change record names it. Windows are included only
    /// when the caller read them — a PATCH that does not name windows does not touch them.
    /// </summary>
    public static Dictionary<string, object?> Snapshot(MemberGroup group, IEnumerable<MemberGroupWindow>? windows)
    {
        var snapshot = new Dictionary<string, object?>
        {
            ["name"] = group.Name,
            ["description"] = group.Description,
            ["status"] = group.Status.ToString().ToLowerInvariant(),
            ["pricing_mode"] = group.PricingMode.ToString(),
            ["multiplier_bps"] = group.PriceMultiplierBps,
            ["flat_slice_price_credits"] = group.FlatSlicePriceCredits,
            ["max_slots_per_day"] = group.MaxSlotsPerDay,
            ["max_minutes_per_day"] = group.MaxMinutesPerDay,
            ["advance_booking_days"] = group.AdvanceBookingDays,
            // D2: a group's top-up rate and peak priority move money and court time for every
            // member in it, so they are recorded like its price.
            ["credits_per_zar"] = group.CreditsPerZar,
            ["peak_priority"] = group.PeakPriority,
        };

        if (windows is not null)
        {
            snapshot["windows"] = string.Join(", ", windows
                .OrderBy(w => w.DayOfWeek).ThenBy(w => w.StartMinute)
                .Select(w => $"{w.DayOfWeek.ToString()[..3].ToLowerInvariant()} "
                    + $"{Services.BookingService.MinutesToHhmm(w.StartMinute)}-{Services.BookingService.MinutesToHhmm(w.EndMinute)}"));
        }

        return snapshot;
    }

    /// <summary>
    /// The keys whose values differ, from each side. Changed keys only — the recorder's
    /// contract is never a whole document.
    /// </summary>
    public static (Dictionary<string, object?> Before, Dictionary<string, object?> After) Diff(
        Dictionary<string, object?> before, Dictionary<string, object?> after)
    {
        var changedBefore = new Dictionary<string, object?>();
        var changedAfter = new Dictionary<string, object?>();

        foreach (var (key, value) in after)
        {
            before.TryGetValue(key, out var old);
            if (Equals(old, value)) continue;
            changedBefore[key] = old;
            changedAfter[key] = value;
        }

        return (changedBefore, changedAfter);
    }
}

/// <summary>
/// One PATCH's worth of group change: the group as it now is, what it was, and whether it was
/// already archived before this edit — so an edit to an archived group is not recorded as
/// archiving it again.
/// </summary>
internal sealed record GroupPatchChange(
    MemberGroup Group, string? Reason, Dictionary<string, object?> Before,
    List<MemberGroupWindow>? NewWindows, bool WasArchived);
