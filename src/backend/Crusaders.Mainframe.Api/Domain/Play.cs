namespace Crusaders.Mainframe.Api.Domain;

/// <summary>
/// Where one recorded match is in its life (D14, <c>docs/specs/play.md</c> §3.3). Stored as the
/// lower-case word, so the row and the wire read alike; the database CHECK names the same five.
///
/// <para>
/// <b>Only <see cref="Pending"/>, <see cref="Confirmed"/> and <see cref="Disputed"/> are live.</b>
/// The one-live-result-per-booking index is partial on exactly those three, so a voided or
/// withdrawn row keeps its history while the booking is free to be recorded again.
/// </para>
/// </summary>
public static class MatchResultStatus
{
    public const string Pending = "pending";
    public const string Confirmed = "confirmed";
    public const string Disputed = "disputed";
    public const string Voided = "voided";
    public const string Withdrawn = "withdrawn";

    public static readonly IReadOnlyList<string> All = [Pending, Confirmed, Disputed, Voided, Withdrawn];

    /// <summary>The live statuses as an array, for a query's <c>IN</c>.</summary>
    public static readonly string[] Live = [Pending, Confirmed, Disputed];

    /// <summary>A result that holds the booking: nothing else may be recorded on it.</summary>
    public static bool IsLive(string status) => status is Pending or Confirmed or Disputed;
}

/// <summary>The two match formats (§4). Best of 5 is the default.</summary>
public static class MatchFormat
{
    public const string BestOf3 = "best_of_3";
    public const string BestOf5 = "best_of_5";

    public static readonly IReadOnlyList<string> All = [BestOf3, BestOf5];
}

/// <summary>The two sides of a result's own lineup (§3.2). Not the seats' teams.</summary>
public static class MatchSide
{
    public const string A = "a";
    public const string B = "b";

    public static string Other(string side) => side == A ? B : A;
}

/// <summary>
/// One recorded match on one booking (§2.1). The lineup is its own (<see cref="MatchResultPlayer"/>),
/// frozen at submit or edit, so a later seat change cannot rewrite a match.
///
/// <para>
/// <b>Stats count confirmed rows only</b>, and they are derived on every read — so a void drops a
/// result from both players' records at once, with no sweep to forget.
/// </para>
/// </summary>
public sealed class MatchResult : ITenantScoped
{
    public const int StatusMaxLength = 16;
    public const int FormatMaxLength = 16;
    public const int DisputeNoteMaxLength = 280;
    public const int CloseReasonMaxLength = 500;
    public const int IdempotencyKeyMaxLength = 64;

    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid BookingId { get; set; }

    public string Status { get; set; } = MatchResultStatus.Pending;
    public string Format { get; set; } = MatchFormat.BestOf5;

    /// <summary><c>[{"a":11,"b":7}, …]</c> in play order, validated by <c>SquashScore</c> before it is written.</summary>
    public string GamesJson { get; set; } = "[]";

    public short GamesWonA { get; set; }
    public short GamesWonB { get; set; }

    /// <summary><c>a</c> or <c>b</c>.</summary>
    public string WinnerSide { get; set; } = MatchSide.A;

    /// <summary>The member who recorded it, or last edited it. Always in the lineup.</summary>
    public Guid SubmittedByUserId { get; set; }

    /// <summary>
    /// The member who first recorded it — never changed by an edit. The idempotency key is scoped
    /// to this member, not to <see cref="SubmittedByUserId"/>: an edit moves the submitter, and a
    /// replayed create must still find the row it made.
    /// </summary>
    public Guid RecordedByUserId { get; set; }

    public DateTimeOffset SubmittedAt { get; set; }
    public DateTimeOffset? EditedAt { get; set; }

    /// <summary>While pending: the last submit or edit plus <c>result_autoconfirm_hours</c>. The deadline is this instant.</summary>
    public DateTimeOffset? ConfirmDueAt { get; set; }

    public DateTimeOffset? ConfirmedAt { get; set; }

    /// <summary>The confirming member; null when the deadline confirmed it.</summary>
    public Guid? ConfirmedByUserId { get; set; }

    public bool AutoConfirmed { get; set; }
    public DateTimeOffset? DisputedAt { get; set; }
    public Guid? DisputedByUserId { get; set; }
    public string? DisputeNote { get; set; }

