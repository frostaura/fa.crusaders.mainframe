namespace Crusaders.Mainframe.Api.Domain;

/// <summary>Where one admin notice is in its life. Stored as an integer; the database CHECK names the same four.</summary>
public enum AdminNotificationState
{
    /// <summary>Waiting for the dispatcher — new, or backing off after a failed send.</summary>
    Pending = 0,

    /// <summary>Every recipient it resolved to has been mailed (possibly nobody, when everyone opted out).</summary>
    Sent = 1,

    /// <summary>
    /// Not mailed, on purpose: another notice of the same kind and scope was mailed inside that
    /// kind's cooldown. Still on the in-app feed — a cooldown withholds the interruption, never
    /// the record.
    /// </summary>
    Suppressed = 2,

    /// <summary>The dispatcher gave up after its last attempt. Logged as an error when it happens.</summary>
    Failed = 3,
}

/// <summary>
/// One thing the club's administrators must hear about, written in the same unit of work as the
/// event that caused it — the outbox half of R23.
///
/// <para>
/// <b>Why a table and not a send.</b> Every admin mail in this tree used to be fired from the far
/// side of the commit that caused it, by <c>EmailDispatch.InBackground</c> or an awaited loop. A
/// process that died between the two lost the mail; a retried request that re-ran the path sent
/// it twice; a mail server that refused one address lost that admin's copy for good. A row saved
/// beside the event cannot be lost without the event being lost too, and <see cref="DedupeKey"/>
/// — unique per club — is what makes re-running the path a no-op rather than a second mail.
/// </para>
///
/// <para>
/// <b>Recipients are resolved at delivery, not at enqueue</b>, so an admin who opts out, is
/// demoted or confirms their address between the event and the send is judged by what is true
/// when the mail actually leaves. <see cref="DeliveredToJson"/> records who has already been
/// mailed, so a retry after a partial failure mails only the admins who have not had it.
/// </para>
///
/// <para>
/// <b>The payload is the notice's own facts, frozen</b> — a name, a court, an amount — as
/// they were when the event happened. It is rendered into mail by
/// <see cref="Services.AdminEventCatalogue"/> and never returned to a browser whole: the feed
/// carries <see cref="Headline"/> and <see cref="Link"/> only.
/// </para>
/// </summary>
public sealed class AdminNotification : ITenantScoped
{
    public const int KindMaxLength = 64;
    public const int DedupeKeyMaxLength = 200;
    public const int HeadlineMaxLength = 255;
    public const int LinkMaxLength = 512;
    public const int CooldownScopeMaxLength = 128;
    public const int LastErrorMaxLength = 1024;

    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }

    /// <summary>A catalogue kind — <c>member.registered</c>, <c>device.offline</c>. See <see cref="Services.AdminEventCatalogue"/>.</summary>
    public required string Kind { get; set; }

    /// <summary>
    /// Unique per club. Derived from the event's own identity — the applicant's user id, the
    /// outage row's id, the booking's id — so the same event staged twice is refused by the index
    /// rather than mailed twice.
    /// </summary>
    public required string DedupeKey { get; set; }

    /// <summary>The event's facts as the catalogue's payload record for <see cref="Kind"/>, as jsonb.</summary>
    public string PayloadJson { get; set; } = "{}";

    /// <summary>The one line the in-app feed shows. Written at enqueue, in the club's words.</summary>
    public required string Headline { get; set; }

    /// <summary>A console path the feed may link to — <c>/admin/members/{id}</c>. A hint, never an absolute URL.</summary>
    public string? Link { get; set; }

    /// <summary>The admin whose action caused this, who is never mailed about it. Null for events nobody did.</summary>
    public Guid? ActorUserId { get; set; }

    /// <summary>The person it is about, where there is one. For a kind that notifies its subject, the subject is mailed.</summary>
    public Guid? SubjectUserId { get; set; }

    /// <summary>
    /// What a cooldown is counted per — a board, an actor and member pair, a failure reason. Null
    /// means the whole club: one notice of that kind per cooldown, whatever it is about.
    /// </summary>
    public string? CooldownScope { get; set; }

    public DateTimeOffset CreatedAt { get; set; }

    /// <summary>When the dispatcher may next try. <see cref="CreatedAt"/> at first; pushed back by each failed attempt.</summary>
    public DateTimeOffset DueAt { get; set; }

    /// <summary>When it stopped being pending — mailed, suppressed or given up on.</summary>
    public DateTimeOffset? SentAt { get; set; }

    public AdminNotificationState State { get; set; } = AdminNotificationState.Pending;

    /// <summary>Claims so far. Counted at the claim, not at the failure, so a row that crashes its worker still runs out of attempts.</summary>
    public int Attempts { get; set; }

    public string? LastError { get; set; }

    /// <summary>A claim's lease. A worker that dies mid-send leaves this in the past and the row is claimable again.</summary>
    public DateTimeOffset? LockedUntil { get; set; }

    /// <summary>The user ids already mailed, as a jsonb array — so a retry never mails the same admin twice.</summary>
    public string DeliveredToJson { get; set; } = "[]";

    /// <summary>How many people were mailed in the end. Zero is a real answer: everyone had opted out.</summary>
    public int RecipientCount { get; set; }
}
