using System.Globalization;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>What the notices about one result need to say who, where and when.</summary>
/// <param name="Names">Display names by member id (every member in the lineup, and the actor).</param>
public sealed record ResultContext(Booking Booking, string CourtName, TenantSettingsView Settings, IReadOnlyDictionary<Guid, string> Names)
{
    public string NameOf(Guid userId) => Names.TryGetValue(userId, out var n) ? n : "A member";

    /// <summary>The club-local <c>Tue 30 Sep, 18:00</c> of the match.</summary>
    public string When => PlayNotices.Local(Booking.StartsAt, Settings);
}

/// <summary>
/// The member notices a result raises (D14, <c>docs/specs/play.md</c> §8), staged through
/// <see cref="MemberNotices.Stage"/> in the result's own save. Only
/// <see cref="MemberEventCatalogue.ResultToConfirm"/> is mailed, once per (booking, member); the
/// rest are inbox lines. Nothing here saves.
/// </summary>
public static class PlayNotices
{
    public static string Local(DateTimeOffset instant, TenantSettingsView settings) =>
        TimeZoneInfo.ConvertTime(instant, ClubClock.ZoneOf(settings)).ToString("ddd dd MMM, HH:mm", CultureInfo.InvariantCulture);

    public static string BookingPath(Guid bookingId) => $"/bookings/{bookingId}";

    /// <summary>Display names of <paramref name="userIds"/>, for headlines. Every membership, not only active ones: history keeps its names.</summary>
    public static async Task<Dictionary<Guid, string>> NamesAsync(MainframeDbContext db, IEnumerable<Guid> userIds, CancellationToken ct)
    {
        var ids = userIds.Distinct().ToList();
        return await db.Memberships.AsNoTracking().Where(m => ids.Contains(m.UserId))
            .ToDictionaryAsync(m => m.UserId, m => m.FullName, ct);
    }

    /// <summary>A side's names, joined — <c>Jo Botha &amp; Sam Naidoo</c>; a guest by the name the seat carried.</summary>
    public static string SideNames(MatchResult r, string side, ResultContext c) =>
        string.Join(" & ", r.Players.Where(p => p.Side == side).OrderBy(p => p.Position)
            .Select(p => p.UserId is { } u ? c.NameOf(u) : p.GuestName ?? "Guest"));

    /// <summary>The games as <c>11–7, 9–11, 11–5</c>, side a first.</summary>
    public static string GamesText(MatchResult r) =>
        string.Join(", ", ResultGames.Read(r.GamesJson).Select(g => $"{g.A}–{g.B}"));

    /// <summary>
    /// Stages <see cref="MemberEventCatalogue.ResultToConfirm"/> to every member of the confirming
    /// side: an inbox line per version, and the mail only for a member not yet mailed about this
    /// booking — an edit or a re-record never mails twice (§8).
    /// </summary>
    /// <param name="version">The version the row will carry once saved — an edit's save bumps it.</param>
    public static async Task StageToConfirmAsync(MainframeDbContext db, MatchResult r, ResultContext c, CancellationToken ct, int? version = null)
    {
        var confirming = MembersOf(r, MatchSide.Other(SubmittingSide(r)));
        var keys = confirming.Select(u => MemberNotices.OutboxKey(MailKey(r.BookingId, u))).ToList();
        var mailed = await db.AdminNotifications.AsNoTracking()
            .Where(n => keys.Contains(n.DedupeKey)).Select(n => n.RecipientUserId).ToListAsync(ct);

        var submitter = c.NameOf(r.SubmittedByUserId);
        var line = $"{SideNames(r, MatchSide.A, c)} {r.GamesWonA}–{r.GamesWonB} {SideNames(r, MatchSide.B, c)}";
        var payload = new ResultToConfirmPayload(
            r.BookingId, submitter, c.CourtName, c.When, $"{line} ({GamesText(r)})", Local(r.ConfirmDueAt ?? r.SubmittedAt, c.Settings));
        foreach (var user in confirming)
        {
            MemberNotices.Stage(db, r.TenantId, new MemberNotice(
                user, MemberEventCatalogue.ResultToConfirm, $"{MailKey(r.BookingId, user)}:{r.Id}:{version ?? r.Version}", payload,
                $"{submitter} recorded {line} ({c.When}). Is it right?", $"{BookingPath(r.BookingId)}?result=confirm", r.BookingId)
            {
                Email = !mailed.Contains(user),
                MailDedupeKey = MailKey(r.BookingId, user),
            }, c.Settings);
        }
    }

