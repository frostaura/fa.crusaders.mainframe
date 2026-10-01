using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

public sealed class ScheduleService
{
    private readonly MainframeDbContext _db;
    private readonly TenantSettingsAccessor _settings;
    private readonly BookingRules _rules;

    public ScheduleService(MainframeDbContext db, TenantSettingsAccessor settings, BookingRules rules)
    { _db = db; _settings = settings; _rules = rules; }

    public async Task<ScheduleDay> GetDayAsync(DateOnly date, Guid? viewingUserId, CancellationToken ct)
        => await GetDayAsync(date, viewingUserId, viewerIsAdmin: false, ct);

    public async Task<ScheduleDay> GetDayAsync(DateOnly date, Guid? viewingUserId, bool viewerIsAdmin, CancellationToken ct)
    {
        var settings = await _settings.GetAsync(ct);
        var dayStartLocal = date.ToDateTime(TimeOnly.MinValue);

        // D2-B36. This was raw ConvertTimeToUtc on an Unspecified midnight plus a flat AddDays(1)
        // — which THROWS on a zone whose midnight does not exist, silently takes the later
        // instant on an ambiguous one, and makes every DST day either 23 or 25 hours long while
        // claiming 24. ClubClock is the one implementation.
        var (dayStartUtc, dayEndUtc) = ClubClock.DayWindow(settings, date);

        // D2-B34. This loaded only IsActive courts while the booking read below is not filtered
        // by court, so a member's paid booking on a court an admin had "deleted" (a soft delete
        // that sets exactly this flag) was silently dropped from the grid: on no screen, not
        // cancellable from the UI, and still swept as a no-show WITH the penalty. Inactive courts
        // are loaded and rendered inert instead, which is the honest state.
        var courts = await _db.Courts.OrderBy(c => c.CourtNumber).ToListAsync(ct);

        var bookings = await _db.Bookings
            .Where(b => b.Status != BookingStatus.Cancelled
                     && b.StartsAt < dayEndUtc && b.EndsAt > dayStartUtc)
            .ToListAsync(ct);

        var userIds = bookings.Where(b => b.UserId is not null).Select(b => b.UserId!.Value).Distinct().ToList();
        var memberByUser = await _db.Memberships
            .Where(m => userIds.Contains(m.UserId))
            .ToDictionaryAsync(m => m.UserId, ct);

        // Courts keyed once rather than re-scanned per booking: the old shape walked the
        // whole booking list once per court, which on a four-court day is four passes and
        // on a twenty-court club is twenty. The output order is unchanged.
        var bookingsByCourt = bookings.ToLookup(b => b.CourtId);

        // One read for the whole grid, not one per cell. A league night is four courts by
        // twelve slices, so resolving the plan's name inside the loop would be forty-eight
        // queries for one string — the N+1 the lookup above already exists to prevent.
        var scheduleIds = bookings.Where(b => b.ScheduleId is not null)
            .Select(b => b.ScheduleId!.Value).Distinct().ToList();
        var scheduleNames = scheduleIds.Count == 0
            ? []
            : await _db.BookingSchedules.AsNoTracking()
                .Where(s => scheduleIds.Contains(s.Id))
                .ToDictionaryAsync(s => s.Id, s => s.Name, ct);

        // B2 (review round 1): a game the viewer is an ACCEPTED partner on is theirs too — tappable
        // through to its booking — with the role saying which side of it they are on.
        var partnerOn = await PartnerOnAsync(bookings, viewingUserId, ct);

        var slots = new List<ScheduleSlot>(bookings.Count);
        foreach (var court in courts)
        {
            foreach (var b in bookingsByCourt[court.Id])
            {
                var member = b.UserId is { } u ? memberByUser.GetValueOrDefault(u) : null;
                var role = RoleOf(b, viewingUserId, partnerOn);
                var isMine = role is not null;

                // Attendance and price are the booking OWNER's business, and the admin's.
                // "The booking grid shows photo + name only" — no email, phone, membership
                // number, and by the same reasoning no other member's spend. Null rather
                // than zero, so the client cannot render a figure it was never given.
                var maySeeDetail = isMine || viewerIsAdmin;

                slots.Add(new ScheduleSlot(
                    CourtId: court.Id,
                    CourtNumber: court.CourtNumber,
                    StartsAtUtc: b.StartsAt,
                    EndsAtUtc: b.EndsAt,
                    Status: b.Status.ToString().ToLowerInvariant(),
                    OwnerUserId: b.UserId,
                    OwnerFirstName: member is null ? null : FirstName(member.FullName),
                    OwnerPhotoUrl: member?.PhotoUrl,
                    IsMine: isMine,
                    BookingId: b.Id,
                    BlockLabel: b.BlockLabel,
                    // The single fact the cancel affordance needed and never had: the
                    // lights have been on, so nothing comes back. A grep of the frontend
                    // for check-in used to return three comments and no rendered field,
                    // because the projection did not carry it at all.
                    CheckedIn: maySeeDetail ? b.CheckedInAt is not null : null,
                    AmountChargedCredits: maySeeDetail ? b.AmountChargedCredits : null,
                    ScheduleId: b.ScheduleId,
                    ScheduleName: b.ScheduleId is { } sid ? scheduleNames.GetValueOrDefault(sid) : null,
                    Role: role));
            }
        }

        // The hours for THIS weekday, not a flat pair. tenant_settings.operating_hours has
        // been written by the seeder since day one and read by nothing, so a club that
        // shuts at 20:00 on a Saturday had its grid drawn to 22:00 and sold every slot in
        // between. Same two field names on the wire: the client asks for one day at a time
        // and this is that day's answer.
        var (openMinute, closeMinute) = settings.HoursFor(dayStartLocal.DayOfWeek);

        // N-F6. The peak-hours rule was enforced by BookingService and invisible to the grid,
        // so 44 cells a day rendered to a Regular member as green, clickable "Available" —
        // same colour, same cursor, same "Book Court 2 at 17:00 for 50.00 cr" label as a slot
        // they could actually have — and the refusal arrived only after they had read a price
        // and pressed Confirm. The client cannot infer this: the member's peak standing is not on any
        // member-facing payload and peak_hours is admin-only. So the day carries the window,
        // the advance allowance, and one flag saying whether THIS viewer is bound by it.
        var peak = settings.PeakHours();
        var viewerMayBookPeak = viewerIsAdmin || await ViewerBypassesPeakAsync(viewingUserId, settings, ct);

        var rules = await ViewerRulesAsync(date, viewingUserId, viewerIsAdmin, settings, ct);

        return new ScheduleDay(
            Date: date,
            Timezone: settings.Timezone,
            SliceMinutes: settings.SliceMinutes,
            DayStartMinute: openMinute,
            DayEndMinute: closeMinute,
            AdvanceBookingDays: settings.AdvanceBookingDays,
            PenaltyPct: settings.PenaltyPct,
            PenaltyWindowMinutes: settings.PenaltyWindowMinutes,
            PeakStartMinute: peak is { } p ? (int)p.start.ToTimeSpan().TotalMinutes : null,
            PeakEndMinute: peak is { } q ? (int)q.end.ToTimeSpan().TotalMinutes : null,
            PeakAdvanceHoursForRegular: settings.PeakAdvanceHoursForRegular,
            ViewerMayBookPeak: viewerMayBookPeak,
            // The court's OWN price, unchanged — D2 §4.4 keeps `courts` as it is. The price the
            // member will actually be charged is `rules.slicePriceCredits`, because their groups
            // may have raised it above the court's and the grid paints free cells from `rules`.
            Courts: courts.Select(c => new ScheduleCourt(
                c.Id, c.CourtNumber, c.Name, c.SlicePriceCredits, c.IsActive)).ToList(),
            Slots: slots,
            Rules: rules);
    }

