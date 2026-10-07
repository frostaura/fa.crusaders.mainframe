using Crusaders.Mainframe.Api.Domain;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services.Demo;

public sealed partial class DemoDataGenerator
{
    /// <summary>
    /// The admins' feed: an application for each member still waiting, the daily reminder about
    /// them, and (staged by <see cref="PlanFaults"/>) the box that went dark and came back. Each is
    /// written already delivered — it stands for a notice the club sent before today.
    /// </summary>
    private void PlanNotices(DemoWorld w, List<DemoMember> members)
    {
        var waiting = members.Where(m => m.Membership.Status == MembershipStatus.PendingApproval).OrderBy(m => m.Membership.CreatedAt).ToList();
        foreach (var m in waiting)
        {
            Feed(w, AdminNotices.MemberRegistered(m.User.Id, m.Membership.FullName, m.User.Email, m.Membership.MembershipNumber), m.Membership.CreatedAt);
        }
        if (waiting.Count > 0)
        {
            var oldest = waiting[0];
            var hours = Math.Max(1, (int)(w.Now - oldest.Membership.CreatedAt).TotalHours);
            Feed(w, AdminNotices.ApplicationsPending(w.Today, waiting.Count, oldest.Membership.FullName, hours), w.Now.AddHours(-2));
        }
    }

    /// <summary>One notice on the admins' feed, delivered at <paramref name="at"/>.</summary>
    private void Feed(DemoWorld w, AdminNotice notice, DateTimeOffset at)
    {
        var row = AdminNotices.Stage(_db, w.TenantId, notice, at);
        row.State = AdminNotificationState.Sent;
        row.SentAt = at.AddMinutes(1).Storable();
        row.RecipientCount = Math.Max(1, w.AdminMirrors.Count());
    }

    /// <summary>
    /// Members' inboxes, in the club's own words: every open invite ahead of today (the admin's
    /// own Invites tab among them), each admin told who answered their games, and every result
    /// still waiting on the admin's confirmation. Written after the games are saved, because the
    /// notices name the court and the time from the saved rows.
    /// </summary>
    private async Task InboxAsync(DemoWorld w, List<PlannedGame> games, CancellationToken ct)
    {
        foreach (var g in games.Where(g => g.Fate == GameFate.Upcoming))
        {
            foreach (var seat in g.Partners.Select(p => p.Seat).Where(s => s.Seat > 1))
            {
                if (seat.Status == ParticipantStatus.Invited)
                {
                    Inbox(w, await PlayerNotices.InviteAsync(_db, g.Booking, seat, w.Settings, ct), seat.InvitedAt, read: false);
                }
                else if (g.Organiser.IsMirror && seat.RespondedAt is { } answered)
                {
                    var verb = seat.Status == ParticipantStatus.Accepted ? "accepted" : "declined";
                    Inbox(w, await PlayerNotices.ResponseAsync(_db, g.Booking, seat, w.Settings, verb, ct), answered, read: false);
                }
            }
        }
        await ResultsToConfirmAsync(w, ct);
    }

    private async Task ResultsToConfirmAsync(DemoWorld w, CancellationToken ct)
    {
        var mirrors = w.Mirrors.Select(m => m.Id).ToHashSet();
        foreach (var r in _pendingResults)
        {
            var confirming = r.Players.Where(p => p.Side == MatchSide.B && p.UserId is { } u && mirrors.Contains(u)).Select(p => p.UserId!.Value).ToList();
            if (confirming.Count == 0) continue;
            var names = await PersonNames.ForAsync(_db, [r.SubmittedByUserId], ct);
            var who = PersonNames.Of(r.SubmittedByUserId, names) ?? "Your opponent";
            foreach (var user in confirming)
            {
                Inbox(w, new MemberNotice(
                    user, MemberEventCatalogue.ResultToConfirm, $"demo-result:{r.Id:N}:{user:N}", new { booking_id = r.BookingId },
                    $"{who} recorded your result — confirm it or say what happened", $"{PlayNotices.BookingPath(r.BookingId)}?result=confirm", r.BookingId),
                    r.SubmittedAt, read: false);
            }
        }
    }

    /// <summary>An inbox line only — the outbox is left alone: a demo club mails nobody.</summary>
    private void Inbox(DemoWorld w, MemberNotice notice, DateTimeOffset at, bool read)
    {
        _db.MemberNotifications.Add(new MemberNotification
        {
            TenantId = w.TenantId,
            UserId = notice.UserId,
            Kind = notice.Kind,
            Headline = notice.Headline,
            Link = notice.Link,
            BookingId = notice.BookingId,
            DedupeKey = notice.DedupeKey,
            CreatedAt = at.Storable(),
            ReadAt = read ? at.Storable() : null,
        });
    }
}
