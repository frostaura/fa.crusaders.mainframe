using System.Globalization;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The play reads (<c>docs/specs/play.md</c> §6): a booking's result for its players, "My game",
/// a member's results, their celebrations, and the admin's lists and member summary. Everything
/// shown is derived here on read; nothing but badges and celebrations is stored.
///
/// <para>
/// <b>Private by construction.</b> Every <c>/me/play</c> read takes the caller's own id and no
/// other; the only read naming another member is the admin summary, and it is counts only.
/// </para>
/// </summary>
public sealed class PlayQuery
{
    public const int MaxCelebrations = 10;

    private readonly MainframeDbContext _db;
    private readonly TenantSettingsAccessor _settings;
    private readonly ResultService _results;

    public PlayQuery(MainframeDbContext db, TenantSettingsAccessor settings, ResultService results)
    {
        _db = db; _settings = settings; _results = results;
    }

    // ------------------------------------------------------------------ a booking's result

    /// <summary>
    /// <c>GET /bookings/{id}/result</c>: the live result (or the latest closed one), what the caller
    /// may do, and what the sheet pre-fills. Applies a due auto-confirmation first. Null for a
    /// non-player (404). <see cref="BookingResult.Changed"/> reports a confirmation this read applied.
    /// </summary>
    public async Task<BookingResult?> BookingResultAsync(Guid bookingId, Guid me, DateTimeOffset now, CancellationToken ct)
    {
        var booking = await _results.PlayerBookingAsync(bookingId, me, ct);
        if (booking is null) return null;

        var settings = await _settings.GetAsync(ct);
        var candidates = await Lineup.CandidatesAsync(_db, booking, ct);
        var result = await _results.CurrentAsync(bookingId, ct);
        var changed = false;
        if (result is not null) (result, changed) = await _results.SettleDueAsync(result, now, ct);

        var people = await ResultViews.PeopleAsync(
            _db, candidates.Where(c => c.UserId != null).Select(c => c.UserId!.Value).Concat(result is null ? [] : ResultViews.PeopleIn([result])), ct);
        var live = result is not null && MatchResultStatus.IsLive(result.Status);
        var reason = ResultService.NotRecordableReason(booking, candidates.Count, settings, now);
        var (a, b) = Lineup.DefaultSides(candidates);
        var body = new
        {
            booking_id = bookingId,
            timezone = DoorClock.ZoneOf(settings).Name,
            result = result is null ? null : ResultViews.Result(result, people, me),
            permissions = Permissions(result, me, !live && reason is null),
            not_recordable_reason = reason,
            record_closes_at = ResultService.RecordClosesAt(booking, settings),
            candidates = candidates.Select(c => ResultViews.Player(c, people)).ToList(),
            default_sides = new { a, b },
            default_format = MatchFormat.BestOf5,
        };
        return new BookingResult(body, changed, result is null ? [] : PlayNotices.MembersOf(result, null));
    }

    /// <summary>The read's body, and whether reading it confirmed a due result (so the caller evaluates its lineup).</summary>
    public sealed record BookingResult(object Body, bool Changed, IReadOnlyList<Guid> Lineup);

    private static object Permissions(MatchResult? r, Guid me, bool canRecord)
    {
        var submitting = r is null ? null : PlayNotices.SubmittingSide(r);
        var mySide = r?.Players.FirstOrDefault(p => p.UserId == me)?.Side;
        var onSubmitting = mySide is not null && mySide == submitting;
        var onConfirming = mySide is not null && mySide != submitting;
        var pending = r?.Status == MatchResultStatus.Pending;
        return new
        {
            can_record = canRecord,
            can_edit = pending && onSubmitting,
            can_confirm = pending && onConfirming,
            can_dispute = pending && onConfirming,
            can_withdraw = r?.Status is MatchResultStatus.Pending or MatchResultStatus.Disputed && onSubmitting,
        };
    }

    /// <summary>A result as an endpoint answers it: <c>result</c> for the caller.</summary>
    public async Task<object> ResultBodyAsync(MatchResult r, Guid viewer, CancellationToken ct)
    {
        var people = await ResultViews.PeopleAsync(_db, ResultViews.PeopleIn([r]), ct);
        return ResultViews.Result(r, people, viewer);
    }

    // ------------------------------------------------------------------ my results

