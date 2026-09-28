using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Crusaders.Mainframe.Api.Domain;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// What a preference write may contain, and the error codes a refusal answers with.
///
/// <para>
/// <b>Codes, not sentences.</b> The console turns each into its own words; a sentence composed
/// here would be one more string the frontend has to pattern-match to decide which field to
/// highlight.
/// </para>
/// </summary>
public static partial class UserPreferencesRules
{
    public const string InvalidTheme = "invalid_theme";
    public const string InvalidNotificationKind = "invalid_notification_kind";
    public const string TooManyOptouts = "too_many_optouts";

    /// <summary>
    /// An opt-out naming a kind the notifier sends to every admin regardless — an admin-rights
    /// change, a switched-off webhook, a suspected forged code (R23). Refused rather than stored,
    /// because a stored one would be a toggle reading "off" beside mail that keeps arriving.
    /// </summary>
    public const string NotificationKindNotOptional = "notification_kind_not_optional";
    public const string InvalidStep = "invalid_step";

    /// <summary>Longest onboarding step name. Generous for a slug; a sentence is not a step name.</summary>
    public const int MaxStepLength = 64;

    /// <summary>Longest notification kind. The catalogue's longest today is under 40.</summary>
    public const int MaxKindLength = 64;

    /// <summary>
    /// How many kinds one admin may opt out of. Far above the catalogue's size, and there so a
    /// client in a loop cannot grow one row's jsonb without bound.
    /// </summary>
    public const int MaxOptouts = 64;

    /// <summary>
    /// A notification kind is a dotted lower-case identifier — <c>device.offline</c>,
    /// <c>member.registered</c>. Whether the kind EXISTS is not checked here: an opt-out naming a
    /// kind this build does not know is inert, and refusing it would make a client and the
    /// notifier ship in lock-step. Whether a known kind may be switched off at all is checked by
    /// the PUT, against <see cref="AdminEventCatalogue"/>.
    /// </summary>
    [GeneratedRegex("^[a-z][a-z0-9_.]*$")]
    private static partial Regex KindPattern();

    /// <summary>A step is a frontend-owned slug: letters, digits and a little punctuation, no spaces.</summary>
    [GeneratedRegex("^[A-Za-z0-9][A-Za-z0-9_.:-]*$")]
    private static partial Regex StepPattern();

    /// <summary>The normalised theme, or null when it is not one of <see cref="UserPreferences.Themes"/>.</summary>
    public static string? NormaliseTheme(string raw)
    {
        var theme = raw.Trim().ToLowerInvariant();
        return Array.IndexOf(UserPreferences.Themes, theme) >= 0 ? theme : null;
    }

    /// <summary>The trimmed step, or null when it is not an acceptable step name.</summary>
    public static string? NormaliseStep(string? raw)
    {
        var step = raw?.Trim();
        if (string.IsNullOrEmpty(step) || step.Length > MaxStepLength) return null;
        return StepPattern().IsMatch(step) ? step : null;
    }

    /// <summary>
    /// The opt-out list as it will be stored — trimmed, de-duplicated, order kept — or the error
    /// code that refuses it.
    /// </summary>
    public static (IReadOnlyList<string>? Kinds, string? Error) NormaliseOptouts(IReadOnlyList<string?> raw)
    {
        var kinds = new List<string>();
        foreach (var entry in raw)
        {
            var kind = entry?.Trim() ?? "";
            if (kind.Length == 0 || kind.Length > MaxKindLength || !KindPattern().IsMatch(kind))
            {
                return (null, InvalidNotificationKind);
            }
            if (!kinds.Contains(kind, StringComparer.Ordinal)) kinds.Add(kind);
        }

        if (kinds.Count > MaxOptouts) return (null, TooManyOptouts);
        return (kinds, null);
    }