    /// <summary>The bookings among these the viewer holds an ACCEPTED partner seat on (B2).</summary>
    private async Task<HashSet<Guid>> PartnerOnAsync(List<Booking> bookings, Guid? viewingUserId, CancellationToken ct)
    {
        if (viewingUserId is not { } viewer || bookings.Count == 0) return [];
        var ids = bookings.Select(b => b.Id).ToList();
        return (await _db.BookingParticipants.AsNoTracking()
            .Where(p => p.UserId == viewer && p.Seat > 1 && p.Status == ParticipantStatus.Accepted && ids.Contains(p.BookingId))
            .Select(p => p.BookingId).ToListAsync(ct)).ToHashSet();
    }

    /// <summary>The viewer's side of a booking: organiser, accepted partner, or none of theirs (null).</summary>
    private static string? RoleOf(Booking b, Guid? viewingUserId, HashSet<Guid> partnerOn)
    {
        if (viewingUserId is not null && viewingUserId == b.UserId) return "organiser";
        return partnerOn.Contains(b.Id) ? "partner" : null;
    }

    /// <summary>
    /// Everything this viewer's own rules say about this day, in ONE object, so the grid can lock
    /// buttons and quote prices from a single read rather than by guessing or by a failed POST.
    ///
    /// <para>
    /// <b>"available is a promise the grid makes", and it was broken once already</b>: 44 cells a
    /// day were drawn green to a Regular member, each opening a modal quoting court, time, cost
    /// and balance-after before refusing after Confirm. Item 19 would repeat that exactly, for
    /// the cap, if the count were not on the payload — so <see cref="ScheduleRules.RemainingToday"/>
    /// is what the UI locks on, never a failed request.
    /// </para>
    ///
    /// <para>
    /// <b>An admin gets nulls, not numbers.</b> <c>RemainingToday</c> is null and every reason is
    /// null: an admin's grid states that they have no limit rather than showing them a figure
    /// that does not apply to them.
    /// </para>
    ///
    /// <para>
    /// Null for an anonymous viewer, who has no rules and no allowance to report.
    /// </para>
    /// </summary>
    private async Task<ScheduleRules?> ViewerRulesAsync(
        DateOnly date, Guid? viewingUserId, bool viewerIsAdmin, TenantSettingsView settings, CancellationToken ct)
    {
        if (viewingUserId is not { } userId) return null;

        var groups = await _rules.GroupsForAsync(userId, date.DayOfWeek, settings, ct);
        var (openMinute, closeMinute) = settings.HoursFor(date.DayOfWeek);
        var clubHours = new MinuteWindow(openMinute, closeMinute);

        var allowed = GroupRules.AllowedWindows(groups, clubHours);
        var courts = await _db.Courts.Where(c => c.IsActive)
            .OrderBy(c => c.CourtNumber).Select(c => new { c.Id, c.SlicePriceCredits }).ToListAsync(ct);
        var price = GroupRules.PriceFor(groups, courts.Count > 0 ? courts[0].SlicePriceCredits : settings.DefaultSlicePriceCredits);
        // Review round 5 (I5-1, asked by lane C): what THIS viewer pays on each court. One figure on
        // the first court made the grid derive the rest, wrong for a flat-per-slice group on a
        // dearer court until Confirm. Same arithmetic as the booking (GroupRules.PriceFor).
        var perCourt = courts.Select(c => new CourtSlicePrice(c.Id, GroupRules.PriceFor(groups, c.SlicePriceCredits))).ToList();

        // An admin's grid states that they have no limit rather than showing them a number that
        // does not apply to them: RemainingToday is null, not a figure they would then wonder
        // about.
        if (viewerIsAdmin) return AdminRules(date, clubHours, price, settings.AdvanceBookingDays) with { SlicePricesByCourt = perCourt };

        var slotCap = GroupRules.SlotCapFor(groups, BookingLimits.MaxSlotsPerDay(settings));
        var minuteCap = GroupRules.MinuteCapFor(groups, BookingLimits.MaxMinutesPerDay(settings));

        var (dayStart, dayEnd) = ClubClock.DayWindow(settings, date);
        var held = await _db.Bookings
            .Where(b => b.UserId == userId
                     && b.Status != BookingStatus.Cancelled
                     && b.StartsAt < dayEnd && b.EndsAt > dayStart)
            .Select(b => new { b.SliceCount, b.StartsAt, b.EndsAt })
            .ToListAsync(ct);

        var bookedSlots = held.Sum(b => b.SliceCount);
        var bookedMinutes = (int)held.Sum(b => (b.EndsAt - b.StartsAt).TotalMinutes);

        // The number item 19 asks the UI to lock buttons on: the tighter of the two headrooms,
        // floored at zero. A cap of 0 is unlimited, which is null here rather than a big number.
        var remaining = RemainingSlots(slotCap, minuteCap, bookedSlots, bookedMinutes, settings.SliceMinutes);

        return new ScheduleRules(
            ClubDay: date,
            Groups: groups.Select(g => new ScheduleGroup(g.Id, g.Name, g.Description)).ToList(),
            AllowedWindows: allowed.Select(WireWindow.Of).ToList(),
            ClubHours: WireWindow.Of(clubHours),
            SlicePriceCredits: price,
            MaxSlotsPerDay: slotCap > 0 ? slotCap : null,
            MaxMinutesPerDay: minuteCap > 0 ? minuteCap : null,
            BookedSlotsToday: bookedSlots,
            BookedMinutesToday: bookedMinutes,
            RemainingToday: remaining,
            AdvanceBookingDays: GroupRules.AdvanceDaysFor(groups, settings.AdvanceBookingDays),
            AdminExempt: false,
            SlicePricesByCourt: perCourt,
            // Present ONLY when the intersection is genuinely empty, so the console can say the
            // true sentence in words instead of drawing a grid that reads as "the club is shut".
            EmptyWindowReason: allowed.Count == 0
                ? new EmptyWindowReason(groups.Select(g => g.Name).ToList(), BookingRules.DayName(date.DayOfWeek))
                : null);
    }