    /// <summary>
    /// <c>GET /me/play/results</c>: the caller's confirmed, pending and disputed results, newest
    /// first (by when the match was recorded), each with its court and start.
    /// </summary>
    public async Task<object> MyResultsAsync(Guid me, string? cursor, int limit, CancellationToken ct)
    {
        var query = _db.MatchResults.AsNoTracking().Include(r => r.Players)
            .Where(r => MatchResultStatus.Live.Contains(r.Status) && r.Players.Any(p => p.UserId == me));
        if (PlayCursor.Parse(cursor) is { } after)
        {
            query = query.Where(r => r.CreatedAt < after.At || (r.CreatedAt == after.At && r.Id.CompareTo(after.Id) < 0));
        }
        var page = await query.OrderByDescending(r => r.CreatedAt).ThenByDescending(r => r.Id).Take(limit + 1).ToListAsync(ct);
        var items = await WithBookingsAsync(page.Take(limit).ToList(), me, ct);
        var next = page.Count > limit ? PlayCursor.Of(page[limit - 1].CreatedAt, page[limit - 1].Id) : null;
        var timezone = DoorClock.ZoneOf(await _settings.GetAsync(ct)).Name;
        return new { timezone, items, next_cursor = next };
    }

    /// <summary>Each result's view plus <c>court_name</c> and <c>starts_at</c> (and, for admins, the organiser).</summary>
    public async Task<List<Dictionary<string, object?>>> WithBookingsAsync(List<MatchResult> results, Guid? viewer, CancellationToken ct)
    {
        var bookingIds = results.Select(r => r.BookingId).Distinct().ToList();
        var bookings = await _db.Bookings.AsNoTracking().Where(b => bookingIds.Contains(b.Id))
            .Select(b => new { b.Id, b.StartsAt, b.UserId, Court = _db.Courts.Where(c => c.Id == b.CourtId).Select(c => c.Name).FirstOrDefault() })
            .ToDictionaryAsync(b => b.Id, ct);
        var organisers = viewer is null ? bookings.Values.Where(b => b.UserId != null).Select(b => b.UserId!.Value) : [];
        var people = await ResultViews.PeopleAsync(_db, ResultViews.PeopleIn(results).Concat(organisers), ct);

        var items = new List<Dictionary<string, object?>>();
        foreach (var r in results)
        {
            var view = ResultViews.Result(r, people, viewer);
            var b = bookings[r.BookingId];
            view["court_name"] = b.Court;
            view["starts_at"] = b.StartsAt;
            if (viewer is null) view["organiser"] = Organiser(b.UserId, people);
            items.Add(view);
        }
        return items;
    }

    private static object? Organiser(Guid? userId, IReadOnlyDictionary<Guid, PlayPerson> people)
    {
        if (userId is not { } id) return null;
        return new { user_id = id, name = people.TryGetValue(id, out var p) ? p.Name : null };
    }

    // ------------------------------------------------------------------ celebrations

    /// <summary><c>GET /me/play/celebrations</c>: unseen only, oldest first, at most ten.</summary>
    public async Task<object> CelebrationsAsync(Guid me, CancellationToken ct)
    {
        var rows = await _db.PlayCelebrations.AsNoTracking()
            .Where(c => c.UserId == me && c.SeenAt == null)
            .OrderBy(c => c.CreatedAt).ThenBy(c => c.Id).Take(MaxCelebrations).ToListAsync(ct);
        var goal = await _db.MemberPlayProfiles.AsNoTracking().Where(p => p.UserId == me).Select(p => p.MonthlyGoalMinutes).FirstOrDefaultAsync(ct);
        var timezone = DoorClock.ZoneOf(await _settings.GetAsync(ct)).Name;
        return new { timezone, items = rows.Select(c => CelebrationView(c, goal)).ToList() };
    }

    private static object CelebrationView(PlayCelebration c, int? goal)
    {
        var badge = c.BadgeKey is { } key ? BadgeCatalogue.Find(key) : null;
        return new
        {
            id = c.Id,
            kind = c.Kind,
            badge = badge is null ? null : new { key = badge.Key, name = badge.Name, description = badge.Description },
            month = c.Month,
            goal_minutes = c.Kind == CelebrationKind.GoalReached ? goal : null,
            created_at = c.CreatedAt,
        };
    }

    // ------------------------------------------------------------------ my game

