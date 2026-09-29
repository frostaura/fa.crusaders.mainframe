using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services.Realtime;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// Something one member must hear about: the inbox line they will see and, when
/// <see cref="Email"/> is set, the mail the outbox will send them.
/// </summary>
public sealed record MemberNotice(
    Guid UserId, string Kind, string DedupeKey, object Payload, string Headline, string? Link, Guid? BookingId)
{
    /// <summary>Mail it as well as showing it. Every player-affecting event does; a pure UI hint would not.</summary>
    public bool Email { get; init; } = true;

    /// <summary>
    /// The outbox's dedupe key when it is not the inbox line's (D14): an inbox line per event, but
    /// at most one mail per <i>this</i> key — <c>play.result_to_confirm</c> mails once per (booking,
    /// member) however often the result is edited or re-recorded. Null = the inbox line's key.
    /// </summary>
    public string? MailDedupeKey { get; init; }
}

/// <summary>
/// Puts member notices in the inbox and the outbox (D11 notifications) — the member half of the
/// R23 outbox, generalised with an audience rather than built twice.
///
/// <para>
/// <b><see cref="Stage"/> never saves</b>, for the reason <see cref="AdminNotices.Stage"/>
/// never does: the caller's save is the one that commits the event, so a rolled-back accept
/// leaves no receipt and a committed one cannot lose it. The inbox row and the outbox row are
/// staged together, which is what makes "the bell says it" and "the mail says it" one fact.
/// </para>
///
/// <para>
/// <b>Quiet hours are decided here as well as at delivery.</b> A non-urgent kind staged between
/// <c>member_quiet_start_minute</c> and <c>member_quiet_end_minute</c> is due at the window's end
/// in the club's clock, so an invite sent at 23:00 reaches the partner at 07:00. The inbox line
/// appears at once — quiet hours withhold the interruption, never the record.
/// </para>
/// </summary>
public static class MemberNotices
{
    /// <summary>The outbox's key for a member notice: its own namespace inside the club's one dedupe index.</summary>
    public static string OutboxKey(string dedupeKey) => Clip($"m:{dedupeKey}", AdminNotification.DedupeKeyMaxLength);

    public static void Stage(
        MainframeDbContext db, Guid tenantId, MemberNotice notice, TenantSettingsView settings, DateTimeOffset? at = null)
    {
        var now = (at ?? DateTimeOffset.UtcNow).ToUniversalTime().Storable();
        var key = Clip(notice.DedupeKey, MemberNotification.DedupeKeyMaxLength);

        db.MemberNotifications.Add(new MemberNotification
        {
            TenantId = tenantId,
            UserId = notice.UserId,
            Kind = notice.Kind,
            Headline = Clip(notice.Headline, MemberNotification.HeadlineMaxLength),
            Link = notice.Link is null ? null : Clip(notice.Link, MemberNotification.LinkMaxLength),
            BookingId = notice.BookingId,
            DedupeKey = key,
            CreatedAt = now,
        });

        if (!notice.Email) return;

        var due = MemberEventCatalogue.IsUrgent(notice.Kind) ? now : PlayerSettings.NextSendable(now, settings).Storable();
        db.AdminNotifications.Add(new AdminNotification
        {
            TenantId = tenantId,
            Audience = NotificationAudience.Member,
            RecipientUserId = notice.UserId,
            Kind = notice.Kind,
            DedupeKey = OutboxKey(notice.MailDedupeKey is { } mailKey ? Clip(mailKey, MemberNotification.DedupeKeyMaxLength) : key),
            PayloadJson = JsonSerializer.Serialize(notice.Payload, notice.Payload.GetType(), AdminEventCatalogue.Json),
            Headline = Clip(notice.Headline, AdminNotification.HeadlineMaxLength),
            Link = notice.Link is null ? null : Clip(notice.Link, AdminNotification.LinkMaxLength),
            SubjectUserId = notice.UserId,
            CreatedAt = now,
            DueAt = due,
        });
    }

    /// <summary>
    /// Stages and saves on its own, answering false when this notice already exists. For the
    /// sweeps and the post-settlement hook, whose "event" may be observed more than once.
    /// </summary>
    public static async Task<bool> RaiseAsync(
        MainframeDbContext db, Guid tenantId, MemberNotice notice, TenantSettingsView settings, CancellationToken ct)
    {
        var key = Clip(notice.DedupeKey, MemberNotification.DedupeKeyMaxLength);
        if (await db.MemberNotifications.IgnoreQueryFilters().AnyAsync(n => n.TenantId == tenantId && n.DedupeKey == key, ct))
        {
            return false;
        }

        Stage(db, tenantId, notice, settings);
        try
        {
            await db.SaveChangesAsync(ct);
            return true;
        }
        catch (DbUpdateException)
        {
            // Two passes observed the same thing at once; the index kept one.
            foreach (var entry in db.ChangeTracker.Entries()
                         .Where(e => e.State == EntityState.Added && e.Entity is MemberNotification or AdminNotification)
                         .ToList())
            {
                entry.State = EntityState.Detached;
            }
            return false;
        }
    }

    /// <summary>
    /// Tells a member's open app that their inbox changed — a named <c>notification</c> frame on
    /// the wallet stream they already hold open, carrying the unread count. Best effort and after
    /// the commit: the inbox endpoints are the record, this only saves a poll.
    /// </summary>
    public static async Task PublishUnreadAsync(
        MainframeDbContext db, IRealtimeBus bus, Guid tenantId, IEnumerable<Guid> userIds, CancellationToken ct)
    {
        foreach (var userId in userIds.Distinct())
        {
            try
            {
                var unread = await db.MemberNotifications.IgnoreQueryFilters()
                    .CountAsync(n => n.TenantId == tenantId && n.UserId == userId && n.ReadAt == null, ct);
                bus.Publish(RealtimeTopic.Wallet(tenantId, userId), new RealtimeMessage(
                    NotificationEvent, JsonSerializer.Serialize(new { unread_count = unread })));
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                // The inbox is still right; the badge catches up on the next poll.
            }
        }
    }

    /// <summary>The named SSE event the wallet stream carries when a member's inbox changes.</summary>
    public const string NotificationEvent = "notification";

    private static string Clip(string value, int max) => value.Length <= max ? value : value[..max];
}