    /// <summary>The one-mail-per-(booking, member) key of <see cref="MemberEventCatalogue.ResultToConfirm"/>.</summary>
    public static string MailKey(Guid bookingId, Guid userId) => $"play.to_confirm:{bookingId}:{userId}";

    /// <summary>
    /// <see cref="MemberEventCatalogue.ResultConfirmed"/>: to the submitting side, or to everybody in
    /// the lineup when the clock confirmed it — or when an admin kept a disputed result
    /// (<paramref name="everyone"/>), since the disputing side is waiting to hear too.
    /// </summary>
    public static void Confirmed(MainframeDbContext db, MatchResult r, ResultContext c, bool everyone = false)
    {
        var to = r.AutoConfirmed || everyone ? MembersOf(r, null) : MembersOf(r, SubmittingSide(r));
        foreach (var user in to)
        {
            var side = r.Players.First(p => p.UserId == user).Side;
            var won = r.WinnerSide == side;
            var mine = side == MatchSide.A ? r.GamesWonA : r.GamesWonB;
            var theirs = side == MatchSide.A ? r.GamesWonB : r.GamesWonA;
            var lead = r.AutoConfirmed ? "Result confirmed automatically" : "Result confirmed";
            Inbox(db, r, c, new InboxLine(user, MemberEventCatalogue.ResultConfirmed, $"play.confirmed:{r.Id}:{user}",
                $"{lead}: you {(won ? "won" : "lost")} {mine}–{theirs} ({c.When})."));
        }
    }

    /// <summary><see cref="MemberEventCatalogue.ResultDisputed"/>: to the submitting side's members.</summary>
    public static void Disputed(MainframeDbContext db, MatchResult r, ResultContext c)
    {
        var who = c.NameOf(r.DisputedByUserId ?? Guid.Empty);
        foreach (var user in MembersOf(r, SubmittingSide(r)))
        {
            Inbox(db, r, c, new InboxLine(user, MemberEventCatalogue.ResultDisputed, $"play.disputed:{r.Id}:{user}",
                $"{who} disputed the result of {c.When}. The club will look at it."));
        }
    }

    /// <summary><see cref="MemberEventCatalogue.ResultVoided"/>: to every member in the lineup.</summary>
    public static void Voided(MainframeDbContext db, MatchResult r, ResultContext c)
    {
        foreach (var user in MembersOf(r, null))
        {
            Inbox(db, r, c, new InboxLine(user, MemberEventCatalogue.ResultVoided, $"play.voided:{r.Id}:{user}",
                $"The club removed the result of {c.When}."));
        }
    }

    /// <summary><see cref="MemberEventCatalogue.BadgeEarned"/>: the member's own inbox line.</summary>
    public static void BadgeEarned(MainframeDbContext db, Guid tenantId, Guid userId, Badge badge, TenantSettingsView settings)
    {
        MemberNotices.Stage(db, tenantId, new MemberNotice(
            userId, MemberEventCatalogue.BadgeEarned, $"play.badge:{userId}:{badge.Key}", new { badge_key = badge.Key },
            $"New badge: {badge.Name}.", "/profile#my-game", null)
        {
            Email = false,
        }, settings);
    }

    /// <summary>The side of the member who recorded (or last edited) the result.</summary>
    public static string SubmittingSide(MatchResult r) =>
        r.Players.FirstOrDefault(p => p.UserId == r.SubmittedByUserId)?.Side ?? MatchSide.A;

    /// <summary>The members (never guests) of <paramref name="side"/>, or of the whole lineup when null.</summary>
    public static List<Guid> MembersOf(MatchResult r, string? side) =>
        r.Players.Where(p => p.UserId != null && (side is null || p.Side == side)).OrderBy(p => p.Side).ThenBy(p => p.Position)
            .Select(p => p.UserId!.Value).ToList();

    private sealed record InboxLine(Guid User, string Kind, string Key, string Headline);

    private static void Inbox(MainframeDbContext db, MatchResult r, ResultContext c, InboxLine line)
    {
        MemberNotices.Stage(db, r.TenantId, new MemberNotice(
            line.User, line.Kind, line.Key, new { result_id = r.Id, booking_id = r.BookingId }, line.Headline,
            BookingPath(r.BookingId), r.BookingId)
        {
            Email = false,
        }, c.Settings);
    }
}
