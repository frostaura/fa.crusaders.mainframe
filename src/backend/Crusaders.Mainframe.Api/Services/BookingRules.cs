using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// Who is booking, and what the club knows about them that changes the answer.
/// </summary>
/// <param name="ActorIsAdmin">
/// <b>The role claim, threaded down from the route group — never re-derived from
/// <c>actorId != userId</c>.</b> That inference is D2-B13 and it was wrong in both directions:
/// an admin booking for THEMSELVES was not exempt and was refused by peak hours and the cap,
/// while nothing on the path ever asked whether the actor held the admin role at all.
/// <c>CancelAsync</c> already takes this explicitly, for the same reason and after the same
/// inference turned out to be an in-tenant IDOR; half the file learned the lesson and
/// <c>CreateAsync</c> did not.
/// </param>
public readonly record struct RuleSubject(
    Guid UserId,
    Guid ActorUserId,
    bool ActorIsAdmin,
    MemberClass Class,
    IReadOnlyList<MemberGroupRules> Groups);

/// <summary>The court time being asked for.</summary>
public readonly record struct RuleSlot(
    Guid CourtId,
    DateTimeOffset StartsAt,
    DateTimeOffset EndsAt,
    int SliceCount,
    decimal CourtSlicePriceCredits,
    bool IsWalkUp);

/// <summary>Allowed, at a price — or refused, with every figure the refusal's sentence needs.</summary>
public abstract record RuleVerdict
{
    public sealed record Allowed(decimal SlicePriceCredits) : RuleVerdict;

    public sealed record Refused(BookingResult Result) : RuleVerdict;
}

/// <summary>
/// Every rule that decides whether a member may take a slot, and what they pay for it —
/// evaluated in one place, so nine features cannot make the decision nine ways.
///
/// <para>
/// <b>Called TWICE, deliberately.</b> Once in <c>CreateAsync</c> before the row is built, as a
/// fast refusal on the common case; and once inside <c>CommitAsync</c> <b>after
/// <see cref="PayerLock"/> has been taken</b>, as the authoritative one. That is exactly the
/// pattern the balance check already documents — "the caller's check is a fast refusal… the
/// authoritative check happens here, under a lock on the payer, in the same transaction as the
/// debit" — and applying it to the caps is the fix for <b>D2-B12</b>, where the cap was read at
/// line 112 and the lock taken at line 532, so two tabs beat it. The lock is keyed on
/// <c>(tenant, payer)</c>, which is precisely the cap's own unit.
/// </para>
///
/// <para>
/// <b>The grid calls the same evaluator in projection mode</b>, so a slot the grid paints green
/// is a slot the API will accept. <c>available</c> is a promise the grid makes, and it was broken
/// once already: 44 cells a day were drawn green to a Regular member, each opening a modal
/// quoting court, time, cost and balance-after before refusing after Confirm. One evaluator is
/// what stops item 19 repeating that for the cap.
/// </para>
/// </summary>
public sealed class BookingRules
{
    private readonly MainframeDbContext _db;

    public BookingRules(MainframeDbContext db) => _db = db;

    /// <summary>
    /// The member's groups, as the evaluator needs them for one club day.
    ///
    /// <para>
    /// Two flat reads, no N+1: the member's group ids through the <c>(TenantId, UserId)</c>
    /// index, then those groups and their windows. A club has at most 32 groups and a member is
    /// in a handful.
    /// </para>
    ///
    /// <para>
    /// Archived groups are excluded here rather than in the combinator, so "archived" means the
    /// same thing to every reader: it stops contributing to the member's rules while keeping its
    /// rows, which is what makes the change reversible and explicable.
    /// </para>
    /// </summary>
    public async Task<IReadOnlyList<MemberGroupRules>> GroupsForAsync(
        Guid userId, DayOfWeek day, TenantSettingsView settings, CancellationToken ct)
    {
        if (!settings.MemberGroupsEnabled) return [];

        var groupIds = await _db.MemberGroupMembers
            .Where(m => m.UserId == userId)
            .Select(m => m.GroupId)
            .ToListAsync(ct);
        if (groupIds.Count == 0) return [];

        var groups = await _db.MemberGroups
            .Where(g => groupIds.Contains(g.Id) && g.Status == MemberGroupStatus.Active)
            .OrderBy(g => g.SortOrder).ThenBy(g => g.Name)
            .ToListAsync(ct);
        if (groups.Count == 0) return [];

        var liveIds = groups.Select(g => g.Id).ToList();
        var windows = await _db.MemberGroupWindows
            .Where(w => liveIds.Contains(w.GroupId))
            .ToListAsync(ct);

        return groups.Select(g => new MemberGroupRules(
            g.Id, g.Name, g.Description,
            g.PricingMode, g.PriceMultiplierBps, g.FlatSlicePriceCredits,
            g.MaxSlotsPerDay, g.MaxMinutesPerDay, g.AdvanceBookingDays,
            HasAnyWindows: windows.Any(w => w.GroupId == g.Id),
            WindowsForDay: GroupRules.WindowsFor(windows.Where(w => w.GroupId == g.Id), day)))
            .ToList();
    }

