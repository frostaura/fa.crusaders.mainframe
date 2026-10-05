using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// Everything one member's play record is derived from, loaded once (<c>docs/specs/play.md</c> §5):
/// sessions, confirmed results, pauses, the profile and the club's rules — and the streak walked
/// over them. Read by <see cref="PlayQuery"/> (the member's own page, the admin summary) and by
/// <see cref="PlayEvaluator"/> (badges), so the figures a member sees and the badges they are
/// awarded come from one derivation.
/// </summary>
public sealed record PlayRecord(
    Guid UserId, DateTimeOffset Now, TenantSettingsView Settings, TimeZoneInfo Zone, StreakRules Rules,
    IReadOnlyList<AttendedSession> Sessions, IReadOnlyList<MemberResult> Results, IReadOnlyList<MemberStreakPause> Pauses,
    MemberPlayProfile? Profile, DateOnly CurrentWeek, IReadOnlySet<DateOnly> AttendedWeeks, PauseCoverage Coverage, StreakWalk Walk)
{
    /// <summary>The club-local month <see cref="Now"/> falls in, <c>yyyy-MM</c>.</summary>
    public string CurrentMonth => ClubWeek.MonthOf(Zone, Now);

    /// <summary>
    /// Loads and derives one member's record at <paramref name="now"/>. Tenant-scoped by the
    /// context's query filters; a member with nothing reads as zeros and empty lists.
    /// </summary>
    public static async Task<PlayRecord> LoadAsync(
        MainframeDbContext db, TenantSettingsView settings, Guid userId, DateTimeOffset now, CancellationToken ct)
    {
        var zone = ClubClock.ZoneOf(settings);
        var rules = PlaySettings.StreakRulesOf(settings);
        // Review round 2, B-11: a session counts from its court time, not the scan — a check-in at
        // 06:24 for a 06:30 court awarded "First court" and "Early bird" six minutes before a ball
        // was hit. Not yet started is not yet attended; the check-in's recompute marker is staged
        // for the court's start (MainframeDbContext.PlayStaging), which is when this runs again.
        var sessions = (await AttendanceQuery.SessionsAsync(db, userId, ct)).Where(s => s.StartsAt <= now).ToList();
        var results = await ConfirmedResultsAsync(db, userId, ct);
        var pauses = await db.MemberStreakPauses.AsNoTracking().Where(p => p.UserId == userId).OrderBy(p => p.StartedAt).ToListAsync(ct);
        var profile = await db.MemberPlayProfiles.AsNoTracking().FirstOrDefaultAsync(p => p.UserId == userId, ct);

        var current = ClubWeek.KeyOf(zone, now);
        var attended = sessions.Select(s => ClubWeek.KeyOf(zone, s.StartsAt)).ToHashSet();
        var coverage = StreakMath.PausedWeeks(
            pauses.Select(p => (ClubWeek.KeyOf(zone, p.StartedAt), p.EndedAt is { } e ? ClubWeek.KeyOf(zone, e) : (DateOnly?)null)),
            attended, current, rules.PauseWeeksPerYear);
        var walk = StreakMath.Walk(attended, coverage.Paused, current, rules);
        return new PlayRecord(userId, now, settings, zone, rules, sessions, results, pauses, profile, current, attended, coverage, walk);
    }

    /// <summary>Every confirmed result with <paramref name="userId"/> in the lineup, from their side.</summary>
    public static async Task<List<MemberResult>> ConfirmedResultsAsync(MainframeDbContext db, Guid userId, CancellationToken ct)
    {
        var rows = await db.MatchResults.AsNoTracking().Include(r => r.Players)
            .Where(r => r.Status == MatchResultStatus.Confirmed && r.Players.Any(p => p.UserId == userId))
            .ToListAsync(ct);
        var ids = rows.Select(r => r.BookingId).Distinct().ToList();
        var starts = await db.Bookings.AsNoTracking().Where(b => ids.Contains(b.Id)).ToDictionaryAsync(b => b.Id, b => b.StartsAt, ct);
        return rows.Select(r => PlayStats.FromSide(r, starts[r.BookingId], userId)).OfType<MemberResult>().ToList();
    }

    /// <summary>The figures of §5.1, derived.</summary>
    public PersonalStats Stats => PlayStats.Compute(Sessions, Results, Zone, Now);

    /// <summary>
    /// The badge inputs, with the club's two time-of-day thresholds — R16 E16-9: only sessions that
    /// have ended and that the club did not cancel (<see cref="AttendedSession.EarnsBadgesAt"/>).
    /// </summary>
    public BadgeInputs BadgeInputs => new(
        [.. Sessions.Where(s => s.EarnsBadgesAt(Now))], Results, Walk, Zone,
        PlaySettings.EarlyBirdBeforeMinute(Settings), PlaySettings.NightOwlFromMinute(Settings));
}
