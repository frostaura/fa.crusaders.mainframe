namespace Crusaders.Mainframe.Api.Domain;

public enum AccessCodePurpose
{
    /// <summary>
    /// Minted with a booking and lives until its end plus the grace window. Presenting it
    /// at a box identifies the member AND names the booking, so the box can find the
    /// roster entry without a search.
    /// </summary>
    BookingActivation = 0,

    /// <summary>
    /// A short-lived code that identifies a member and nothing else — what the PWA shows
    /// when the member has no booking coming up, for walk-ups and the payer override.
    /// </summary>
    MemberIdent = 1,
}

/// <summary>
/// The thing a member's phone actually puts in front of the scanner.
///
/// <para>
/// This exists because the previous QR was a JWT, and no JWT can cross the court box's
/// scanner pipeline: the Mega's frame codec caps an argument at 24 bytes and the assembler
/// poisons anything longer rather than truncating it (review H2). A multi-hundred-byte
/// HS256 token was dropped as TooLong at the panel every time, so device identification
/// could never succeed — not "was flaky", could not. Whatever the box scans has to be short,
/// and short means it cannot be self-verifying; so it is a random handle to a row here,
/// and the row is the proof.
/// </para>
///
/// <para>
/// Twelve characters of Crockford base32 is sixty bits of entropy, which is unguessable
/// for a code that lives an hour or a minute, and it is twelve of the twenty-four bytes
/// the pipeline can carry. The alphabet drops I, L, O and U so a code read off a screen
/// and typed at a desk cannot be mis-read.
/// </para>
/// </summary>
public sealed class AccessCode : ITenantScoped
{
    /// <summary>Characters in a code. Half the scanner pipeline's argument limit, leaving room for a prefix if one is ever needed.</summary>
    public const int Length = 12;

    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }

    /// <summary>Upper-case Crockford base32, <see cref="Length"/> characters. Unique per tenant.</summary>
    public required string Code { get; set; }

    public AccessCodePurpose Purpose { get; set; }

    /// <summary>The member this code identifies — for either purpose.</summary>
    public Guid UserId { get; set; }

    /// <summary>The booking a <see cref="AccessCodePurpose.BookingActivation"/> code belongs to. Null for a member-ident code.</summary>
    public Guid? BookingId { get; set; }

    public DateTimeOffset ExpiresAt { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;

    public bool IsLiveAt(DateTimeOffset now) => ExpiresAt > now;
}
