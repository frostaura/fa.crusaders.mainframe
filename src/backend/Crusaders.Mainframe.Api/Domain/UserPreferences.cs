namespace Crusaders.Mainframe.Api.Domain;

/// <summary>
/// One person's choices about how the product treats them — theme, onboarding progress, what
/// they let other members see, and which admin notices they have opted out of.
///
/// <para>
/// <b>A row of its own rather than columns on <see cref="User"/>.</b> <c>users</c> is the
/// authentication table: every sign-in, refresh and live role check reads it, and every column
/// added there is one more thing a credential path drags through memory and one more field a
/// careless projection can leak. None of this is about who someone is or what they may do; it
/// is how they like the app to behave, and it changes on a toggle.
/// </para>
///
/// <para>
/// <b>Lazily created.</b> Most members never change a default, and a row per member written at
/// registration or by a backfill would be a table of defaults that says nothing. The read path
/// answers the defaults when there is no row (<see cref="Services.UserPreferencesService"/>);
/// the first write creates it.
/// </para>
///
/// <para>
/// <b>Every privacy-shaped flag defaults to OFF</b> — findable, leaderboards, ratings, the
/// weekly recap. A member is invisible to other members until they say otherwise, which is the
/// direction the booking grid's "photo and name only" rule already points: being seen is opted
/// into, never assumed.
/// </para>
/// </summary>
public sealed class UserPreferences : ITenantScoped
{
    /// <summary>The values <see cref="Theme"/> may hold. The database's CHECK constraint names the same three.</summary>
    public static readonly string[] Themes = ["system", "light", "dark"];

    /// <summary>
    /// The onboarding the product ships today. Bumped when the tour changes enough that a member
    /// who finished the old one should be shown the new one; a completion stamps the version it
    /// completed, so "has seen the current tour" is <c>OnboardingVersion &gt;= Current</c>.
    /// </summary>
    public const int CurrentOnboardingVersion = 1;

    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid UserId { get; set; }

    /// <summary><c>system</c> follows the device; <c>light</c> and <c>dark</c> override it.</summary>
    public string Theme { get; set; } = "system";

    public DateTimeOffset? MemberOnboardingCompletedAt { get; set; }

    /// <summary>"Not now" rather than "done" — kept apart so the app can offer the tour again later without pretending it was finished.</summary>
    public DateTimeOffset? MemberOnboardingDismissedAt { get; set; }

    /// <summary>Where the member left the tour, so reopening it resumes rather than restarts. Free text owned by the frontend.</summary>
    public string? MemberOnboardingLastStep { get; set; }

    public DateTimeOffset? AdminOnboardingCompletedAt { get; set; }

    /// <summary>The <see cref="CurrentOnboardingVersion"/> in force when a tour was last completed.</summary>
    public int OnboardingVersion { get; set; } = 1;

    /// <summary>May other members find this person in the club directory. Off until they say so.</summary>
    public bool Findable { get; set; }

    public bool ShowInLeaderboards { get; set; }
    public bool RatingOptIn { get; set; }
    public bool WeeklyRecap { get; set; }

    /// <summary>
    /// The admin notification kinds this person has opted out of, as a jsonb array of strings.
    /// A string column rather than a typed collection for the same reason <c>audit_log</c>'s
    /// details are: the catalogue of kinds belongs to the notifier, and a schema change per new
    /// kind would couple two features that have no reason to ship together.
    /// </summary>
    public string AdminNotificationOptoutsJson { get; set; } = "[]";

    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
}
