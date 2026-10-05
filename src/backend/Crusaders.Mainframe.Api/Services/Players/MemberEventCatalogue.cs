using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;

namespace Crusaders.Mainframe.Api.Services;

// ---- The facts each member kind freezes onto its outbox row. Snake_case in the jsonb. ----

/// <param name="SeatId">The seat the invite is for — what the release reads the invite's fate from (C8). Null on older rows.</param>
public sealed record InvitePayload(
    Guid BookingId, string OrganiserName, string CourtName, string StartsAtLocal, int ShareMinutes, string Path, Guid? SeatId = null);

/// <param name="HeldUntilLocal">On a share an organiser receives: when it stops being held (B12). Null on older rows.</param>
/// <param name="ByClub">The club collected it (B8). False on older rows.</param>
/// <param name="BalanceAfterMinutes">The partner's balance after a club collect (B8).</param>
/// <param name="ClubRemoved">The club took the partner off the game; this is that removal's return (review round 2, B-8).</param>
/// <param name="ClubReason">The reason the admin recorded for a club collect or removal (B-8). Null on older rows.</param>
/// <param name="Withdrew">R13 E13-4: the share went back because the partner withdrew. False on older rows.</param>
/// <param name="OffGameSeatId">
/// R13 J13-3: the reader's own seat when they are no longer on the game (taken off, withdrew) — the
/// booking page 404s for them, so the link names the seat and the page says what became of it.
/// </param>
public sealed record SharePayload(
    Guid BookingId, ShareDirection Direction, string OtherName, string CourtName, string StartsAtLocal, int AmountMinutes,
    string? HeldUntilLocal = null, bool ByClub = false, int? BalanceAfterMinutes = null,
    bool ClubRemoved = false, string? ClubReason = null, bool AfterAttendance = false, string? ClubRefund = null,
    int? KeptMinutes = null, bool Withdrew = false, Guid? OffGameSeatId = null)
{
    /// <summary>
    /// R14 X14-2 / J14-8: why it went back when the mail words it itself — <c>organiser_removed</c>,
    /// <c>split_changed</c> or <c>booking_cancelled</c> (<see cref="WalletShareCauses"/>). Null on older rows.
    /// </summary>
    public string? Cause { get; init; }

    /// <summary>R14 J14-8: with <c>booking_cancelled</c>, who cancelled — "club" or "member"; null when unrecorded.</summary>
    public string? CancelledBy { get; init; }

    /// <summary>R15 J15-5: on a share taken again after a late check-in, whose check-in it was; null on older rows.</summary>
    public string? ScannerName { get; init; }

    /// <summary>R15 J15-5: that check-in was the reader's own.</summary>
    public bool ScannedByReader { get; init; }
}

/// <summary>The club put a member on a game, or accepted one for them (review round 1, B8).</summary>
public sealed record ClubSeatPayload(
    Guid BookingId, string OrganiserName, string CourtName, string StartsAtLocal, int ShareMinutes, bool Accepted, string Path,
    Guid? SeatId = null);

public sealed record ReminderPayload(
    Guid BookingId, string OrganiserName, string CourtName, string StartsAtLocal, int ShareMinutes, string DeadlineLocal,
    bool FromOrganiser, string Path, Guid? SeatId = null);

public sealed record LapsedPayload(
    Guid BookingId, string OtherName, string CourtName, string StartsAtLocal, int UnpaidMinutes, bool ToOrganiser, Guid? SeatId = null);

/// <summary>A return of a paid share that waits for the organiser's minutes to cover it (review round 2).</summary>
/// <param name="OffGame">R13 J13-3: the partner reading it is no longer on the game; their link names <paramref name="SeatId"/>.</param>
public sealed record ReturnWaitingPayload(
    Guid BookingId, string OtherName, string CourtName, string StartsAtLocal, int AmountMinutes, bool ToOrganiser, Guid? SeatId = null,
    bool OffGame = false);

/// <param name="ByClub">R13 E13-6: the club cancelled it (true), the organiser did (false); null on older rows and unrecorded cancels.</param>
/// <param name="ClubReason">The desk's recorded words on a club cancel.</param>
/// <param name="Cause">The system's cause (<see cref="ShareRefundCauses.Displaced"/>) when nobody at the desk did it.</param>
/// <param name="SessionStarted">R15 E15-1: somebody had checked in, so nothing was refunded and every share paid stands. False on older rows.</param>
public sealed record GameCancelledPayload(
    Guid BookingId, string OrganiserName, string CourtName, string StartsAtLocal, bool? ByClub = null, string? ClubReason = null,
    string? Cause = null, bool SessionStarted = false);

/// <summary>D14: a result the reader is asked to confirm, frozen at the first recording (§8).</summary>
public sealed record ResultToConfirmPayload(
    Guid BookingId, string SubmitterName, string CourtName, string WhenLocal, string ScoreLine, string ConfirmDueLocal);