    /// <summary><c>GET /me/play</c>: the whole section in one read (§6.2).</summary>
    public async Task<object> MyGameAsync(Guid me, DateTimeOffset now, CancellationToken ct)
    {
        var settings = await _settings.GetAsync(ct);
        var record = await PlayRecord.LoadAsync(_db, settings, me, now, ct);
        var stats = record.Stats;
        var badges = await _db.MemberBadges.AsNoTracking().Where(b => b.UserId == me).ToDictionaryAsync(b => b.BadgeKey, ct);
        var people = await ResultViews.PeopleAsync(
            _db, stats.Partners.Select(p => p.UserId).Concat(stats.Opponents.Select(o => o.UserId)), ct);

        return new
        {
            as_of = now,
            timezone = DoorClock.ZoneOf(settings).Name,
            settings = SettingsView(record.Profile),
            ring = Ring(record),
            streak = Streak(record),
            pause = PauseView(record),
            stats = new
            {
                sessions_attended = stats.SessionsAttended,
                minutes_on_court = stats.MinutesOnCourt,
                minutes_this_year = stats.MinutesThisYear,
                matches_played = stats.MatchesPlayed,
                matches_won = stats.MatchesWon,
                matches_lost = stats.MatchesLost,
                games_won = stats.GamesWon,
                games_lost = stats.GamesLost,
                win_rate_percent = stats.WinRatePercent,
            },
            partners = stats.Partners.Select(p => PersonView(p.UserId, people, new { sessions = p.Sessions })).ToList(),
            opponents = stats.Opponents.Select(o => PersonView(o.UserId, people, new { matches = o.Matches, won = o.Won, lost = o.Lost })).ToList(),
            form = stats.Form.Select(f => new { result_id = f.ResultId, booking_id = f.BookingId, starts_at = f.StartsAt, outcome = f.Won ? "won" : "lost" }).ToList(),
            badges = BadgesView(record, badges),
        };
    }

    public static object SettingsView(MemberPlayProfile? profile)
    {
        return new
        {
            monthly_goal_minutes = profile?.MonthlyGoalMinutes,
            celebrations_enabled = profile?.CelebrationsEnabled ?? true,
        };
    }

    private static object? Ring(PlayRecord record)
    {
        if (record.Profile?.MonthlyGoalMinutes is not { } goal) return null;
        var (minutes, sessions) = PlayStats.Month(record.Sessions, record.Zone, record.CurrentMonth);
        return new { month = record.CurrentMonth, goal_minutes = goal, attended_minutes = minutes, sessions, reached = minutes >= goal };
    }

