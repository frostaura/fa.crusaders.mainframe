using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>Who a reminder is from — the organiser's nudge or the club's own — and its identity.</summary>
public sealed record ReminderKey(bool FromOrganiser, string DedupeKey);

/// <summary>
/// Builds the member notices a game with more than one player raises (D11). Each returns a
/// <see cref="MemberNotice"/> for the caller to stage in its own save; none of them saves.
///
/// <para>
/// <b>The links are app paths, never tokens.</b> An invite addressed to a member links to
/// <c>/invites/{participant}</c>, which they open signed in; the per-seat <c>/j/{token}</c> link is
/// only ever handed to the organiser to share, because a token written into an outbox payload
/// would be a credential stored in clear — the one thing hashing it at rest exists to prevent.
/// </para>
/// </summary>
public static class PlayerNotices
{
    public static string InvitePath(Guid participantId) => $"/invites/{participantId}";

    /// <summary>The dedupe-key prefixes of the two notices a re-invite loop repeats.</summary>
    public const string InvitedKeyPrefix = "invited:";
    public const string RemovedKeyPrefix = "removed:";

    /// <summary>
    /// Mail for one (booking, member) is collapsed to the inbox line when the same kind — an
    /// invite, or a removal (<paramref name="keyPrefix"/>) — was already raised for them on this
    /// booking inside the club's reminder cadence (<c>share_reminder_hours</c>). A remove-and-invite
    /// loop therefore mails a member at most once of each per cadence; the inbox keeps every line,
    /// and a collapsed invite is still mailed by the club's own reminder when the cadence ends.
    ///
    /// <para>
    /// <b>An invite is collapsed only when that reminder will come</b> (<paramref name="invitedTo"/>
    /// names its booking): reminders on (<c>share_reminder_max</c> &gt; 0) and the first one due
    /// before the share deadline. Otherwise nothing would ever mail the member about a seat they
    /// now hold, so it is mailed at once.
    /// </para>
    /// </summary>
    public static async Task<MemberNotice> CollapsedAsync(
        MainframeDbContext db, MemberNotice notice, string keyPrefix, TenantSettingsView settings, CancellationToken ct,
        Booking? invitedTo = null)
    {
        var now = DateTimeOffset.UtcNow;
        if (invitedTo is not null
            && (PlayerSettings.ShareReminderMax(settings) == 0
                || now.AddHours(PlayerSettings.ShareReminderHours(settings)) >= PlayerSettings.ShareDeadline(invitedTo, settings)))
        {
            return notice;
        }
        var since = now.AddHours(-PlayerSettings.ShareReminderHours(settings));
        var told = await db.MemberNotifications.AsNoTracking().AnyAsync(n =>
            n.BookingId == notice.BookingId && n.UserId == notice.UserId && n.CreatedAt > since && n.DedupeKey.StartsWith(keyPrefix), ct);
        return told ? notice with { Email = false } : notice;
    }

    /// <summary>
    /// The member answered their invite in the app (review round 3, I-9): its invite and reminder
    /// lines on this booking are marked read and resolved in the answer's own save — they ask
    /// nothing any more, and an inbox that kept them unread showed a number with nothing to do.
    /// Stages only; the caller saves.
    /// </summary>
    public static async Task AnsweredAsync(MainframeDbContext db, Guid bookingId, Guid userId, DateTimeOffset now, CancellationToken ct)
    {
        var open = await db.MemberNotifications
            .Where(n => n.BookingId == bookingId && n.UserId == userId && n.ResolvedAt == null
                        && (n.Kind == MemberEventCatalogue.Invited || n.Kind == MemberEventCatalogue.Reminder))
            .ToListAsync(ct);
        foreach (var n in open)
        {
            n.ReadAt ??= now.Storable();
            n.ResolvedAt = now.Storable();
        }
    }