    /// <summary>An admin's rules: the club's own hours, and no limit of any kind.</summary>
    private static ScheduleRules AdminRules(DateOnly date, MinuteWindow clubHours, decimal price, int advanceDays)
    {
        return new ScheduleRules(
            ClubDay: date, Groups: [], AllowedWindows: [WireWindow.Of(clubHours)], ClubHours: WireWindow.Of(clubHours),
            SlicePriceCredits: price,
            MaxSlotsPerDay: null, MaxMinutesPerDay: null,
            BookedSlotsToday: 0, BookedMinutesToday: 0, RemainingToday: null,
            AdvanceBookingDays: advanceDays,
            AdminExempt: true, EmptyWindowReason: null);
    }

    /// <summary>
    /// The number GOAL item 19 asks the UI to lock buttons on: the tighter of the two headrooms,
    /// floored at zero.
    ///
    /// <para>
    /// <b>Null means no limit</b> — an admin, or a club with both caps off — which is a different
    /// thing from 0, and a client that conflated them would either lock every button or none.
    /// </para>
    /// </summary>
    private static int? RemainingSlots(int slotCap, int minuteCap, int bookedSlots, int bookedMinutes, int sliceMinutes)
    {
        if (slotCap <= 0 && minuteCap <= 0) return null;

        var slotHeadroom = slotCap > 0 ? Math.Max(slotCap - bookedSlots, 0) : int.MaxValue;
        var minuteHeadroom = minuteCap > 0
            ? Math.Max((minuteCap - bookedMinutes) / Math.Max(sliceMinutes, 1), 0)
            : int.MaxValue;
        return Math.Min(slotHeadroom, minuteHeadroom);
    }