    /// <summary>Voided (admin), withdrawn (member) — or, for an upheld dispute, the admin who kept it.</summary>
    public DateTimeOffset? ClosedAt { get; set; }

    public Guid? ClosedByUserId { get; set; }

    /// <summary>The admin's reason on a void or an uphold.</summary>
    public string? CloseReason { get; set; }

    public string IdempotencyKey { get; set; } = "";

    /// <summary>
    /// Optimistic concurrency token, bumped by <c>MainframeDbContext</c> on every modification; also
    /// the client's <c>expectedVersion</c>. A new result on a booking starts one past the highest
    /// version any earlier result on that booking reached, so an <c>expectedVersion</c> can never
    /// match a different result than the one the client was shown.
    /// </summary>
    public int Version { get; set; } = 1;

    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }

    public List<MatchResultPlayer> Players { get; set; } = [];
}

/// <summary>One place in a result's lineup (§2.2): a member, or a guest seat's name as it was.</summary>
public sealed class MatchResultPlayer : ITenantScoped
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid ResultId { get; set; }

    /// <summary><c>a</c> or <c>b</c>.</summary>
    public string Side { get; set; } = MatchSide.A;

    /// <summary>1 or 2.</summary>
    public short Position { get; set; }

    public Guid? UserId { get; set; }

    /// <summary>The guest's seat (<c>booking_participants.Id</c>).</summary>
    public Guid? ParticipantId { get; set; }

    /// <summary>The guest's name as the seat carried it when the result was recorded.</summary>
    public string? GuestName { get; set; }
}

/// <summary>
/// A badge a member earned (§2.3). Never revoked — not by a void, not by a reversal: it is a
/// private moment already celebrated. Awarding is <c>INSERT … ON CONFLICT DO NOTHING</c>.
/// </summary>
public sealed class MemberBadge : ITenantScoped
{
    public const int BadgeKeyMaxLength = 48;

    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid UserId { get; set; }
    public string BadgeKey { get; set; } = "";

    /// <summary>The QUALIFYING instant (§5.6) — not when the row was written.</summary>
    public DateTimeOffset AwardedAt { get; set; }

    public Guid? BookingId { get; set; }
    public Guid? ResultId { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

/// <summary>The kinds of one-shot moment the PWA acknowledges (§2.4).</summary>
public static class CelebrationKind
{
    public const string Badge = "badge";
    public const string GoalReached = "goal_reached";
}

/// <summary>A one-shot moment the PWA shows once and acknowledges (§2.4).</summary>
public sealed class PlayCelebration : ITenantScoped
{
    public const int KindMaxLength = 24;
    public const int DedupeKeyMaxLength = 120;

    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid UserId { get; set; }
    public string Kind { get; set; } = CelebrationKind.Badge;

    /// <summary><c>badge:{key}</c> or <c>goal:{yyyy-MM}</c> — unique per member, so a moment happens once.</summary>
    public string DedupeKey { get; set; } = "";

    public string? BadgeKey { get; set; }

    /// <summary><c>yyyy-MM</c> for a goal reached.</summary>
    public string? Month { get; set; }

    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? SeenAt { get; set; }
}

/// <summary>A member's own play settings (§2.5). Created lazily; a member without a row reads as defaults.</summary>
public sealed class MemberPlayProfile : ITenantScoped
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid UserId { get; set; }

    /// <summary>Null = no ring.</summary>
    public int? MonthlyGoalMinutes { get; set; }

    public bool CelebrationsEnabled { get; set; } = true;

    /// <summary>The <c>BadgeCatalogue.Version</c> this member was last evaluated against; 0 = never.</summary>
    public int EvaluatorVersion { get; set; }

    public DateTimeOffset? EvaluatedAt { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
    public int Version { get; set; }
}

/// <summary>An injury pause (§2.6, §5.3). At most one open per member.</summary>
public sealed class MemberStreakPause : ITenantScoped
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid UserId { get; set; }
    public DateTimeOffset StartedAt { get; set; }

    /// <summary>Null while the pause is on.</summary>
    public DateTimeOffset? EndedAt { get; set; }

    public DateTimeOffset CreatedAt { get; set; }
}