    /// <summary>
    /// Reads the stored jsonb back. A hand-edited row holding something that is not an array of
    /// strings reads as "no opt-outs" rather than as a 500 on every profile load — the failure
    /// that costs least, because the notifier then errs toward telling the admin.
    /// </summary>
    public static IReadOnlyList<string> ReadOptouts(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return [];
        try
        {
            return JsonSerializer.Deserialize<List<string>>(json) ?? [];
        }
        catch (JsonException)
        {
            return [];
        }
    }
}

/// <summary>
/// What <c>GET /api/v1/me/preferences</c> answers, and what <c>GET /api/v1/me/profile</c>
/// embeds as <c>preferences</c>. One shape for both so the two can never disagree.
///
/// <para>
/// A class with pinned names rather than an anonymous object because it is returned from four
/// routes and embedded in a fifth; an anonymous object repeated five times is five chances for
/// one route to spell a field differently.
/// </para>
/// </summary>
public sealed class UserPreferencesView
{
    [JsonPropertyName("theme")] public string Theme { get; init; } = "system";
    [JsonPropertyName("member_onboarding_completed_at")] public DateTimeOffset? MemberOnboardingCompletedAt { get; init; }
    [JsonPropertyName("member_onboarding_dismissed_at")] public DateTimeOffset? MemberOnboardingDismissedAt { get; init; }
    [JsonPropertyName("member_onboarding_last_step")] public string? MemberOnboardingLastStep { get; init; }
    [JsonPropertyName("admin_onboarding_completed_at")] public DateTimeOffset? AdminOnboardingCompletedAt { get; init; }
    [JsonPropertyName("onboarding_version")] public int OnboardingVersion { get; init; } = 1;

    /// <summary>
    /// The tour the product ships now. A completion older than this is a member who has not
    /// seen the current one, and the frontend decides from the pair whether to offer it again.
    /// </summary>
    [JsonPropertyName("current_onboarding_version")] public int CurrentOnboardingVersion { get; init; } = UserPreferences.CurrentOnboardingVersion;
    [JsonPropertyName("findable")] public bool Findable { get; init; }
    [JsonPropertyName("show_in_leaderboards")] public bool ShowInLeaderboards { get; init; }
    [JsonPropertyName("rating_opt_in")] public bool RatingOptIn { get; init; }
    [JsonPropertyName("weekly_recap")] public bool WeeklyRecap { get; init; }
    [JsonPropertyName("share_results")] public bool ShareResults { get; init; }
    [JsonPropertyName("admin_notification_optouts")] public IReadOnlyList<string> AdminNotificationOptouts { get; init; } = [];

    /// <summary>Null until the person has changed something — the honest answer for a row that does not exist.</summary>
    [JsonPropertyName("updated_at")] public DateTimeOffset? UpdatedAt { get; init; }

    /// <summary>The defaults when <paramref name="row"/> is null; the row's values otherwise.</summary>
    public static UserPreferencesView From(UserPreferences? row)
    {
        if (row is null) return new UserPreferencesView();
        return new UserPreferencesView
        {
            Theme = row.Theme,
            MemberOnboardingCompletedAt = row.MemberOnboardingCompletedAt,
            MemberOnboardingDismissedAt = row.MemberOnboardingDismissedAt,
            MemberOnboardingLastStep = row.MemberOnboardingLastStep,
            AdminOnboardingCompletedAt = row.AdminOnboardingCompletedAt,
            OnboardingVersion = row.OnboardingVersion,
            Findable = row.Findable,
            ShowInLeaderboards = row.ShowInLeaderboards,
            RatingOptIn = row.RatingOptIn,
            WeeklyRecap = row.WeeklyRecap,
            ShareResults = row.ShareResults,
            // A stored opt-out of a kind nobody may opt out of is not an opt-out, and is not
            // returned as one: the PUT refuses such a list, so a settings screen that saved back
            // what it read — a theme change carries the whole list — was refused for every
            // admin whose row predates the kind becoming non-optional.
            AdminNotificationOptouts = UserPreferencesRules.ReadOptouts(row.AdminNotificationOptoutsJson)
                .Where(k => !AdminEventCatalogue.IsSecurity(k)).ToList(),
            UpdatedAt = row.UpdatedAt,
        };
    }
}