    /// <summary>
    /// The whole decision: hours, group windows, peak, both per-day caps, and the price.
    ///
    /// <para>
    /// Order matters and is the order a member would ask the questions in — is the club open, may
    /// I book at this time, is this peak, have I used my allowance. A cap refusal for a slot the
    /// club is shut for would be a true sentence about the wrong problem.
    /// </para>
    /// </summary>
    public async Task<RuleVerdict> EvaluateAsync(
        RuleSubject subject, RuleSlot slot, TenantSettingsView settings, CancellationToken ct)
    {
        var price = GroupRules.PriceFor(subject.Groups, slot.CourtSlicePriceCredits);

        // An admin booking for themselves has no limits at all, and their grid says so rather
        // than showing them a number that does not apply. An admin booking ON BEHALF of a member
        // is a different question and is handled below: the club's ACCESS rules still hold,
        // because they are the club's rules about that member, and it is the CAP the admin is
        // exempting.
        if (subject.ActorIsAdmin && subject.ActorUserId == subject.UserId)
        {
            return new RuleVerdict.Allowed(price);
        }

        var onBehalf = subject.ActorIsAdmin;

        var day = ClubClock.DateOf(settings, slot.StartsAt);

        if (AccessRefusal(subject, slot, settings, day, onBehalf) is { } access) return Refuse(access);

        // A.12 peak, which an on-behalf admin booking bypasses: the desk is taking the decision.
        if (!onBehalf && !slot.IsWalkUp && PeakRefusal(subject.Class, slot, settings) is { } peak)
        {
            return Refuse(peak);
        }

        // Item 19 + blueprint A.4. Bypassed for an on-behalf admin booking — the cap is exactly
        // what a desk is overriding when it books for somebody — and for a walk-up unless the
        // club has asked otherwise. A walk-up always COUNTS toward the cap either way.
        if (onBehalf || (slot.IsWalkUp && !settings.WalkUpHonoursDayCap))
        {
            return new RuleVerdict.Allowed(price);
        }

        return await CapRefusalAsync(subject, slot, settings, day, ct) is { } cap
            ? Refuse(cap)
            : new RuleVerdict.Allowed(price);
    }

    private static RuleVerdict Refuse(BookingResult result) => new RuleVerdict.Refused(result);

    /// <summary>
    /// May this member be on a court at this TIME at all — the club's opening hours, then their
    /// groups' windows.
    ///
    /// <para>
    /// <b>An on-behalf admin booking bypasses the opening hours</b>, which is the contract
    /// <c>OperatingHoursTests</c> already pins: the desk booking a court outside advertised hours
    /// is the club deciding to open, and the club is allowed to. It does NOT bypass the group
    /// window, and the two are different questions — opening hours are a fact about the building
    /// that the desk owns, a group window is a rule about that MEMBER which the desk is not
    /// overriding by booking for them.
    /// </para>
    ///
    /// <para>
    /// A walk-up is truncated at the club's close by <c>SellableEndAsync</c> rather than refused,
    /// which is the right behaviour for somebody standing at the court, so it does not meet the
    /// hours rule here either.
    /// </para>
    ///
    /// <para>
    /// When the hours rule does not apply, the window intersection starts from the whole day
    /// rather than from the club's hours — seeding it with them would refuse through the back
    /// door exactly what was deliberately allowed through the front, and would do it to a member
    /// who is in no group at all.
    /// </para>
    /// </summary>
    private static BookingResult? AccessRefusal(
        RuleSubject subject, RuleSlot slot, TenantSettingsView settings, DateOnly day, bool onBehalf)
    {
        var startMinute = ClubClock.MinutesIntoDay(settings, slot.StartsAt);
        var endMinute = startMinute + (int)Math.Round((slot.EndsAt - slot.StartsAt).TotalMinutes);
        var (openMinute, closeMinute) = settings.HoursFor(day.DayOfWeek);
        var hoursApply = !onBehalf && !slot.IsWalkUp;

        if (hoursApply && (startMinute < openMinute || endMinute > closeMinute))
        {
            return new BookingResult.OutOfHours(
                BookingService.MinutesToHhmm(openMinute), BookingService.MinutesToHhmm(closeMinute));
        }

        var baseWindow = hoursApply
            ? new MinuteWindow(openMinute, closeMinute)
            : new MinuteWindow(0, 1440);

        return WindowRefusal(subject, day, baseWindow, startMinute, endMinute);
    }

