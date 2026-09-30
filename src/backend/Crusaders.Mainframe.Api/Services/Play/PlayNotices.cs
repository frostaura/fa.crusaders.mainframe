using System.Globalization;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The member notices a result raises (D14, <c>docs/specs/play.md</c> §8), staged through
/// <see cref="MemberNotices.Stage"/> in the result's own save. Only
/// <see cref="MemberEventCatalogue.ResultToConfirm"/> is mailed, once per (booking, member); the
/// rest are inbox lines. Nothing here saves.
/// </summary>
public static class PlayNotices
{
    public static string Local(DateTimeOffset instant, TenantSettingsView settings) =>
        TimeZoneInfo.ConvertTime(instant, ClubClock.ZoneOf(settings)).ToString(ClubDate.Format, CultureInfo.InvariantCulture);

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

        var headline = $"{ToConfirmHeadline(r, c)} ({c.When}). Is it right?";
        var payload = ToConfirmPayload(r, c);
        foreach (var user in confirming)
        {
            MemberNotices.Stage(db, r.TenantId, new MemberNotice(
                user, MemberEventCatalogue.ResultToConfirm, $"{MailKey(r.BookingId, user)}:{r.Id}:{version ?? r.Version}", payload,
                headline, $"{BookingPath(r.BookingId)}?result=confirm", r.BookingId)
            {
                Email = !mailed.Contains(user),
                MailDedupeKey = MailKey(r.BookingId, user),
            }, c.Settings);
        }
    }

    /// <summary>
    /// The facts a <see cref="MemberEventCatalogue.ResultToConfirm"/> mail states, from the result as
    /// it is NOW — at staging, and again when a held mail is released (C8), so a mail never shows a
    /// score that was edited, withdrawn or re-recorded while it waited.
    /// </summary>
    public static ResultToConfirmPayload ToConfirmPayload(MatchResult r, ResultContext c)
    {
        var line = $"{SideNames(r, MatchSide.A, c)} {r.GamesWonA}–{r.GamesWonB} {SideNames(r, MatchSide.B, c)}";
        var due = Local(r.ConfirmDueAt ?? r.SubmittedAt, c.Settings);
        return new ResultToConfirmPayload(r.BookingId, c.NameOf(r.SubmittedByUserId), c.CourtName, c.When, $"{line} ({GamesText(r)})", due);
    }

    /// <summary>
    /// "Cara recorded a 2–1 win over Bongani" — from the recorder's side, first names, nobody named
    /// twice (review round 1, F2: the line read "Cara Naidoo recorded Cara Naidoo 2–1 Bongani").
    /// A doubles partner rides along: "Cara recorded a 3–1 win with Jo over Sam &amp; Lee".
    /// </summary>
    public static string ToConfirmHeadline(MatchResult r, ResultContext c)
    {
        var mine = SubmittingSide(r);
        var (won, lost) = mine == MatchSide.A ? (r.GamesWonA, r.GamesWonB) : (r.GamesWonB, r.GamesWonA);
        var partners = FirstNames(r.Players.Where(p => p.Side == mine && p.UserId != r.SubmittedByUserId), c);
        var opponents = FirstNames(r.Players.Where(p => p.Side != mine), c);
        var with = partners.Length > 0 ? $" with {partners}" : "";
        var outcome = won > lost ? $"a {won}–{lost} win{with} over" : $"a {won}–{lost} loss{with} to";
        return $"{FirstName(c.NameOf(r.SubmittedByUserId))} recorded {outcome} {opponents}";
    }

    private static string FirstNames(IEnumerable<MatchResultPlayer> players, ResultContext c) =>
        string.Join(" & ", players.OrderBy(p => p.Position).Select(p => p.UserId is { } u ? FirstName(c.NameOf(u)) : p.GuestName ?? "Guest"));

    private static string FirstName(string fullName)
    {
        var trimmed = fullName.Trim();
        var space = trimmed.IndexOf(' ');
        return space < 0 ? trimmed : trimmed[..space];
    }

    /// <summary>
    /// Marks every unread "Is it right?" line on this booking read, in the caller's save: the result
    /// it asked about was confirmed, disputed, edited (the new version asks again), withdrawn,
    /// voided or kept — it asks nothing any more (review round 1, F2).
    /// </summary>
    public static async Task RetireToConfirmAsync(MainframeDbContext db, Guid bookingId, DateTimeOffset now, CancellationToken ct)
    {
        var open = await db.MemberNotifications
            .Where(n => n.BookingId == bookingId && n.Kind == MemberEventCatalogue.ResultToConfirm && n.ReadAt == null)
            .ToListAsync(ct);
        foreach (var n in open) n.ReadAt = now.Storable();
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
