namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The areas an <see cref="Domain.AdminChangeLog"/> row can belong to. A closed set: the read
/// endpoint refuses <c>?area=</c> outside it rather than answering an empty list, because an
/// admin reading "no changes" about a filter the server did not understand is being told
/// something false.
/// </summary>
public static class AdminChangeAreas
{
    public const string Schedule = "schedule";
    public const string Booking = "booking";
    public const string Credit = "credit";
    public const string Group = "group";
    public const string Member = "member";
    public const string Setting = "setting";
    public const string Device = "device";

    /// <summary>D14: match results an admin voided or upheld.</summary>
    public const string Play = "play";

    public static readonly string[] All = [Schedule, Booking, Credit, Group, Member, Setting, Device, Play];
}

/// <summary>
/// What an <see cref="Domain.AdminChangeLog"/> row's <c>SubjectKind</c> may be. Closed for the
/// same reason the areas are.
/// </summary>
public static class AdminChangeSubjects
{
    public const string User = "user";
    public const string Schedule = "schedule";
    public const string Booking = "booking";
    public const string Group = "group";
    public const string Device = "device";
    public const string Setting = "setting";
    public const string Court = "court";

    /// <summary>A club webhook endpoint (review round 3, A-5).</summary>
    public const string Webhook = "webhook";

    /// <summary>D14: one recorded match (<c>match_results</c>).</summary>
    public const string MatchResult = "match_result";

    /// <summary>P13: one of the club's minutes packages (<c>minute_packages</c>).</summary>
    public const string Package = "package";

    public static readonly string[] All = [User, Schedule, Booking, Group, Device, Setting, Court, MatchResult, Webhook, Package];
}