    /// <summary>
    /// The member's groups intersected with the window the club is open in, and whether the
    /// booking fits inside ONE resulting stretch.
    ///
    /// <para>
    /// One stretch, not the union — see <see cref="GroupRules.Permits"/>: half the court time the
    /// member asked for is time they may not have, which is the same whole-range rule the
    /// operating-hours check already applies.
    /// </para>
    ///
    /// <para>
    /// The EMPTY case is its own refusal rather than a <c>GroupWindow</c> carrying no windows,
    /// because the honest sentence is completely different — "you are in two groups whose booking
    /// times do not overlap, so there is nothing you can book on a Tuesday" is not a narrower
    /// version of "not at this time".
    /// </para>
    /// </summary>
    private static BookingResult? WindowRefusal(
        RuleSubject subject, DateOnly day, MinuteWindow baseWindow, int startMinute, int endMinute)
    {
        var allowed = GroupRules.AllowedWindows(subject.Groups, baseWindow);
        var names = subject.Groups.Select(g => g.Name).ToList();

        if (allowed.Count == 0) return new BookingResult.NoBookableWindow(names, DayName(day.DayOfWeek));
        if (GroupRules.Permits(allowed, startMinute, endMinute)) return null;

        return new BookingResult.GroupWindow(
            names,
            DayName(day.DayOfWeek),
            allowed.Select(w =>
                (BookingService.MinutesToHhmm(w.Start), BookingService.MinutesToHhmm(w.End))).ToList());
    }

    private static BookingResult? PeakRefusal(MemberClass memberClass, RuleSlot slot, TenantSettingsView settings)
    {
        if (memberClass == MemberClass.LeagueOrSenior) return null;
        if (settings.PeakHours() is not { } peak) return null;

        var local = TimeZoneInfo.ConvertTime(slot.StartsAt, ClubClock.ZoneOf(settings));
        var slotStart = TimeOnly.FromDateTime(local.DateTime);
        if (slotStart < peak.start || slotStart >= peak.end) return null;

        var hoursUntil = (slot.StartsAt - DateTimeOffset.UtcNow).TotalHours;
        return hoursUntil > settings.PeakAdvanceHoursForRegular
            ? new BookingResult.PeakHoursLeagueOnly(
                peak.start.ToString("HH:mm"), peak.end.ToString("HH:mm"), settings.PeakAdvanceHoursForRegular)
            : null;
    }

    /// <summary>
    /// How much of this club day the member already holds, and whether this slot fits.
    ///
    /// <para>
    /// <c>Status != Cancelled</c> matches the exclusion constraint's own predicate, so "counts
    /// against my cap" and "holds a court" are the same set: a <c>NoShow</c> and a
    /// <c>Completed</c> count, a <c>Cancelled</c> does not, and an <c>AdminBlock</c> has
    /// <c>UserId == null</c> and cannot appear.
    /// </para>
    ///
    /// <para>
    /// <b>Counted by <c>UserId</c>, not <c>PaidByUserId</c>.</b> A booking whose payer was
    /// reassigned at the court still counts against the member whose booking it is. That is the
    /// right reading — the cap is about court time a person OCCUPIES, not about whose wallet paid
    /// — and it is written down because those two fields diverge on exactly one path.
    /// </para>
    /// </summary>
    private async Task<BookingResult?> CapRefusalAsync(
        RuleSubject subject, RuleSlot slot, TenantSettingsView settings, DateOnly day, CancellationToken ct)
    {
        var slotCap = GroupRules.SlotCapFor(subject.Groups, BookingLimits.MaxSlotsPerDay(settings));
        var minuteCap = GroupRules.MinuteCapFor(subject.Groups, BookingLimits.MaxMinutesPerDay(settings));
        if (slotCap <= 0 && minuteCap <= 0) return null;

        var (dayStart, dayEnd) = ClubClock.DayWindow(settings, day);

        var held = await _db.Bookings
            .Where(b => b.UserId == subject.UserId
                     && b.Status != BookingStatus.Cancelled
                     && b.StartsAt < dayEnd && b.EndsAt > dayStart)
            .Select(b => new { b.Id, b.SliceCount, b.StartsAt, b.EndsAt })
            .ToListAsync(ct);

        var bookedSlots = held.Sum(b => b.SliceCount);
        var bookedMinutes = (int)held.Sum(b => (b.EndsAt - b.StartsAt).TotalMinutes);
        var attemptedMinutes = (int)Math.Round((slot.EndsAt - slot.StartsAt).TotalMinutes);

        var overSlots = slotCap > 0 && bookedSlots + slot.SliceCount > slotCap;
        var overMinutes = minuteCap > 0 && bookedMinutes + attemptedMinutes > minuteCap;
        if (!overSlots && !overMinutes) return null;

        // Blueprint B.3, implemented rather than assumed. D2-B11: the code checked only the first
        // half — "the slot starts today" — and allowed UNCONDITIONALLY, so a member booked their
        // cap at 06:00 and the whole evening at 06:05 and the cap never once bit. The stated rule
        // has a second half ("and the slot is otherwise empty"), and a third that the window makes
        // honest: this is about filling a court that is about to go unused, not a blanket
        // exemption for the rest of the day.
        var relaxed = await RelaxedAsync(settings, slot, day, ct);
        if (relaxed) return null;

        return overSlots
            ? SlotRefusal(subject, settings, day, slotCap, bookedSlots, slot.SliceCount)
            : MinuteRefusal(subject, settings, day, minuteCap, bookedMinutes, attemptedMinutes);
    }