/// <param name="SettledOutside">R15 J15-9: the club recorded the reader's share as paid outside the app. False on older rows.</param>
public sealed record GameChangedPayload(
    Guid BookingId, string OrganiserName, string CourtName, string StartsAtLocal, bool Removed, int? NewShareMinutes, bool NeedsConsent,
    Guid? SeatId = null, bool ByClub = false, bool SettledOutside = false);

/// <summary>Everything one member mail needs.</summary>
public sealed record MemberMailContext(ClubIdentity Club, string To, AdminNotification Row, string BaseUrl, TenantSettingsView Settings)
{
    public T Payload<T>() => JsonSerializer.Deserialize<T>(Row.PayloadJson, AdminEventCatalogue.Json)
        ?? throw new InvalidOperationException($"member notice {Row.Id} ({Row.Kind}) carries no payload");

    public string BookingUrl(Guid bookingId) => $"{BaseUrl}/bookings/{bookingId}";

    /// <summary>
    /// R13 J13-3: the booking's link for a reader no longer on it — naming their seat, which the
    /// page reads to say "You were taken off this game" instead of "Booking not found".
    /// </summary>
    public string BookingUrl(Guid bookingId, Guid? offGameSeat)
    {
        // Block body: lizard loses its scope on a property pattern in an expression body (memory/gotchas-gates.md).
        return offGameSeat.HasValue ? $"{BookingUrl(bookingId)}?seat={offGameSeat.Value}" : BookingUrl(bookingId);
    }
}

/// <summary>
/// Every kind of member notice the players feature raises, whether it may wait for the end of
/// quiet hours, and which message it becomes — the member twin of <see cref="AdminEventCatalogue"/>.
///
/// <para>
/// <b>Urgent means "about tonight, or about the reader's own action".</b> A cancellation of a game
/// the reader may be driving to, and the receipt for a share they have just paid, go at once;
/// an invite, a reminder or a lapse can wait until 07:00.
/// </para>
/// </summary>
public static class MemberEventCatalogue
{
    public const string Invited = "players.invited";
    public const string ShareMoved = "players.share_moved";
    public const string Reminder = "players.reminder";
    public const string Lapsed = "players.lapsed";
    public const string GameCancelled = "players.game_cancelled";
    public const string GameChanged = "players.game_changed";

    /// <summary>
    /// The club added the member to a game (an admin's add) or accepted one on their behalf —
    /// review round 1, B8: the member heard nothing of either. Mailed, not urgent.
    /// </summary>
    public const string ClubSeat = "players.club_seat";

    /// <summary>
    /// Minutes due back to a partner wait because the organiser's balance does not cover them — told
    /// ONCE to each side when it starts waiting (the seat's <c>ReturnPendingSince</c> stamp), never
    /// on every sweep that finds it still waiting. Not urgent. The wording owes nobody anything.
    /// </summary>
    public const string ReturnWaiting = "players.return_waiting";

    /// <summary>
    /// A partner's answer — accepted, declined, withdrew — told to the organiser on the INBOX only.
    /// It moves no money (a payment has its own receipt), and a mail per answer is how an organiser
    /// learns to ignore the club's mail.
    /// </summary>
    public const string Response = "players.response";

    // ---- Play (D14, docs/specs/play.md §8). Only the first is mailed — the one kind that asks the
    // member to do something by a deadline; the rest are inbox lines. ----

    /// <summary>A result the reader's side is asked to confirm. Mailed once per (booking, member), never urgent.</summary>
    public const string ResultToConfirm = "play.result_to_confirm";

    /// <summary>A result was confirmed — by the other side, or by silence. Inbox only.</summary>
    public const string ResultConfirmed = "play.result_confirmed";

    /// <summary>The other side disputed a result. Inbox only.</summary>
    public const string ResultDisputed = "play.result_disputed";

    /// <summary>The club removed a result. Inbox only.</summary>
    public const string ResultVoided = "play.result_voided";

    /// <summary>A badge earned while it was still news. Inbox only.</summary>
    public const string BadgeEarned = "play.badge_earned";

    /// <summary>The kinds that are mailed. <see cref="Response"/> and the inbox-only play kinds never reach the outbox.</summary>
    public static readonly IReadOnlyList<string> All =
        [Invited, ShareMoved, Reminder, Lapsed, GameCancelled, GameChanged, ReturnWaiting, ResultToConfirm, ClubSeat];

    private static readonly HashSet<string> Urgent = new(StringComparer.Ordinal) { ShareMoved, GameCancelled };

    public static bool IsKnown(string kind) => All.Contains(kind, StringComparer.Ordinal);

    public static bool IsUrgent(string kind) => Urgent.Contains(kind);