    /// <summary>
    /// Does this viewer hold peak priority (blueprint A.12, granted by groups since D2)?
    /// </summary>
    /// <remarks>
    /// The same <see cref="MemberTariffs"/> answer <c>BookingRules.PeakRefusal</c> reads, so the
    /// grid and the booking path cannot disagree. An anonymous viewer, or one in no group, gets
    /// the stricter answer: the grid may never offer a slot the booking service would refuse,
    /// and the cost of being wrong the other way is one extra cell drawn as restricted.
    /// </remarks>
    private async Task<bool> ViewerBypassesPeakAsync(Guid? viewingUserId, TenantSettingsView settings, CancellationToken ct)
    {
        if (viewingUserId is not { } userId) return false;
        return (await MemberTariffs.ForAsync(_db, userId, settings, ct)).PeakPriority;
    }

    private static string FirstName(string fullName)
    {
        var i = fullName.IndexOf(' ');
        return i < 0 ? fullName : fullName[..i];
    }

}

public sealed record ScheduleDay(
    DateOnly Date,
    string Timezone,
    int SliceMinutes,
    int DayStartMinute,
    int DayEndMinute,
    int AdvanceBookingDays,
    decimal PenaltyPct,
    int PenaltyWindowMinutes,
    /// <summary>Peak window, minutes past local midnight. Null when `peak_hours` is unset or malformed.</summary>
    int? PeakStartMinute,
    int? PeakEndMinute,
    /// <summary>How close to a peak slot a Regular member may take it anyway (A.12).</summary>
    int PeakAdvanceHoursForRegular,
    /// <summary>True for an admin or a member with peak priority (D2: every one of their groups grants it) — the two the peak rule never refuses.</summary>
    bool ViewerMayBookPeak,
    List<ScheduleCourt> Courts,
    List<ScheduleSlot> Slots,
    /// <summary>This viewer's own rules for this day. Null for an anonymous viewer, who has none.</summary>
    ScheduleRules? Rules = null);