    /// <summary>
    /// GOAL item 19's refusal, with every figure its sentence needs.
    ///
    /// <para>
    /// Reported in preference to the minutes twin when both caps are exceeded — which on a
    /// default club is always, because four slots IS the sixty minutes blueprint A.4 already
    /// required. The slot one is what the member's screen is counting, so naming it is what makes
    /// the sentence and the screen agree.
    /// </para>
    /// </summary>
    private static BookingResult SlotRefusal(
        RuleSubject subject, TenantSettingsView settings, DateOnly day, int cap, int booked, int attempted)
    {
        var group = GroupRules.BoundBy(subject.Groups, BookingLimits.MaxSlotsPerDay(settings), g => g.MaxSlotsPerDay);
        return new BookingResult.PerDaySlotCapExceeded(
            cap, booked, attempted, Math.Max(cap - booked, 0),
            group?.Name, day.ToString("yyyy-MM-dd"), ClubClock.DayWindow(settings, day).End,
            RelaxationAvailable: settings.SameDayCapRelaxation && day == ClubClock.Today(settings));
    }

    /// <summary>Blueprint A.4's, which fires when the MINUTES cap alone binds — a member holding long bookings.</summary>
    private static BookingResult MinuteRefusal(
        RuleSubject subject, TenantSettingsView settings, DateOnly day, int cap, int booked, int attempted)
    {
        var group = GroupRules.BoundBy(subject.Groups, BookingLimits.MaxMinutesPerDay(settings), g => g.MaxMinutesPerDay);
        return new BookingResult.PerDayCapExceeded(cap, booked, attempted)
        {
            BoundByGroupName = group?.Name,
            ClubDay = day.ToString("yyyy-MM-dd"),
            ResetsAt = ClubClock.DayWindow(settings, day).End,
        };
    }

    /// <summary>
    /// Whether blueprint B.3's same-day relaxation actually applies to this slot.
    ///
    /// <para>
    /// All four conditions, not one: the club allows it, the slot is on today's club day, it
    /// starts within <c>same_day_relaxation_window_minutes</c>, and the court is free. A
    /// relaxation granted on this read and then lost to the exclusion constraint answers
    /// <c>slot_taken</c>, which is correct — the relaxation was conditional on the court being
    /// free and it was not.
    /// </para>
    /// </summary>
    private async Task<bool> RelaxedAsync(
        TenantSettingsView settings, RuleSlot slot, DateOnly day, CancellationToken ct)
    {
        if (!settings.SameDayCapRelaxation) return false;
        if (day != ClubClock.Today(settings)) return false;

        var minutesUntilStart = (slot.StartsAt - DateTimeOffset.UtcNow).TotalMinutes;
        if (minutesUntilStart < 0) return false;
        if (minutesUntilStart > BookingLimits.SameDayRelaxationWindowMinutes(settings)) return false;

        var taken = await _db.Bookings.AnyAsync(b =>
            b.CourtId == slot.CourtId
            && b.Status != BookingStatus.Cancelled
            && b.StartsAt < slot.EndsAt && b.EndsAt > slot.StartsAt, ct);

        return !taken;
    }

    /// <summary>The weekday vocabulary is <c>OperatingHours</c>' own — one spelling in the product.</summary>
    internal static string DayName(DayOfWeek day) => OperatingHours.DayKeys[(int)day];
}