    public static EmailMessage Compose(MemberMailContext c)
    {
        switch (c.Row.Kind)
        {
            case Invited:
                return ComposeInvite(c);
            case ShareMoved:
                return ComposeShare(c);
            case Reminder:
                return ComposeReminder(c);
            case Lapsed:
                return ComposeLapsed(c);
            case GameCancelled:
                return ComposeCancelled(c);
            case GameChanged:
                return ComposeChanged(c);
            case ReturnWaiting:
                return ComposeReturnWaiting(c);
            case ResultToConfirm:
                return ComposeResultToConfirm(c);
            case ClubSeat:
                return ComposeClubSeat(c);
            default:
                throw new InvalidOperationException($"no message for member notice kind '{c.Row.Kind}'");
        }
    }

    private static EmailMessage ComposeInvite(MemberMailContext c)
    {
        var p = c.Payload<InvitePayload>();
        return EmailTemplates.PlayerInvite(c.Club, c.To, new PlayerInviteNotice(
            p.OrganiserName, p.CourtName, p.StartsAtLocal, p.ShareMinutes, c.BaseUrl + p.Path));
    }

    private static EmailMessage ComposeShare(MemberMailContext c)
    {
        var p = c.Payload<SharePayload>();
        return EmailTemplates.ShareMoved(c.Club, c.To, new ShareMovement(
            p.Direction, p.OtherName, p.CourtName, p.StartsAtLocal, p.AmountMinutes, c.BookingUrl(p.BookingId, p.OffGameSeatId),
            p.HeldUntilLocal, p.ByClub, p.BalanceAfterMinutes)
        {
            Withdrew = p.Withdrew,
            ClubRemoved = p.ClubRemoved,
            ClubReason = p.ClubReason,
            AfterAttendance = p.AfterAttendance,
            ClubRefund = p.ClubRefund,
            KeptMinutes = p.KeptMinutes,
            Cause = p.Cause,
            CancelledBy = p.CancelledBy,
            ScannerName = p.ScannerName,
            ScannedByReader = p.ScannedByReader,
        });
    }

    private static EmailMessage ComposeClubSeat(MemberMailContext c)
    {
        var p = c.Payload<ClubSeatPayload>();
        return EmailTemplates.ClubSeat(c.Club, c.To, new ClubSeatNotice(
            p.OrganiserName, p.CourtName, p.StartsAtLocal, p.ShareMinutes, p.Accepted, c.BaseUrl + p.Path));
    }

    private static EmailMessage ComposeReminder(MemberMailContext c)
    {
        var p = c.Payload<ReminderPayload>();
        return EmailTemplates.ShareReminder(c.Club, c.To, new ShareReminderNotice(
            p.OrganiserName, p.CourtName, p.StartsAtLocal, p.ShareMinutes, p.DeadlineLocal, p.FromOrganiser, c.BaseUrl + p.Path));
    }

    private static EmailMessage ComposeLapsed(MemberMailContext c)
    {
        var p = c.Payload<LapsedPayload>();
        return EmailTemplates.ShareLapsed(c.Club, c.To, new ShareLapsedNotice(
            p.OtherName, p.CourtName, p.StartsAtLocal, p.UnpaidMinutes, p.ToOrganiser, c.BookingUrl(p.BookingId)));
    }

    private static EmailMessage ComposeCancelled(MemberMailContext c)
    {
        var p = c.Payload<GameCancelledPayload>();
        var by = p.ByClub is { } club ? new GameCancelledBy(club, p.ClubReason, p.Cause) : null;
        return EmailTemplates.PlayersBookingCancelled(c.Club, c.To, new CancelledGame(p.OrganiserName, p.CourtName, p.StartsAtLocal, p.SessionStarted), by);
    }

    private static EmailMessage ComposeReturnWaiting(MemberMailContext c)
    {
        var p = c.Payload<ReturnWaitingPayload>();
        return EmailTemplates.ShareReturnWaiting(c.Club, c.To, new ShareReturnWaitingNotice(
            p.OtherName, p.CourtName, p.StartsAtLocal, p.AmountMinutes, p.ToOrganiser,
            c.BookingUrl(p.BookingId, p.OffGame && !p.ToOrganiser ? p.SeatId : null)));
    }

    private static EmailMessage ComposeResultToConfirm(MemberMailContext c)
    {
        var p = c.Payload<ResultToConfirmPayload>();
        return EmailTemplates.ResultToConfirm(c.Club, c.To, new ResultToConfirmNotice(
            p.SubmitterName, p.CourtName, p.WhenLocal, p.ScoreLine, p.ConfirmDueLocal, $"{c.BookingUrl(p.BookingId)}?result=confirm"));
    }

    private static EmailMessage ComposeChanged(MemberMailContext c)
    {
        var p = c.Payload<GameChangedPayload>();
        return EmailTemplates.PlayersChanged(c.Club, c.To, new PlayersChange(
            p.OrganiserName, p.CourtName, p.StartsAtLocal, p.Removed, p.NewShareMinutes, p.NeedsConsent,
            c.BookingUrl(p.BookingId, p.Removed ? p.SeatId : null))
        {
            ByClub = p.ByClub,
            SettledOutside = p.SettledOutside,
        });
    }
}
