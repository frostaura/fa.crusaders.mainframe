namespace Crusaders.Mainframe.Api.Domain;

/// <summary>
/// One member's single rotating code identity (D1, <c>docs/specs/member-code.md</c> §3): the
/// REF printed inside every code they show, and the generation their secret is derived at.
///
/// <para>
/// <b>Nothing secret is stored.</b> The member secret S is HKDF of the deployment's master key,
/// the tenant, the user and <see cref="Generation"/>; it is derived on demand and never persisted,
/// so this row is an identity and a counter, and a copy of the table forges nothing.
/// </para>
///
/// <para>
/// <b>The REF is stable across rotations and never reassigned while the row exists.</b> It is how
/// a roster names a player and how a device's replay ring names a member, and a REF that moved to
/// somebody else would hand one member's replay history — and a device's cached key slot — to
/// another. Rotation is <c>Generation += 1</c> and nothing else.
/// </para>
/// </summary>
public sealed class MemberCode : ITenantScoped
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid UserId { get; set; }

    /// <summary>The 20-bit REF value, <c>[1, 2^20 − 1]</c>, unique within the tenant.</summary>
    public int Ref { get; set; }

    /// <summary>Starts at 1. Rotation is <c>+= 1</c>; a code from any other generation is not recognised.</summary>
    public int Generation { get; set; } = 1;

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;

    /// <summary>When the member's phone last enrolled — the last time S left the server. Null until it has.</summary>
    public DateTimeOffset? EnrolledAt { get; set; }

    /// <summary>When the generation last moved. Null for a member never rotated.</summary>
    public DateTimeOffset? RotatedAt { get; set; }
}

/// <summary>
/// One acting use of one code (§4.4): a gate opened, a court granted, money moved.
///
/// <para>
/// Unique on <c>(tenant, ref, step, use_class)</c>, so a code is used once PER CLASS: opening the
/// front door and scanning at the court inside one thirty-second step are two different things.
/// A row exists only when the server ACTED — never for a refusal or a quote, so a member told
/// "too early" who scans again is not refused as a replay. Rows older than a day are purged; a
/// code is worth nothing ninety seconds after it was shown.
/// </para>
/// </summary>
public sealed class MemberCodeUse : ITenantScoped
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }

    /// <summary>The member's REF value — the stable half of the key.</summary>
    public int Ref { get; set; }

    /// <summary>The step the code was accepted at (§3.4).</summary>
    public long Step { get; set; }

    /// <summary><c>door</c>, <c>court</c> or <c>money</c> — see <see cref="MemberCodeUseClass"/>.</summary>
    public required string UseClass { get; set; }

    public DateTimeOffset UsedAt { get; set; } = DateTimeOffset.UtcNow;

    /// <summary>The board it was used at, when one was involved.</summary>
    public Guid? DeviceId { get; set; }

    /// <summary>What happened: <c>activate</c>, <c>gate</c>, <c>walkup</c>, <c>pay_for</c>, <c>activation_event</c>, <c>gate_open_event</c>.</summary>
    public required string Kind { get; set; }
}

/// <summary>The three things a code can be used for once each.</summary>
public static class MemberCodeUseClass
{
    public const string Door = "door";
    public const string Court = "court";
    public const string Money = "money";
}

/// <summary>
/// One D10 pay-for confirm from one box, keyed by the box's nonce (§9.2) — what makes a retried
/// confirm answer with the FIRST payment rather than a second one.
///
/// <para>
/// Written BEFORE the money moves, as a claim on the nonce, and completed after it: the unique
/// index is what stops two concurrent retries both paying. A claim whose payment was refused is
/// deleted, so the next press re-decides; a claim left pending by a crash is settled from the
/// booking itself on the next retry (see <c>DevicePayForEndpoint</c>).
/// </para>
/// </summary>
public sealed class DevicePayFor : ITenantScoped
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid DeviceId { get; set; }

    /// <summary>Sixteen lower-case hex characters, the same for a quote and its confirm.</summary>
    public required string Nonce { get; set; }

    public Guid BookingId { get; set; }
    public Guid PayerUserId { get; set; }

    /// <summary>The member refunded — the booking's payer before this one.</summary>
    public Guid? RefundedUserId { get; set; }

    public int CourtNumber { get; set; }

    /// <summary>Credits, the unit of account. What the payer took over.</summary>
    public decimal AmountCredits { get; set; }

    /// <summary>The server's rendering of <see cref="AmountCredits"/> the glass showed.</summary>
    public required string AmountLabel { get; set; }

    /// <summary>Credits. The payer's balance straight after — the first answer's figure.</summary>
    public decimal BalanceAfterCredits { get; set; }

    /// <summary>Seconds the first answer lit the court for; zero when the booking was already started.</summary>
    public int GrantedSeconds { get; set; }

    /// <summary>False while the payment is in flight; true once it committed.</summary>
    public bool Paid { get; set; }

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}