    public static async Task<MemberNotice> InviteAsync(
        MainframeDbContext db, Booking booking, BookingParticipant seat, TenantSettingsView settings, CancellationToken ct)
    {
        var game = await GameText.ForAsync(db, booking, settings, ct);
        var organiser = await NameAsync(db, booking.UserId, "A member", ct);
        return new MemberNotice(
            seat.UserId!.Value, MemberEventCatalogue.Invited, $"{InvitedKeyPrefix}{seat.Id:N}",
            new InvitePayload(booking.Id, organiser, game.CourtName, game.StartsLocal, seat.ShareMinutes, InvitePath(seat.Id), seat.Id),
            $"{organiser} invited you — {game.CourtName}, {game.StartsLocal}", InvitePath(seat.Id), booking.Id);
    }

    public static async Task<MemberNotice> ReminderAsync(
        MainframeDbContext db, Booking booking, BookingParticipant seat, TenantSettingsView settings, ReminderKey key, CancellationToken ct)
    {
        var (fromOrganiser, dedupeKey) = (key.FromOrganiser, key.DedupeKey);
        var game = await GameText.ForAsync(db, booking, settings, ct);
        var organiser = await NameAsync(db, booking.UserId, "The organiser", ct);
        var deadline = GameText.Local(PlayerSettings.ShareDeadline(booking, settings), settings);
        return new MemberNotice(
            seat.UserId!.Value, MemberEventCatalogue.Reminder, dedupeKey,
            new ReminderPayload(booking.Id, organiser, game.CourtName, game.StartsLocal, seat.ShareMinutes, deadline,
                fromOrganiser, InvitePath(seat.Id), seat.Id),
            // R15 J15-5: every line names the court and the day.
            fromOrganiser
                ? $"{organiser} is waiting for your answer — {game.CourtName}, {game.StartsLocal}"
                : $"Your invite is still open — {game.CourtName}, {game.StartsLocal}",
            InvitePath(seat.Id), booking.Id);
    }

    /// <summary>The seat's member was taken off the game, or their share of it moved.</summary>
    public static async Task<MemberNotice> ChangedAsync(
        MainframeDbContext db, Booking booking, BookingParticipant seat, TenantSettingsView settings, string dedupeKey,
        CancellationToken ct)
    {
        var game = await GameText.ForAsync(db, booking, settings, ct);
        var organiser = await NameAsync(db, booking.UserId, "The organiser", ct);
        var removed = seat.Status == ParticipantStatus.Removed;
        var needsConsent = !removed && NeedsConsent(booking, seat);
        var where = $"{game.CourtName}, {game.StartsLocal}";
        return new MemberNotice(
            seat.UserId!.Value, MemberEventCatalogue.GameChanged, dedupeKey,
            new GameChangedPayload(booking.Id, organiser, game.CourtName, game.StartsLocal, removed,
                removed ? null : seat.ShareMinutes, needsConsent, seat.Id, SettledOutside: seat.SettledOutsideAt is not null),
            // R15 J15-5: the court AND the day, and the new figure — "Your share changed — Court 4" named neither.
            removed ? $"You were taken off {where}" : ChangedHeadline(organiser, where, seat),
            // R5 (M5-8): a removed member reads 404 from the booking; naming the seat lets the page
            // read their invite and say they were taken off. A share change keeps the plain path.
            removed ? $"/bookings/{booking.Id}?seat={seat.Id}" : $"/bookings/{booking.Id}", booking.Id);
    }

