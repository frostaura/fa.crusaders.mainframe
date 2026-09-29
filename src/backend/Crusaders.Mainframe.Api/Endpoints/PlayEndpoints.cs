using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Services.Realtime;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// D14 — a member's play: the result on a booking they played, and "My game" (stats, streak,
/// pause, ring, badges, celebrations). The rules are in <see cref="ResultService"/>,
/// <see cref="PlayQuery"/> and <see cref="PlayEvaluator"/>; this file is routes. The catalogue is
/// <c>docs/specs/play.md</c> §6.
///
/// <para>
/// <b>Requests camelCase, answers snake_case</b>; every refusal is <c>{ error, …figures }</c>. A
/// booking of another club, or one the caller is not a player of, is 404 — never 403 — so an id
/// reveals nothing. Every <c>/me/play</c> route reads the caller and nobody else.
/// </para>
/// </summary>
public static class PlayEndpoints
{
    public const int DefaultResultsLimit = 20;
    public const int MaxResultsLimit = 50;
    public const int MaxSeenIds = 50;
    public const int MinGoalMinutes = 30;
    public const int MaxGoalMinutes = 6000;
    public const int GoalStepMinutes = 15;

    public static IEndpointRouteBuilder MapPlayEndpoints(this IEndpointRouteBuilder app)
    {
        var reads = app.MapGroup("/api/v1").RequireAuthorization();
        reads.MapGet("/bookings/{bookingId:guid}/result", BookingResultAsync);
        reads.MapGet("/me/play", MyGameAsync);
        reads.MapGet("/me/play/results", MyResultsAsync);
        reads.MapGet("/me/play/celebrations", CelebrationsAsync);

        var writes = app.MapGroup("/api/v1").RequireAuthorization().RequireRateLimiting(RateLimitPolicies.Auth);
        writes.MapPost("/bookings/{bookingId:guid}/result", RecordAsync);
        writes.MapPut("/bookings/{bookingId:guid}/result", EditAsync);
        writes.MapPost("/bookings/{bookingId:guid}/result/confirm", ConfirmAsync);
        writes.MapPost("/bookings/{bookingId:guid}/result/dispute", DisputeAsync);
        writes.MapPost("/bookings/{bookingId:guid}/result/withdraw", WithdrawAsync);
        writes.MapPut("/me/play/settings", SettingsAsync);
        writes.MapPost("/me/play/pause", PauseAsync);
        writes.MapDelete("/me/play/pause", UnpauseAsync);
        writes.MapPost("/me/play/celebrations/seen", SeenAsync);
        return app;
    }

    // ------------------------------------------------------------------ results on a booking

    private static async Task<IResult> BookingResultAsync(Guid bookingId, HttpContext ctx, PlayQuery query, CancellationToken ct)
    {
        var read = await query.BookingResultAsync(bookingId, Me(ctx), DateTimeOffset.UtcNow, ct);
        if (read is null) return Results.NotFound(new { error = ResultErrors.BookingNotFound });
        if (read.Changed) await AfterAsync(ctx, read.Lineup);
        return Results.Ok(read.Body);
    }

    private static async Task<IResult> RecordAsync(Guid bookingId, ResultRequest req, HttpContext ctx, [AsParameters] ResultDeps deps, CancellationToken ct) =>
        await AnswerAsync(ctx, deps, await deps.Results.RecordAsync(bookingId, Me(ctx), req, DateTimeOffset.UtcNow, ct), ct);

    private static async Task<IResult> EditAsync(Guid bookingId, ResultRequest req, HttpContext ctx, [AsParameters] ResultDeps deps, CancellationToken ct) =>
        await AnswerAsync(ctx, deps, await deps.Results.EditAsync(bookingId, Me(ctx), req, DateTimeOffset.UtcNow, ct), ct);

    private static async Task<IResult> ConfirmAsync(
        Guid bookingId, ResultActionRequest? req, HttpContext ctx, [AsParameters] ResultDeps deps, CancellationToken ct) =>
        await AnswerAsync(ctx, deps, await deps.Results.ConfirmAsync(bookingId, Me(ctx), req?.ExpectedVersion, DateTimeOffset.UtcNow, ct), ct);

