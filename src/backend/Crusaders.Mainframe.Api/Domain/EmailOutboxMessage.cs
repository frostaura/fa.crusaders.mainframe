namespace Crusaders.Mainframe.Api.Domain;

/// <summary>Where one queued email is in its life. Stored as an integer; the database CHECK names the same three.</summary>
public enum EmailOutboxState
{
    /// <summary>Waiting for the sender, new or backing off after a failed attempt.</summary>
    Pending = 0,

    /// <summary>The mail server accepted it. The body and any attachment are dropped from the row.</summary>
    Sent = 1,

    /// <summary>The sender gave up after its last attempt. An admin notice is raised when the row belongs to a club.</summary>
    Failed = 2,
}

/// <summary>
/// One email waiting to leave, written by <see cref="Email.EmailOutboxService"/> and sent by
/// <see cref="Services.EmailOutboxDispatcher"/> — the table that keeps SMTP off every request thread.
///
/// <para>
/// <b>Why a table and not a background task.</b> The mail used to be sent from a request, or from
/// a <c>Task.Run</c> started by one. A request that awaited SMTP held a thread (and the admin's
/// button) for as long as the mail server took, up to its fifteen-second ceiling per message; a
/// <c>Task.Run</c> lost the mail with the process and gave nobody a way to learn it had failed. A
/// row is written in milliseconds, survives a restart, and is retried with backoff.
/// </para>
///
/// <para>
/// <b>Not tenant-filtered, on purpose.</b> This is the sender's queue, read across every club by
/// one worker, like the webhook delivery queue. <see cref="TenantId"/> is recorded only so a
/// terminal failure can tell the right club's administrators. Demo suppression happens before a
/// row is ever written, so no demo mail is stored.
/// </para>
/// </summary>
public sealed class EmailOutboxMessage
{
    public const int AddressMaxLength = 320;
    public const int SubjectMaxLength = 512;
    public const int LastErrorMaxLength = 1024;

    public Guid Id { get; set; } = Guid.NewGuid();

    /// <summary>The club the mail is for, where the flow that queued it had one. Null for an operational mail with no club.</summary>
    public Guid? TenantId { get; set; }

    public required string ToAddress { get; set; }
    public required string Subject { get; set; }

    /// <summary>The whole <see cref="Email.EmailMessage"/> as jsonb — body, attachments, priority, sender name. <c>{}</c> once sent.</summary>
    public string PayloadJson { get; set; } = "{}";

    public EmailOutboxState State { get; set; } = EmailOutboxState.Pending;

    /// <summary>Claims so far. Counted at the claim, so a row that crashes its worker still runs out of attempts.</summary>
    public int Attempts { get; set; }

    public DateTimeOffset CreatedAt { get; set; }

    /// <summary>When the sender may next try. <see cref="CreatedAt"/> at first; pushed back by each failed attempt.</summary>
    public DateTimeOffset DueAt { get; set; }

    /// <summary>A claim's lease. A worker that dies mid-send leaves this in the past and the row is claimable again.</summary>
    public DateTimeOffset? LockedUntil { get; set; }

    /// <summary>When it stopped being pending, sent or given up on.</summary>
    public DateTimeOffset? FinishedAt { get; set; }

    public string? LastError { get; set; }
}