    private static object Streak(PlayRecord record)
    {
        var strip = StreakMath.Strip(record.Walk, record.Coverage.Paused, record.CurrentWeek);
        return new
        {
            current_weeks = record.Walk.State.Streak,
            longest_weeks = record.Walk.State.Longest,
            rest_weeks_banked = record.Walk.State.Bank,
            rest_every_weeks = record.Rules.RestEveryWeeks,
            rest_cap = record.Rules.RestCap,
            this_week = strip[^1].State,
            weeks = strip.Select(w => new { week_start = w.Week.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), state = w.State }).ToList(),
        };
    }

    public static object PauseView(PlayRecord record)
    {
        var open = record.Pauses.FirstOrDefault(p => p.EndedAt == null);
        return new
        {
            active = open is not null,
            started_at = open?.StartedAt,
            weeks_used_this_year = record.Coverage.UsedIn(ClubWeek.YearOf(record.CurrentWeek)),
            weeks_per_year = record.Rules.PauseWeeksPerYear,
        };
    }

    private static List<object> BadgesView(PlayRecord record, Dictionary<string, MemberBadge> earned)
    {
        var sessions = record.Sessions.Count;
        var partners = BadgeRules.DistinctPartners(record.Sessions);
        var current = record.Walk.State.Streak;
        return BadgeCatalogue.All.Select(b =>
        {
            var got = earned.TryGetValue(b.Key, out var row) ? row : null;
            var value = BadgeRules.ProgressValue(b.Key, sessions, partners, current);
            return (object)new
            {
                key = b.Key,
                name = b.Name,
                description = b.Description,
                earned = got is not null,
                awarded_at = got?.AwardedAt,
                progress = got is null && value is { } v && b.Target is { } t ? new { value = Math.Min(v, t), target = t } : null,
            };
        }).ToList();
    }

    private static object PersonView(Guid userId, IReadOnlyDictionary<Guid, PlayPerson> people, object figures)
    {
        var p = people.TryGetValue(userId, out var found) ? found : null;
        var view = new Dictionary<string, object?> { ["user_id"] = userId, ["name"] = p?.Name, ["photo_url"] = p?.PhotoUrl };
        foreach (var prop in figures.GetType().GetProperties()) view[prop.Name] = prop.GetValue(figures);
        return view;
    }

    // ------------------------------------------------------------------ admin

    /// <summary>
    /// <c>GET /admin/play/results</c>: one status (disputed by default) or all; disputed oldest
    /// first by when it was disputed, everything else newest first; with the club-wide count.
    /// </summary>
    public async Task<object> AdminResultsAsync(string status, string? cursor, int limit, CancellationToken ct)
    {
        var query = _db.MatchResults.AsNoTracking().Include(r => r.Players).AsQueryable();
        if (status != "all") query = query.Where(r => r.Status == status);
        var count = await query.CountAsync(ct);
        var after = PlayCursor.Parse(cursor);
        List<MatchResult> page;
        if (status == MatchResultStatus.Disputed)
        {
            if (after is { } a) query = query.Where(r => r.DisputedAt > a.At || (r.DisputedAt == a.At && r.Id.CompareTo(a.Id) > 0));
            page = await query.OrderBy(r => r.DisputedAt).ThenBy(r => r.Id).Take(limit + 1).ToListAsync(ct);
        }
        else
        {
            if (after is { } a) query = query.Where(r => r.CreatedAt < a.At || (r.CreatedAt == a.At && r.Id.CompareTo(a.Id) < 0));
            page = await query.OrderByDescending(r => r.CreatedAt).ThenByDescending(r => r.Id).Take(limit + 1).ToListAsync(ct);
        }
        var items = await WithBookingsAsync(page.Take(limit).ToList(), null, ct);
        string? next = null;
        if (page.Count > limit)
        {
            var last = page[limit - 1];
            next = PlayCursor.Of(status == MatchResultStatus.Disputed ? last.DisputedAt ?? last.CreatedAt : last.CreatedAt, last.Id);
        }
        return new { items, next_cursor = next, count };
    }

    /// <summary>One result as the admin routes answer it: <c>admin_result</c>.</summary>
    public async Task<object> AdminResultAsync(MatchResult r, CancellationToken ct) =>
        (await WithBookingsAsync([r], null, ct))[0];

    /// <summary>
    /// <c>GET /admin/members/{id}/play</c>: counts only — no partners, no opponents, no results list,
    /// no badge list (§6.3). Null when the member is not this club's.
    /// </summary>
    public async Task<object?> AdminMemberAsync(Guid userId, DateTimeOffset now, CancellationToken ct)
    {
        if (!await _db.Users.AsNoTracking().AnyAsync(u => u.Id == userId, ct)) return null;
        var settings = await _settings.GetAsync(ct);
        var record = await PlayRecord.LoadAsync(_db, settings, userId, now, ct);
        var stats = record.Stats;
        var (month, _) = PlayStats.Month(record.Sessions, record.Zone, record.CurrentMonth);
        var disputes = await _db.MatchResults.AsNoTracking()
            .CountAsync(r => r.Status == MatchResultStatus.Disputed && r.Players.Any(p => p.UserId == userId), ct);
        var badges = await _db.MemberBadges.AsNoTracking().CountAsync(b => b.UserId == userId, ct);
        return new
        {
            sessions_attended = stats.SessionsAttended,
            minutes_this_month = month,
            minutes_all_time = stats.MinutesOnCourt,
            current_streak_weeks = record.Walk.State.Streak,
            matches_played = stats.MatchesPlayed,
            matches_won = stats.MatchesWon,
            matches_lost = stats.MatchesLost,
            open_disputes = disputes,
            badges_earned = badges,
        };
    }
}

/// <summary>An opaque keyset cursor: an instant and an id.</summary>
public static class PlayCursor
{
    public static string Of(DateTimeOffset at, Guid id) =>
        Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes($"{at.UtcTicks}:{id:N}")).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    public static (DateTimeOffset At, Guid Id)? Parse(string? cursor)
    {
        if (string.IsNullOrWhiteSpace(cursor) || cursor.Length > 64) return null;
        try
        {
            var padded = cursor.Replace('-', '+').Replace('_', '/');
            padded += new string('=', (4 - (padded.Length % 4)) % 4);
            var parts = System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(padded)).Split(':');
            if (parts.Length != 2 || !long.TryParse(parts[0], out var ticks) || !Guid.TryParse(parts[1], out var id)) return null;
            return (new DateTimeOffset(ticks, TimeSpan.Zero), id);
        }
        catch (FormatException)
        {
            return null;
        }
    }
}