    private static async Task<IResult> DisputeAsync(
        Guid bookingId, ResultActionRequest? req, HttpContext ctx, [AsParameters] ResultDeps deps, CancellationToken ct) =>
        await AnswerAsync(ctx, deps, await deps.Results.DisputeAsync(bookingId, Me(ctx), req ?? new ResultActionRequest(), DateTimeOffset.UtcNow, ct), ct);

    private static async Task<IResult> WithdrawAsync(
        Guid bookingId, ResultActionRequest? req, HttpContext ctx, [AsParameters] ResultDeps deps, CancellationToken ct) =>
        await AnswerAsync(ctx, deps, await deps.Results.WithdrawAsync(bookingId, Me(ctx), req?.ExpectedVersion, DateTimeOffset.UtcNow, ct), ct);

    /// <summary>The results routes' services, bound as one parameter for the complexity gate.</summary>
    public sealed record ResultDeps(ResultService Results, PlayQuery Query, MainframeDbContext Db, IRealtimeBus Bus);

    /// <summary>
    /// A results answer as HTTP: the <c>result</c> for the caller, or <c>{ error, …figures }</c>.
    /// After a change: the inbox badges of everybody in the lineup, then the hook.
    /// </summary>
    private static async Task<IResult> AnswerAsync(HttpContext ctx, ResultDeps deps, ResultOutcome outcome, CancellationToken ct)
    {
        if (outcome.Changed && outcome.Affected is { Count: > 0 } affected)
        {
            var tenant = ctx.RequestServices.GetRequiredService<ITenantContext>();
            await MemberNotices.PublishUnreadAsync(deps.Db, deps.Bus, tenant.TenantId, affected, CancellationToken.None);
            await AfterAsync(ctx, affected);
        }
        if (!outcome.IsOk) return Refusal(outcome);
        return Results.Json(await deps.Query.ResultBodyAsync(outcome.Result!, Me(ctx), ct), statusCode: outcome.StatusCode);
    }

    // ------------------------------------------------------------------ my game

    private static async Task<IResult> MyGameAsync(HttpContext ctx, PlayQuery query, CancellationToken ct)
    {
        return Results.Ok(await query.MyGameAsync(Me(ctx), DateTimeOffset.UtcNow, ct));
    }

    private static async Task<IResult> MyResultsAsync(string? cursor, int? limit, HttpContext ctx, PlayQuery query, CancellationToken ct)
    {
        var take = limit ?? DefaultResultsLimit;
        if (take is < 1 or > MaxResultsLimit) return Results.BadRequest(new { error = "limit_invalid", min = 1, max = MaxResultsLimit });
        return Results.Ok(await query.MyResultsAsync(Me(ctx), cursor, take, ct));
    }

    private static async Task<IResult> CelebrationsAsync(HttpContext ctx, PlayQuery query, CancellationToken ct)
    {
        return Results.Ok(await query.CelebrationsAsync(Me(ctx), ct));
    }

    /// <summary>
    /// <c>PUT /me/play/settings</c>: an absent field is unchanged; a <c>null</c> goal removes it.
    /// Setting a goal the month has already reached records that month's celebration as seen, so
    /// a goal cannot be set to celebrate itself (§5.5).
    /// </summary>
    private static async Task<IResult> SettingsAsync(JsonElement body, HttpContext ctx, [AsParameters] MeDeps deps, CancellationToken ct)
    {
        var parsed = PlaySettingsBody.Parse(body);
        if (parsed.Error is { } error) return Results.BadRequest(error);

        var me = Me(ctx);
        var now = DateTimeOffset.UtcNow;
        var profile = await ProfileAsync(deps, me, now, ct);
        if (parsed.GoalSet) profile.MonthlyGoalMinutes = parsed.Goal;
        if (parsed.Celebrations is { } on) profile.CelebrationsEnabled = on;
        profile.UpdatedAt = now.Storable();

        await using (var tx = await deps.Db.Database.BeginTransactionAsync(ct))
        {
            await deps.Db.SaveChangesAsync(ct);
            await MarkReachedGoalSeenAsync(deps, profile, now, ct);
            await tx.CommitAsync(ct);
        }
        await AfterAsync(ctx, [me]);
        return Results.Ok(PlayQuery.SettingsView(profile));
    }

