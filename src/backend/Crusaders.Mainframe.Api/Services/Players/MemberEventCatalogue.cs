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
public sealed record SharePayload(
    Guid BookingId, ShareDirection Direction, string OtherName, string CourtName, string StartsAtLocal, int AmountMinutes,
    string? HeldUntilLocal = null, bool ByClub = false, int? BalanceAfterMinutes = null,
    bool ClubRemoved = false, string? ClubReason = null);

/// <summary>The club put a member on a game, or accepted one for them (review round 1, B8).</summary>
public sealed record ClubSeatPayload(
    Guid BookingId, string OrganiserName, string CourtName, string StartsAtLocal, int ShareMinutes, bool Accepted, string Path,
    Guid? SeatId = null);

public sealed record ReminderPayload(
    Guid BookingId, string OrganiserName, string CourtName, string StartsAtLocal, int ShareMinutes, string DeadlineLocal,
    bool FromOrganiser, string Path, Guid? SeatId = null);

public sealed record LapsedPayload(
    Guid BookingId, string OtherName, string CourtName, string StartsAtLocal, int UnpaidMinutes, bool ToOrganiser, Guid? SeatId = null);

/// <summary>A return of a paid share that waits for the organiser's credits to cover it (review round 2).</summary>
public sealed record ReturnWaitingPayload(
    Guid BookingId, string OtherName, string CourtName, string StartsAtLocal, int AmountMinutes, bool ToOrganiser, Guid? SeatId = null);

public sealed record GameCancelledPayload(Guid BookingId, string OrganiserName, string CourtName, string StartsAtLocal);

/// <summary>D14: a result the reader is asked to confirm, frozen at the first recording (§8).</summary>
public sealed record ResultToConfirmPayload(
    Guid BookingId, string SubmitterName, string CourtName, string WhenLocal, string ScoreLine, string ConfirmDueLocal);

public sealed record GameChangedPayload(
    Guid BookingId, string OrganiserName, string CourtName, string StartsAtLocal, bool Removed, int? NewShareMinutes, bool NeedsConsent,
    Guid? SeatId = null, bool ByClub = false);

/// <summary>Everything one member mail needs.</summary>
public sealed record MemberMailContext(ClubIdentity Club, string To, AdminNotification Row, string BaseUrl, TenantSettingsView Settings)
{
    public T Payload<T>() => JsonSerializer.Deserialize<T>(Row.PayloadJson, AdminEventCatalogue.Json)
        ?? throw new InvalidOperationException($"member notice {Row.Id} ({Row.Kind}) carries no payload");

    public string BookingUrl(Guid bookingId) => $"{BaseUrl}/bookings/{bookingId}";
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
    /// Money due back to a partner waits because the organiser's credits do not cover it — told
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
            p.Direction, p.OtherName, p.CourtName, p.StartsAtLocal, p.AmountMinutes, c.BookingUrl(p.BookingId),
            p.HeldUntilLocal, p.ByClub, p.BalanceAfterMinutes)
        {
            ClubRemoved = p.ClubRemoved,
            ClubReason = p.ClubReason,
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
        return EmailTemplates.PlayersBookingCancelled(c.Club, c.To, p.OrganiserName, p.CourtName, p.StartsAtLocal);
    }

    private static EmailMessage ComposeReturnWaiting(MemberMailContext c)
    {
        var p = c.Payload<ReturnWaitingPayload>();
        return EmailTemplates.ShareReturnWaiting(c.Club, c.To, new ShareReturnWaitingNotice(
            p.OtherName, p.CourtName, p.StartsAtLocal, p.AmountMinutes, p.ToOrganiser, c.BookingUrl(p.BookingId)));
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
            p.OrganiserName, p.CourtName, p.StartsAtLocal, p.Removed, p.NewShareMinutes, p.NeedsConsent, c.BookingUrl(p.BookingId))
        {
            ByClub = p.ByClub,
        });
    }
}