/// <param name="IsActive">
/// False for a court an admin has "deleted" — a soft delete. D2-B34: those courts used to be
/// dropped from this list entirely, taking their members' paid bookings off every screen in the
/// product while the no-show sweep went on penalising them. They are rendered inert instead.
/// </param>
public sealed record ScheduleCourt(
    Guid Id, int CourtNumber, string Name, decimal SlicePriceCredits, bool IsActive = true);

/// <summary>One of the viewer's groups, as the grid may show it. Name and description only — never who else is in it.</summary>
public sealed record ScheduleGroup(Guid Id, string Name, string? Description);

/// <summary>
/// What this member may book today, what it costs them, and how much of their allowance is left —
/// the one read the grid needs to be honest.
/// </summary>
/// <param name="RemainingToday">
/// Slots this member may still take today: <c>min(slot headroom, minute headroom / slice)</c>,
/// floored at zero. <b>Null means no limit</b>, which is an admin or a club with both caps off —
/// not zero, which means they are out.
/// </param>
/// <param name="EmptyWindowReason">
/// Non-null only when the member's groups genuinely do not overlap on this day, naming them and
/// the day, so the console can say so in words rather than drawing an empty grid that reads to a
/// member as the club being shut.
/// </param>
public sealed record ScheduleRules(
    DateOnly ClubDay,
    IReadOnlyList<ScheduleGroup> Groups,
    IReadOnlyList<WireWindow> AllowedWindows,
    WireWindow ClubHours,
    decimal SlicePriceCredits,
    int? MaxSlotsPerDay,
    int? MaxMinutesPerDay,
    int BookedSlotsToday,
    int BookedMinutesToday,
    int? RemainingToday,
    int AdvanceBookingDays,
    bool AdminExempt,
    EmptyWindowReason? EmptyWindowReason,
    IReadOnlyList<CourtSlicePrice>? SlicePricesByCourt = null);

/// <summary>What the viewer pays for one slice of one active court (wire: <c>{ courtId, credits }</c>).</summary>
public sealed record CourtSlicePrice(Guid CourtId, decimal Credits);

/// <summary>
/// One window on the wire, as <c>HH:mm</c> rather than as minutes past midnight.
///
/// <para>
/// Strings because the grid renders them and because minutes-past-midnight is the kind of number
/// a client eventually renders as <c>1080</c> by accident — the admin change record has the same
/// rule about its own diffs for the same reason.
/// </para>
/// </summary>
public sealed record WireWindow(string Start, string End)
{
    public static WireWindow Of(MinuteWindow window)
        => new(BookingService.MinutesToHhmm(window.Start), BookingService.MinutesToHhmm(window.End));
}

/// <summary>Both halves of the conditional, in words: which groups, and which day.</summary>
public sealed record EmptyWindowReason(IReadOnlyList<string> Groups, string Day);

public sealed record ScheduleSlot(
    Guid CourtId,
    int CourtNumber,
    DateTimeOffset StartsAtUtc,
    DateTimeOffset EndsAtUtc,
    string Status,
    Guid? OwnerUserId,
    string? OwnerFirstName,
    string? OwnerPhotoUrl,
    bool IsMine,
    Guid? BookingId,
    string? BlockLabel,
    bool? CheckedIn,
    decimal? AmountChargedCredits,

    /// <summary>
    /// The repeating schedule that produced this row, when one did — item 14.
    ///
    /// <para>
    /// <b>The NAME, not the label, and both are deliberate.</b> An occurrence's
    /// <c>BlockLabel</c> is the schedule's <c>Label</c> — the words the club wants ON the cell
    /// ("League — Div 1"). This is the schedule's <c>Name</c>, which is unique per club and is
    /// what identifies the plan a hold belongs to ("Tuesday league"). The grid renders the
    /// plan's name beside "Club hold"; the label alone could not say which of two league nights
    /// this is, because a label is not unique.
    /// </para>
    ///
    /// <para>
    /// Null on every ordinary booking and on a one-off admin block, which is what lets a cell
    /// tell a recurring hold from a hold somebody made by hand.
    /// </para>
    /// </summary>
    Guid? ScheduleId = null,
    string? ScheduleName = null,

    /// <summary>
    /// The viewer's side of a booking that is theirs (<see cref="IsMine"/>): <c>organiser</c> or
    /// <c>partner</c> (an accepted seat — review round 1, B2). Null on everybody else's.
    /// </summary>
    string? Role = null);