    /// <summary>The member's profile, tracked — created on the first write (§2.5).</summary>
    private static async Task<MemberPlayProfile> ProfileAsync(MeDeps deps, Guid me, DateTimeOffset now, CancellationToken ct)
    {
        var profile = await deps.Db.MemberPlayProfiles.FirstOrDefaultAsync(p => p.UserId == me, ct);
        if (profile is not null) return profile;
        try
        {
            deps.Db.MemberPlayProfiles.Add(new MemberPlayProfile
            {
                TenantId = deps.Tenant.TenantId,
                UserId = me,
                CreatedAt = now.Storable(),
                UpdatedAt = now.Storable(),
            });
            await deps.Db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException)
        {
            // The evaluator (or a double tap) created it first; the index kept one.
            deps.Db.ChangeTracker.Clear();
        }
        return await deps.Db.MemberPlayProfiles.FirstAsync(p => p.UserId == me, ct);
    }

    private static async Task MarkReachedGoalSeenAsync(MeDeps deps, MemberPlayProfile profile, DateTimeOffset now, CancellationToken ct)
    {
        if (profile.MonthlyGoalMinutes is not { } goal) return;
        var settings = await deps.Settings.GetAsync(ct);
        var zone = ClubClock.ZoneOf(settings);
        var month = ClubWeek.MonthOf(zone, now);
        var sessions = await AttendanceQuery.SessionsAsync(deps.Db, profile.UserId, ct);
        if (PlayStats.Month(sessions, zone, month).Minutes < goal) return;
        await deps.Evaluator.CelebrateAsync(
            new PlayEvaluator.Moment(profile.UserId, CelebrationKind.GoalReached, $"goal:{month}", null, month), false, now.Storable(), ct);
    }

    /// <summary>The "My game" writes' services, bound as one parameter for the complexity gate.</summary>
    public sealed record MeDeps(MainframeDbContext Db, ITenantContext Tenant, TenantSettingsAccessor Settings, PlayEvaluator Evaluator);

    /// <summary>
    /// <c>POST /me/play/pause</c>: on from the current club week — never backwards. Refused while
    /// one is on, and when this club year's allowance is used up (or pausing is off).
    /// </summary>
    private static async Task<IResult> PauseAsync(HttpContext ctx, [AsParameters] MeDeps deps, CancellationToken ct)
    {
        var me = Me(ctx);
        var now = DateTimeOffset.UtcNow;
        var settings = await deps.Settings.GetAsync(ct);
        var record = await PlayRecord.LoadAsync(deps.Db, settings, me, now, ct);
        if (record.Pauses.Any(p => p.EndedAt == null)) return Results.Conflict(new { error = "pause_active" });
        var allowance = record.Rules.PauseWeeksPerYear;
        if (allowance == 0 || record.Coverage.UsedIn(ClubWeek.YearOf(record.CurrentWeek)) >= allowance)
        {
            return Results.Conflict(new { error = "pause_allowance_used", weeks_per_year = allowance });
        }

        deps.Db.MemberStreakPauses.Add(new MemberStreakPause
        {
            TenantId = deps.Tenant.TenantId,
            UserId = me,
            StartedAt = now.Storable(),
            CreatedAt = now.Storable(),
        });
        try
        {
            await deps.Db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException)
        {
            return Results.Conflict(new { error = "pause_active" });
        }
        return Results.Ok(PlayQuery.PauseView(await PlayRecord.LoadAsync(deps.Db, settings, me, now, ct)));
    }

