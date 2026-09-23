using System.Text.Json;
using System.Text.Json.Serialization;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// The signed-in person's own preferences and onboarding progress.
///
/// <para>
/// <b>Everything here is keyed on the caller's own token.</b> There is no user id in any route
/// or body, so there is nothing a member could change to read or write somebody else's row —
/// the same construction <c>GET /me/profile</c> relies on.
/// </para>
///
/// <para>
/// <b>Onboarding has routes of its own rather than fields on the PUT.</b> "Completed" and
/// "dismissed" are events the server stamps with its own clock; accepting a client-supplied
/// instant would let a device with a wrong clock record a completion in the future, and a
/// boolean on the PUT could not say when.
/// </para>
/// </summary>
public static class MePreferencesEndpoints
{
    public static IEndpointRouteBuilder MapMePreferencesEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/v1/me").RequireAuthorization();

        g.MapGet("/preferences", async (HttpContext ctx, UserPreferencesService prefs, CancellationToken ct) =>
        {
            var userId = ctx.User.Id() ?? Guid.Empty;
            return Results.Ok(await prefs.GetAsync(userId, ct));
        });

        g.MapPut("/preferences", async (
            UpdatePreferencesRequest req, HttpContext ctx, UserPreferencesService prefs, CancellationToken ct) =>
        {
            var (patch, error) = PreferencesPatch.From(req);
            if (error is not null) return error;
            return Answer(await prefs.UpdateAsync(ctx.User.Id() ?? Guid.Empty, patch!.ApplyTo, ct));
        });

        g.MapPost("/onboarding/member/complete", async (HttpContext ctx, UserPreferencesService prefs, CancellationToken ct) =>
            Answer(await prefs.UpdateAsync(ctx.User.Id() ?? Guid.Empty, CompleteMember, ct)));

        g.MapPost("/onboarding/member/dismiss", async (HttpContext ctx, UserPreferencesService prefs, CancellationToken ct) =>
            Answer(await prefs.UpdateAsync(ctx.User.Id() ?? Guid.Empty, p => p.MemberOnboardingDismissedAt = StorableTime.UtcNow, ct)));

        g.MapPut("/onboarding/member/step", async (
            OnboardingStepRequest req, HttpContext ctx, UserPreferencesService prefs, CancellationToken ct) =>
        {
            var step = UserPreferencesRules.NormaliseStep(req.Step);
            if (step is null)
            {
                return Results.BadRequest(new { error = UserPreferencesRules.InvalidStep, max_length = UserPreferencesRules.MaxStepLength });
            }
            return Answer(await prefs.UpdateAsync(ctx.User.Id() ?? Guid.Empty, p => p.MemberOnboardingLastStep = step, ct));
        });

        // Admin-only, and checked here rather than by a role policy on the route: the group is
        // the member's own, and a 403 for a member is the honest answer — they have no admin tour
        // to complete. The role is the LIVE one (see LiveAdminRole), so a demoted admin's
        // still-valid token is refused as well.
        g.MapPost("/onboarding/admin/complete", async (HttpContext ctx, UserPreferencesService prefs, CancellationToken ct) =>
        {
            if (!ctx.User.IsInRole("admin")) return Results.Json(new { error = "admin_only" }, statusCode: StatusCodes.Status403Forbidden);
            return Answer(await prefs.UpdateAsync(ctx.User.Id() ?? Guid.Empty, CompleteAdmin, ct));
        });

        return app;
    }

    /// <summary>
    /// Completing the current tour. Stamps the version, so a later tour can tell a member who
    /// finished an older one from one who finished this one; and leaves a dismissal in place,
    /// because "they said not now, then did it anyway" is still true history.
    /// </summary>
    private static void CompleteMember(UserPreferences p)
    {
        p.MemberOnboardingCompletedAt = StorableTime.UtcNow;
        p.OnboardingVersion = UserPreferences.CurrentOnboardingVersion;
    }

    private static void CompleteAdmin(UserPreferences p)
    {
        p.AdminOnboardingCompletedAt = StorableTime.UtcNow;
        p.OnboardingVersion = UserPreferences.CurrentOnboardingVersion;
    }

    /// <summary>
    /// A null view means the caller's user id is not a user of the resolved club — a token that
    /// outlived its account, or one minted for another tenant. 404, never a created row.
    /// </summary>
    private static IResult Answer(UserPreferencesView? view)
    {
        return view is null ? Results.NotFound(new { error = "user_not_found" }) : Results.Ok(view);
    }
}

/// <summary>
/// A partial update: every field is optional, and an absent or null field is left alone.
/// Onboarding stamps are not here on purpose — see <see cref="MePreferencesEndpoints"/>.
/// </summary>
public sealed class UpdatePreferencesRequest
{
    [JsonPropertyName("theme")] public string? Theme { get; init; }
    [JsonPropertyName("findable")] public bool? Findable { get; init; }
    [JsonPropertyName("show_in_leaderboards")] public bool? ShowInLeaderboards { get; init; }
    [JsonPropertyName("rating_opt_in")] public bool? RatingOptIn { get; init; }
    [JsonPropertyName("weekly_recap")] public bool? WeeklyRecap { get; init; }
    [JsonPropertyName("admin_notification_optouts")] public List<string?>? AdminNotificationOptouts { get; init; }
}

public sealed class OnboardingStepRequest
{
    [JsonPropertyName("step")] public string? Step { get; init; }
}

/// <summary>
/// A validated <see cref="UpdatePreferencesRequest"/>. Validation happens in full BEFORE the
/// row is touched, so a request that is half valid changes nothing rather than half of what it
/// asked for.
/// </summary>
internal sealed class PreferencesPatch
{
    private UpdatePreferencesRequest _req = new();
    private string? _theme;
    private string? _optoutsJson;

    public static (PreferencesPatch? Patch, IResult? Error) From(UpdatePreferencesRequest req)
    {
        var patch = new PreferencesPatch { _req = req };

        if (req.Theme is not null)
        {
            patch._theme = UserPreferencesRules.NormaliseTheme(req.Theme);
            if (patch._theme is null)
            {
                return (null, Results.BadRequest(new { error = UserPreferencesRules.InvalidTheme, allowed = UserPreferences.Themes }));
            }
        }

        if (req.AdminNotificationOptouts is not null)
        {
            var (kinds, error) = UserPreferencesRules.NormaliseOptouts(req.AdminNotificationOptouts);
            if (error is not null)
            {
                return (null, Results.BadRequest(new { error, max = UserPreferencesRules.MaxOptouts }));
            }
            patch._optoutsJson = JsonSerializer.Serialize(kinds);
        }

        return (patch, null);
    }

    public void ApplyTo(UserPreferences p)
    {
        if (_theme is not null) p.Theme = _theme;
        if (_req.Findable is { } findable) p.Findable = findable;
        if (_req.ShowInLeaderboards is { } leaderboards) p.ShowInLeaderboards = leaderboards;
        if (_req.RatingOptIn is { } rating) p.RatingOptIn = rating;
        if (_req.WeeklyRecap is { } recap) p.WeeklyRecap = recap;
        if (_optoutsJson is not null) p.AdminNotificationOptoutsJson = _optoutsJson;
    }
}
