namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// How much court time one member may hold on one club day — the bounds, and the reader that
/// clamps a stored value into them.
///
/// <para>
/// <b>Two caps, both real.</b> <c>member_per_day_max_minutes</c> is blueprint A.4 and is the
/// customer's own word; <c>member_max_slots_per_day</c> is GOAL item 19, which asked for a
/// number of SLOTS because that is what a member counts and what a grid can lock buttons
/// against. Both are evaluated and the refusal names the one that bound, so the sentence the
/// member reads is about the rule that actually stopped them.
/// </para>
///
/// <para>
/// <b>Zero means unlimited</b>, everywhere in this codebase — <c>CheckPerDayCapAsync</c> has
/// read it that way since it was written. That is why <see cref="MinOf"/> exists rather than a
/// plain <c>Math.Min</c>: a member in one unlimited group and one capped group must get the
/// capped number, and a naive minimum would make the unlimited group forbid everything.
/// </para>
/// </summary>
public static class BookingLimits
{
    /// <summary>96 quarter-hours is a whole day, which is also <c>MaxSlicesPerBooking</c>.</summary>
    public const int MaxSlotsPerDayCeiling = 96;

    /// <summary>Minutes in a day. A cap above it is the same as no cap and reads as a typo.</summary>
    public const int MaxMinutesPerDayCeiling = 1440;

    /// <summary>
    /// Four quarter-hours — sixty minutes, exactly matching the existing
    /// <c>member_per_day_max_minutes</c> default, so installing item 19 changes nothing for
    /// Crusaders until an admin moves one of them.
    /// </summary>
    public const int DefaultMaxSlotsPerDay = 4;

    /// <summary>Blueprint A.4 — one hour per member per day.</summary>
    public const int DefaultMaxMinutesPerDay = 60;

    /// <summary>
    /// How close to a slot's start the same-day relaxation applies. Two hours: the relaxation
    /// is about filling a court that is about to go unused, not about a blanket exemption for
    /// the whole day. Without a window a member books their cap at 06:00 and the whole evening
    /// at 06:05 — which is the behaviour <c>D2-B11</c> describes and the reason the cap has
    /// never once bitten.
    /// </summary>
    public const int DefaultSameDayRelaxationWindowMinutes = 120;

    /// <summary>The widest relaxation window a club may run — a day, i.e. the whole club day.</summary>
    public const int MaxSameDayRelaxationWindowMinutes = 1440;

    /// <summary>The club's slot cap for a member with no group override, clamped.</summary>
    public static int MaxSlotsPerDay(TenantSettingsView settings)
        => Math.Clamp(settings.MemberMaxSlotsPerDay, 0, MaxSlotsPerDayCeiling);

    /// <summary>The club's minute cap for a member with no group override, clamped.</summary>
    public static int MaxMinutesPerDay(TenantSettingsView settings)
        => Math.Clamp(settings.MemberPerDayMaxMinutes, 0, MaxMinutesPerDayCeiling);

    /// <summary>How close to start the same-day relaxation reaches, clamped.</summary>
    public static int SameDayRelaxationWindowMinutes(TenantSettingsView settings)
        => Math.Clamp(settings.SameDayRelaxationWindowMinutes, 0, MaxSameDayRelaxationWindowMinutes);

    /// <summary>
    /// The most restrictive of two caps where <b>0 means unlimited</b>.
    ///
    /// <para>
    /// Pinned by its own test because the naive reading is wrong in the direction that shuts
    /// the club: <c>Math.Min(0, 4)</c> is 0, and 0 here means "no limit", so one unlimited
    /// group would silently hand every member an unlimited allowance — or, read the other way
    /// round by a later reader, forbid everything. Neither is a rule anybody wrote down.
    /// </para>
    /// </summary>
    public static int MinOf(int a, int b)
    {
        if (a <= 0) return Math.Max(b, 0);
        if (b <= 0) return a;
        return Math.Min(a, b);
    }
}