    private static async Task<IResult> UnpauseAsync(HttpContext ctx, [AsParameters] MeDeps deps, CancellationToken ct)
    {
        var me = Me(ctx);
        var now = DateTimeOffset.UtcNow;
        var open = await deps.Db.MemberStreakPauses.FirstOrDefaultAsync(p => p.UserId == me && p.EndedAt == null, ct);
        if (open is null) return Results.Conflict(new { error = "pause_not_active" });
        open.EndedAt = now.Storable();
        await deps.Db.SaveChangesAsync(ct);
        var settings = await deps.Settings.GetAsync(ct);
        return Results.Ok(PlayQuery.PauseView(await PlayRecord.LoadAsync(deps.Db, settings, me, now, ct)));
    }

    /// <summary>
    /// <c>POST /me/play/celebrations/seen</c>: idempotent; ids that are not the caller's are
    /// ignored, never an error — they are not theirs to learn about.
    /// </summary>
    private static async Task<IResult> SeenAsync(SeenRequest req, HttpContext ctx, MainframeDbContext db, CancellationToken ct)
    {
        var ids = req.Ids ?? [];
        if (ids.Count is < 1 or > MaxSeenIds) return Results.BadRequest(new { error = "ids_invalid", min = 1, max = MaxSeenIds });
        var me = Me(ctx);
        var at = StorableTime.UtcNow;
        var seen = await db.PlayCelebrations
            .Where(c => c.UserId == me && ids.Contains(c.Id) && c.SeenAt == null)
            .ExecuteUpdateAsync(u => u.SetProperty(c => c.SeenAt, at), ct);
        return Results.Ok(new { seen });
    }

    // ------------------------------------------------------------------ plumbing

    private static Guid Me(HttpContext ctx) => ctx.User.Id() ?? Guid.Empty;

    private static Task AfterAsync(HttpContext ctx, IEnumerable<Guid> members) => ctx.AfterPlayAsync(members);

    /// <summary><c>{ error, …figures }</c>, the figures folded in beside the code.</summary>
    internal static IResult Refusal(ResultOutcome outcome)
    {
        var body = new Dictionary<string, object?> { ["error"] = outcome.Error };
        if (outcome.Figures is not null)
        {
            foreach (var p in JsonSerializer.SerializeToElement(outcome.Figures).EnumerateObject()) body[p.Name] = p.Value;
        }
        return Results.Json(body, statusCode: outcome.StatusCode);
    }
}

/// <summary>The celebrations a member acknowledged.</summary>
public sealed record SeenRequest(IReadOnlyList<Guid>? Ids = null);

/// <summary>
/// <c>PUT /me/play/settings</c>'s body, read raw because "absent" and "null" mean different things
/// for the goal: absent leaves it, null removes it.
/// </summary>
public sealed record PlaySettingsBody(bool GoalSet, int? Goal, bool? Celebrations, object? Error)
{
    public static PlaySettingsBody Parse(JsonElement body)
    {
        var goalError = new
        {
            error = "goal_out_of_range",
            min = PlayEndpoints.MinGoalMinutes,
            max = PlayEndpoints.MaxGoalMinutes,
            step = PlayEndpoints.GoalStepMinutes,
        };
        if (body.ValueKind != JsonValueKind.Object) return new(false, null, null, new { error = "settings_invalid" });

        bool? celebrations = null;
        if (body.TryGetProperty("celebrationsEnabled", out var c))
        {
            if (c.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) return new(false, null, null, new { error = "settings_invalid" });
            celebrations = c.GetBoolean();
        }

        if (!body.TryGetProperty("monthlyGoalMinutes", out var g)) return new(false, null, celebrations, null);
        if (g.ValueKind == JsonValueKind.Null) return new(true, null, celebrations, null);
        if (g.ValueKind != JsonValueKind.Number || !g.TryGetInt32(out var goal) || !ValidGoal(goal)) return new(false, null, null, goalError);
        return new(true, goal, celebrations, null);
    }

    private static bool ValidGoal(int goal) =>
        goal is >= PlayEndpoints.MinGoalMinutes and <= PlayEndpoints.MaxGoalMinutes && goal % PlayEndpoints.GoalStepMinutes == 0;
}