    /// <summary>
    /// R16 J16-6: the club recorded a partner's share as paid to the organiser by hand — told to both,
    /// in the act's own save: the partner (mailed, as every club act on their seat is) and the
    /// organiser (inbox only; any money that went back has its own receipt). R17 L17-8: when the
    /// partner had paid in the app (<paramref name="paidInApp"/>), that goes back — said, never
    /// "nothing moves in the app".
    /// </summary>
    public static async Task<IReadOnlyList<MemberNotice>> SettledOutsideAsync(
        MainframeDbContext db, Booking booking, BookingParticipant seat, TenantSettingsView settings, int paidInApp, CancellationToken ct)
    {
        var game = await GameText.ForAsync(db, booking, settings, ct);
        var organiser = await NameAsync(db, booking.UserId, "The organiser", ct);
        var partner = await NameAsync(db, seat.UserId, "Your partner", ct);
        var where = $"{game.CourtName}, {game.StartsLocal}";
        var back = paidInApp > 0 ? MoneyFormat.Minutes(paidInApp) : null;
        // Per act: the desk may record the same seat again (a second hand payment, a corrected reason).
        var key = $"settled-outside:{seat.Id:N}:{DateTimeOffset.UtcNow.UtcTicks}";
        return
        [
            new MemberNotice(
                seat.UserId!.Value, MemberEventCatalogue.GameChanged, $"{key}:partner",
                new GameChangedPayload(booking.Id, organiser, game.CourtName, game.StartsLocal, false, null, false, seat.Id, ByClub: true, SettledOutside: true)
                {
                    SettledByHand = true,
                    ReturnedMinutes = paidInApp > 0 ? paidInApp : null,
                },
                $"The club recorded that you paid {organiser} by hand for {where} — "
                + (back is null ? "nothing moves in the app" : $"the {back} you paid in the app go back to you"),
                $"/bookings/{booking.Id}", booking.Id),
            new MemberNotice(
                booking.UserId!.Value, MemberEventCatalogue.GameChanged, $"{key}:organiser",
                new GameChangedPayload(booking.Id, partner, game.CourtName, game.StartsLocal, false, null, false, seat.Id, ByClub: true, SettledOutside: true)
                {
                    SettledByHand = true,
                    ReturnedMinutes = paidInApp > 0 ? paidInApp : null,
                },
                $"The club recorded that {partner} paid you by hand for {where}"
                + (back is null ? "" : $" — the {back} they paid in the app go back to them"),
                $"/bookings/{booking.Id}", booking.Id)
            {
                Email = false,
            },
        ];
    }

    /// <summary>
    /// R16 J16-1: a share change, in the partner's inbox — one the club settled by hand says nothing
    /// moves ("share now 10" read as a figure they still owed).
    /// </summary>
    private static string ChangedHeadline(string organiser, string where, BookingParticipant seat)
    {
        var now = MoneyFormat.Minutes(seat.ShareMinutes);
        return seat.SettledOutsideAt is null
            ? $"{organiser} changed your share of {where} — now {now}"
            : $"{organiser} changed the split of {where} — you paid {organiser} by hand, so nothing moves in the app";
    }

    /// <summary>
    /// The partner has a new figure to say yes to: they accepted, their share went above what they
    /// agreed, the club has not settled it by hand (R15 J15-9 — a settled share asks nothing), and
    /// the game is not off (R17 E17-2 — a cancelled game asks nobody for anything).
    /// </summary>
    public static bool NeedsConsent(Booking booking, BookingParticipant seat) =>
        booking.Status != BookingStatus.Cancelled
        && seat.Status == ParticipantStatus.Accepted && seat.SettledOutsideAt is null && seat.ShareMinutes > seat.ConsentedMinutes;

    /// <summary>
    /// The club added the seat's member to the game, or accepted it for them (B8) — mailed, with
    /// the invite link while they still have to answer and the booking once they are in.
    /// <paramref name="keyPrefix"/> tells the add (<c>club-added</c>) from the acceptance
    /// (<c>club-accepted</c>) so both can be told about one seat.
    /// </summary>
    public static async Task<MemberNotice> ClubSeatAsync(
        MainframeDbContext db, Booking booking, BookingParticipant seat, TenantSettingsView settings, string keyPrefix, CancellationToken ct)
    {
        var game = await GameText.ForAsync(db, booking, settings, ct);
        var organiser = await NameAsync(db, booking.UserId, "A member", ct);
        var accepted = seat.Status == ParticipantStatus.Accepted;
        var path = accepted ? $"/bookings/{booking.Id}" : InvitePath(seat.Id);
        return new MemberNotice(
            seat.UserId!.Value, MemberEventCatalogue.ClubSeat, $"{keyPrefix}:{seat.Id:N}",
            new ClubSeatPayload(booking.Id, organiser, game.CourtName, game.StartsLocal, seat.ShareMinutes, accepted, path, seat.Id),
            accepted
                ? $"The club put you in {organiser}'s game — {game.CourtName}, {game.StartsLocal}"
                : $"The club added you to {organiser}'s game — {game.CourtName}, {game.StartsLocal}",
            path, booking.Id);
    }

