using System.Security.Cryptography;
using System.Text;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// One player to add to a booking: a member by id, a named guest, or an open link seat — exactly
/// one of the three. <see cref="Weight"/> and <see cref="Amount"/> are read by a ratio or an amount
/// split respectively. Requests bind camelCase, like every POST body in this API.
/// </summary>
public sealed record PlayerSpec(
    Guid? UserId = null, string? GuestName = null, bool? Link = null, int? Seat = null, int? Weight = null, decimal? Amount = null);

/// <summary>
/// The players a booking is made with (the BookSheet's Players and Split steps), or added to an
/// existing booking. <see cref="SplitMode"/> defaults to <c>equal</c>.
/// </summary>
public sealed record PlayersRequest(IReadOnlyList<PlayerSpec>? Players = null, string? SplitMode = null, int? OrganiserWeight = null);

/// <summary>One seat's figure in a split change, by participant id.</summary>
public sealed record SplitSeatRequest(Guid ParticipantId, int? Weight = null, decimal? Amount = null);

/// <summary>A re-split of a booking's live seats. Seats not named keep weight 1 / amount 0.</summary>
public sealed record SplitRequest(string? Mode = null, IReadOnlyList<SplitSeatRequest>? Seats = null);

/// <summary>An answer from the players service: a status, a stable error code on refusal, and a body.</summary>
public sealed record PlayerOutcome(int StatusCode, string? Error = null, object? Body = null)
{
    public static PlayerOutcome Ok(object? body) => new(200, null, body);

    public static PlayerOutcome Refuse(int status, string error, object? extra = null) => new(status, error, extra);

    public bool IsOk => StatusCode is >= 200 and < 300;

    public static readonly PlayerOutcome BookingNotFound = new(404, "booking_not_found");
    public static readonly PlayerOutcome PlayerNotFound = new(404, "player_not_found");
    public static readonly PlayerOutcome InviteNotFound = new(404, "invite_not_found");
}

/// <summary>The stable error codes the players routes answer with. The frontend maps each to a sentence.</summary>
public static class PlayerErrors
{
    public const string BookingNotOpen = "booking_not_open";
    public const string BookingFull = "booking_full";
    public const string SeatTaken = "seat_taken";
    public const string AlreadyInBooking = "already_in_booking";
    public const string MemberNotFound = "member_not_found";
    public const string MembershipInactive = "membership_inactive";
    public const string InvalidPlayer = "player_invalid";
    public const string TooManyPlayers = "too_many_players";
    public const string GuestNameInvalid = "guest_name_invalid";
    public const string InviteClosed = "invite_closed";
    public const string NotInvited = "not_invited";
    public const string WithdrawWindowClosed = "withdraw_window_closed";
    public const string PartnerCapExceeded = "partner_cap_exceeded";
    public const string InsufficientBalance = "insufficient_balance";
    public const string NudgeLimit = "nudge_limit";
    public const string NothingToNudge = "nothing_to_nudge";
    public const string Conflict = "conflict_retry";
    public const string ReasonRequired = "reason_required";
    public const string OverdraftNotAuthorised = "overdraft_not_authorised";
    public const string NothingToCollect = "nothing_to_collect";
    public const string SplitNeedsSeats = "split_unknown_seat";
    public const string PayerOverridden = "booking_payer_overridden";
    public const string ShareChanged = "share_changed";
    public const string ExpectedShareRequired = "expected_share_required";
    public const string PreviouslyDeclined = "player_previously_declined";
    public const string PreviouslyRemoved = "player_previously_removed";
    public const string InviteLimit = "player_invite_limit";
    public const string NotAccepted = "player_not_accepted";

    /// <summary>R16 E16-8: the share was recorded as paid by hand — there is nothing to collect in the app.</summary>
    public const string SettledOutside = "share_settled_outside";

    /// <summary>R16 J16-11: the member already holds their daily cap of court time on that club day.</summary>
    public const string AtDailyLimit = "at_daily_limit";
}

/// <summary>
/// Invite link tokens: 128 random bits, shown once, stored only as a SHA-256.
///
/// <para>
/// <b>Base64url, 22 characters</b> — short enough for a WhatsApp preview, long enough that
/// guessing one is hopeless. The hash is what the <c>(InviteTokenHash)</c> index finds; a leaked
/// database hands nobody a working link.
/// </para>
/// </summary>
public static class InviteTokens
{
    public static (string Token, string Hash) Mint()
    {
        var token = Convert.ToBase64String(RandomNumberGenerator.GetBytes(16))
            .TrimEnd('=').Replace('+', '-').Replace('/', '_');
        return (token, Hash(token));
    }

    public static string Hash(string token) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token.Trim()))).ToLowerInvariant();

    /// <summary>The app path an invite link opens — what the organiser shares.</summary>
    public static string PathFor(string token) => $"/j/{token}";

    /// <summary>A token is 22 base64url characters. Anything else is refused before it reaches the database.</summary>
    public static bool LooksValid(string? token) =>
        token is { Length: 22 } t && t.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_');
}