    /// <summary>
    /// R16 E16-1: the club accepted a partner's invite for them — told to the organiser on the inbox
    /// only (it moves no money: an admin's accept records no consent), with the court and the day.
    /// </summary>
    public static async Task<MemberNotice> ClubAcceptedForOrganiserAsync(
        MainframeDbContext db, Booking booking, BookingParticipant seat, TenantSettingsView settings, CancellationToken ct)
    {
        var game = await GameText.ForAsync(db, booking, settings, ct);
        var partner = await NameAsync(db, seat.UserId, "A player", ct);
        return new MemberNotice(
            booking.UserId!.Value, MemberEventCatalogue.Response, $"response:{seat.Id:N}:club-accepted",
            new { booking_id = booking.Id }, $"The club accepted {partner}'s place in your game — {game.CourtName}, {game.StartsLocal}",
            $"/bookings/{booking.Id}", booking.Id)
        {
            Email = false,
        };
    }

    /// <summary>
    /// Pay what you can: the partner on <paramref name="seat"/> could pay only part of their share. The
    /// organiser — who paid the whole price at booking and so already covers the rest — is told, inbox
    /// and mail, with the booking to split it from. One per partial accept.
    /// </summary>
    public static async Task<MemberNotice> ShortfallAsync(
        MainframeDbContext db, Booking booking, BookingParticipant seat, TenantSettingsView settings, int shortfall, CancellationToken ct)
    {
        var game = await GameText.ForAsync(db, booking, settings, ct);
        var partner = await NameAsync(db, seat.UserId, "A player", ct);
        var (paid, share) = (seat.ShareMinutes, seat.ShareMinutes + shortfall);
        return new MemberNotice(
            booking.UserId!.Value, MemberEventCatalogue.Shortfall, $"shortfall:{seat.Id:N}:{DateTimeOffset.UtcNow.UtcTicks}",
            new ShortfallPayload(booking.Id, partner, game.CourtName, game.StartsLocal, paid, share, shortfall, seat.Id),
            $"{partner} could pay {MoneyFormat.Minutes(paid)} of their {MoneyFormat.Minutes(share)} share for {game.CourtName}, {game.StartsLocal} — "
            + $"{MoneyFormat.Minutes(shortfall)} {EmailTemplates.Is(shortfall)} left to cover. You're covering it for now; you can split it with the other players.",
            $"/bookings/{booking.Id}", booking.Id);
    }

    /// <summary>A partner's answer, told to the organiser on the inbox only.</summary>
    public static async Task<MemberNotice> ResponseAsync(
        MainframeDbContext db, Booking booking, BookingParticipant seat, TenantSettingsView settings, string verb, CancellationToken ct)
    {
        var game = await GameText.ForAsync(db, booking, settings, ct);
        var partner = await NameAsync(db, seat.UserId, "A player", ct);
        return new MemberNotice(
            booking.UserId!.Value, MemberEventCatalogue.Response, $"response:{seat.Id:N}:{verb}:{DateTimeOffset.UtcNow.UtcTicks}",
            new { booking_id = booking.Id }, $"{partner} {verb} — {game.CourtName}, {game.StartsLocal}",
            $"/bookings/{booking.Id}", booking.Id)
        {
            Email = false,
        };
    }

    private static async Task<string> NameAsync(MainframeDbContext db, Guid? userId, string fallback, CancellationToken ct) =>
        PersonNames.Of(userId, await PersonNames.ForAsync(db, [userId], ct)) ?? fallback;
}
