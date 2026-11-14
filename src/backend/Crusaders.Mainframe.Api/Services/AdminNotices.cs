using System.Globalization;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// A notice about to be put in the outbox: its kind, its identity, its facts, and the line the
/// feed will show.
/// </summary>
public sealed record AdminNotice(string Kind, string DedupeKey, object Payload, string Headline, string? Link)
{
    /// <summary>The admin whose action this is. Never mailed about it.</summary>
    public Guid? ActorUserId { get; init; }

    /// <summary>The person it is about. Mailed too, for a kind that notifies its subject.</summary>
    public Guid? SubjectUserId { get; init; }

    /// <summary>What a cooldown counts per. Null is the whole club.</summary>
    public string? CooldownScope { get; init; }
}

/// <summary>
/// Puts admin notices in the outbox, and builds the notice for each event that raises one.
///
/// <para>
/// <b><see cref="Stage"/> never saves, and that is the whole design.</b> It adds the row to the
/// caller's own <see cref="MainframeDbContext"/>, so the caller's <c>SaveChanges</c> — the one
/// that commits the registration, the outage row, the overdrawn booking, the rights change —
/// commits the notice with it. A rolled-back event leaves no notice; a committed one cannot lose
/// its notice to a crash on the far side of the commit. Static and context-taking rather than an
/// injected service because it has no state of its own, and because the paths that call it are
/// already at the six-collaborator ceiling the complexity gate holds them to.
/// </para>
///
/// <para>
/// <see cref="RaiseAsync"/> is the other shape, for the sweeps whose "event" is an observation
/// rather than a write — a spike, a reminder. It saves on its own and treats a dedupe collision as
/// "already raised", which is exactly what it is.
/// </para>
/// </summary>
public static class AdminNotices
{
    /// <summary>Adds <paramref name="notice"/> to <paramref name="db"/> for the caller's next save. Does not save.</summary>
    public static AdminNotification Stage(MainframeDbContext db, Guid tenantId, AdminNotice notice, DateTimeOffset? at = null)
    {
        var now = (at ?? DateTimeOffset.UtcNow).ToUniversalTime().Storable();
        var row = new AdminNotification
        {
            TenantId = tenantId,
            Kind = notice.Kind,
            DedupeKey = Clip(notice.DedupeKey, AdminNotification.DedupeKeyMaxLength),
            PayloadJson = JsonSerializer.Serialize(notice.Payload, notice.Payload.GetType(), AdminEventCatalogue.Json),
            Headline = Clip(notice.Headline, AdminNotification.HeadlineMaxLength),
            Link = notice.Link is null ? null : Clip(notice.Link, AdminNotification.LinkMaxLength),
            ActorUserId = notice.ActorUserId,
            SubjectUserId = notice.SubjectUserId,
            CooldownScope = notice.CooldownScope is null ? null : Clip(notice.CooldownScope, AdminNotification.CooldownScopeMaxLength),
            CreatedAt = now,
            DueAt = now,
        };
        db.AdminNotifications.Add(row);
        return row;
    }

    /// <summary>
    /// Stages and saves on its own, answering false when a notice with this dedupe key already
    /// exists for the club. For observations, never for events that have a write of their own.
    /// </summary>
    public static async Task<bool> RaiseAsync(
        MainframeDbContext db, Guid tenantId, AdminNotice notice, DateTimeOffset at, CancellationToken ct)
    {
        var key = Clip(notice.DedupeKey, AdminNotification.DedupeKeyMaxLength);
        var exists = await db.AdminNotifications.IgnoreQueryFilters()
            .AnyAsync(n => n.TenantId == tenantId && n.DedupeKey == key, ct);
        if (exists) return false;

        var row = Stage(db, tenantId, notice, at);
        try
        {
            await db.SaveChangesAsync(ct);
            return true;
        }
        catch (DbUpdateException)
        {
            // Two sweeps observed the same thing in the same instant; the index kept one.
            db.Entry(row).State = EntityState.Detached;
            return false;
        }
    }

    // ------------------------------------------------------------------ the notices
    //
    // Block bodies throughout, never `=> new(...) { ... }`: lizard reads the initializer's brace in
    // an expression body as the end of the function and reports the rest of the file as one
    // *global* (memory/gotchas-build.md).

    /// <summary>
    /// A new membership application. Keyed on the applicant, because an account applies once —
    /// the second attempt is refused as a duplicate before this is ever staged.
    /// </summary>
    public static AdminNotice MemberRegistered(Guid userId, string fullName, string email, string membershipNumber)
    {
        return new AdminNotice(
            AdminEventCatalogue.MemberRegistered,
            $"{AdminEventCatalogue.MemberRegistered}:{userId:N}",
            new RegistrationPayload(userId, fullName, email, membershipNumber),
            $"New membership application — {fullName}",
            "/admin/members")
        {
            SubjectUserId = userId,
        };
    }

    /// <summary>The daily reminder. Keyed on the club's own date, which is what makes it daily at most.</summary>
    public static AdminNotice ApplicationsPending(DateOnly clubDate, int count, string oldestName, int oldestHours)
    {
        var headline = count == 1
            ? $"1 application has waited more than {Hours(oldestHours)}"
            : $"{count} applications are waiting — the oldest for {Hours(oldestHours)}";
        return new AdminNotice(
            AdminEventCatalogue.ApplicationsPending,
            $"{AdminEventCatalogue.ApplicationsPending}:{Iso(clubDate)}",
            new ApplicationsPendingPayload(count, oldestName, oldestHours),
            headline,
            "/admin/members");
    }

    private static string Hours(int n) => n == 1 ? "1 hour" : $"{n} hours";

    /// <summary>
    /// Money lane BM-11: the daily reminder while any booking is older than the no-show sweep's
    /// lookback and was never settled. Keyed on the club's own date, so daily at most.
    /// </summary>
    public static AdminNotice BookingsUnsettled(DateOnly clubDate, int count, string oldestLocal, int lookbackDays)
    {
        var headline = count == 1
            ? $"1 past booking was never settled — from {oldestLocal}"
            : $"{count} past bookings were never settled — the oldest from {oldestLocal}";
        return new AdminNotice(
            AdminEventCatalogue.BookingsUnsettled,
            $"{AdminEventCatalogue.BookingsUnsettled}:{Iso(clubDate)}",
            new BookingsUnsettledPayload(count, oldestLocal, lookbackDays),
            headline,
            "/admin/bookings");
    }

    /// <summary>An outage opening or closing. Keyed on the outage row, so each row announces each edge once.</summary>
    public static AdminNotice DeviceOutage(Guid outageId, Device device, int minutes, bool recovered)
    {
        var kind = recovered ? AdminEventCatalogue.DeviceRecovered : AdminEventCatalogue.DeviceOffline;
        var gate = device.Kind == DeviceKind.Gate;
        var what = gate ? "Door gate" : "Court box";
        var headline = recovered
            // R9 X9-4: spoken long form — the Recent alerts list is read aloud ("after 6 minutes").
            ? $"{what} back online — {device.DeviceCode}, after {MoneyFormat.Minutes(minutes)}"
            : $"{what} not reporting — {device.DeviceCode}";

        return new AdminNotice(
            kind,
            $"{kind}:{outageId:N}",
            new DeviceOutagePayload(device.Id, gate, device.Name, device.DeviceCode, device.GateKey, [.. device.CourtNumbers], minutes),
            headline,
            "/admin/monitoring/devices")
        {
            CooldownScope = device.Id.ToString("N"),
        };
    }

    /// <summary>Many faults at once. Keyed on the window it was observed in, club-wide.</summary>
    public static AdminNotice FaultSpike(long bucket, int faults, int minutes, string[] boards)
    {
        return new AdminNotice(
            AdminEventCatalogue.FaultSpike,
            $"{AdminEventCatalogue.FaultSpike}:{bucket.ToString(CultureInfo.InvariantCulture)}",
            new FaultSpikePayload(faults, minutes, boards),
            $"{faults} device faults in {MoneyFormat.Minutes(minutes)}",
            "/admin/monitoring/faults");
    }

    /// <summary>One door refusing many scans. Keyed on the door and the window; cooled down per door.</summary>
    public static AdminNotice RefusalSpike(long bucket, Device door, int refusals, int minutes)
    {
        return new AdminNotice(
            AdminEventCatalogue.RefusalSpike,
            $"{AdminEventCatalogue.RefusalSpike}:{door.Id:N}:{bucket.ToString(CultureInfo.InvariantCulture)}",
            new RefusalSpikePayload(door.Id, door.Name, door.DeviceCode, door.GateKey, refusals, minutes),
            $"{door.Name} refused {refusals} scans in {MoneyFormat.Minutes(minutes)}",
            $"/admin/monitoring/doors/{door.Id}")
        {
            CooldownScope = door.Id.ToString("N"),
        };
    }

    /// <summary>
    /// A package-purchase failure an admin must look at (kind <c>topup.failed</c>, code kept —
    /// contract §12.2). Keyed on the purchase where there is one; cooled down per reason, so a
    /// gateway outage is one mail rather than one per member who tried.
    /// </summary>
    public static AdminNotice TopUpFailed(string reason, string identity, decimal? amountZar, string? memberName, string? reference) =>
        PurchaseFailed(reason, identity, memberName, new TopUpFailedPayload(reason, amountZar, memberName, reference));

    /// <summary>
    /// The same notice, carrying the package from the purchase row (contract §5: the payload gains
    /// <c>package_name</c> and <c>minutes</c>). <paramref name="pending"/> is null for a notification
    /// that names no purchase.
    /// </summary>
    public static AdminNotice TopUpFailed(string reason, string identity, string? memberName, PendingTopup? pending) =>
        PurchaseFailed(reason, identity, memberName, new TopUpFailedPayload(
            reason, pending?.AmountZar, memberName, pending is null ? null : pending.ExternalReference ?? pending.IdempotencyKey,
            pending?.PackageName, pending?.Minutes));

    /// <summary>
    /// A payment PayFast took that was not credited (<c>TopUpAlerts.PaidTwice</c> /
    /// <c>PaidAfterClose</c>). The payload's reference and amount are THAT payment's, and the
    /// member is the subject so the desk lands on them.
    /// </summary>
    public static AdminNotice TopUpNotAdded(string reason, string paymentId, decimal? amountZar, string? memberName, PendingTopup pending)
    {
        var notice = PurchaseFailed(reason, paymentId, memberName, new TopUpFailedPayload(
            reason, amountZar, memberName, paymentId, pending.PackageName, pending.Minutes));
        return notice with { SubjectUserId = pending.UserId };
    }

    private static AdminNotice PurchaseFailed(string reason, string identity, string? memberName, TopUpFailedPayload payload)
    {
        var headline = memberName is null
            ? $"Package purchase problem — {Words(reason)}"
            : $"Package purchase problem — {Words(reason)} ({memberName})";
        return new AdminNotice(
            AdminEventCatalogue.TopUpFailed,
            $"{AdminEventCatalogue.TopUpFailed}:{reason}:{identity}",
            payload,
            headline,
            "/admin/transactions")
        {
            CooldownScope = reason,
        };
    }

    /// <summary>
    /// A mail the outbox gave up on. Keyed on the outbox row, which fails once; cooled down under
    /// one scope for the whole club, so a mail server that is down for a day is one admin mail and
    /// as many feed rows as there were messages.
    /// </summary>
    public static AdminNotice EmailUndeliverable(Guid outboxId, string to, string subject, string reason)
    {
        return new AdminNotice(
            AdminEventCatalogue.EmailUndeliverable,
            $"{AdminEventCatalogue.EmailUndeliverable}:{outboxId:N}",
            new EmailUndeliverablePayload(to, subject, reason),
            $"An email could not be delivered — {subject}",
            "/admin/settings")
        {
            CooldownScope = "smtp",
        };
    }

    /// <summary>A club webhook switched off. Keyed on the delivery that switched it off, which happens once.</summary>
    public static AdminNotice WebhookAutoDisabled(WebhookEndpoint endpoint, Guid deliveryId, string destination, bool blocked)
    {
        var headline = blocked
            ? $"Webhook switched off — {destination} is not allowed"
            : $"Webhook switched off after {endpoint.FailureCount} failures — {destination}";
        return new AdminNotice(
            AdminEventCatalogue.WebhookAutoDisabled,
            $"{AdminEventCatalogue.WebhookAutoDisabled}:{endpoint.Id:N}:{deliveryId:N}",
            new WebhookDisabledPayload(endpoint.Id, destination, endpoint.Description, endpoint.FailureCount, blocked),
            headline,
            "/admin/webhooks");
    }

    /// <summary>
    /// A repeating booking that could not place some nights. Keyed on the schedule and its FIRST
    /// clash — the night the horizon is stuck behind — so the sweep that re-collides every tick
    /// raises it once, and a new first clash raises it again.
    /// </summary>
    public static AdminNotice ScheduleConflict(BookingSchedule schedule, IReadOnlyList<DateOnly> dates, int collisions)
    {
        var first = dates.Min();
        var shown = dates.Distinct().Order().Take(10).Select(Iso).ToArray();
        return new AdminNotice(
            AdminEventCatalogue.ScheduleConflict,
            $"{AdminEventCatalogue.ScheduleConflict}:{schedule.Id:N}:{Iso(first)}",
            new ScheduleConflictPayload(schedule.Id, schedule.Name, Iso(first), collisions, shown),
            $"{schedule.Name} could not be placed on {Iso(first)}",
            $"/admin/schedules/{schedule.Id}");
    }

    /// <summary>
    /// A booking an admin let go below zero. Keyed on the booking; cooled down per admin and
    /// member, so a batch of twenty overdrawn bookings is one mail and twenty rows on the feed.
    /// </summary>
    public static AdminNotice OverdraftAuthorised(Guid bookingId, Guid actorId, Guid memberId, OverdraftPayload payload)
    {
        var headline = payload.Self
            ? $"{payload.ActorName} booked below zero — {payload.CourtName}, {payload.StartsAtLocal}"
            : $"{payload.ActorName} took {payload.MemberName} below zero — {payload.CourtName}, {payload.StartsAtLocal}";
        return new AdminNotice(
            AdminEventCatalogue.OverdraftAuthorised,
            $"{AdminEventCatalogue.OverdraftAuthorised}:{bookingId:N}",
            payload,
            headline,
            "/admin/monitoring/changes")
        {
            ActorUserId = actorId,
            SubjectUserId = memberId,
            CooldownScope = $"{actorId:N}:{memberId:N}",
        };
    }

    /// <summary>An admin-rights change. Keyed on the change instant, because the same person can be granted, revoked and granted again.</summary>
    public static AdminNotice AdminRoleChanged(Guid targetId, Guid actorId, AdminRolePayload payload, DateTimeOffset at)
    {
        var headline = payload.Granted
            ? $"New administrator — {payload.SubjectName}"
            : $"Administrator removed — {payload.SubjectName}";
        return new AdminNotice(
            AdminEventCatalogue.AdminRoleChanged,
            $"{AdminEventCatalogue.AdminRoleChanged}:{targetId:N}:{at.UtcTicks.ToString(CultureInfo.InvariantCulture)}",
            payload,
            headline,
            "/admin/monitoring/changes")
        {
            ActorUserId = actorId,
            SubjectUserId = targetId,
        };
    }

    /// <summary>A member deleted by an administrator. One per account: a second delete of the same account stages nothing new.</summary>
    public static AdminNotice MemberDeleted(Guid userId, Guid actorId, MemberDeletedPayload payload)
    {
        return new AdminNotice(
            AdminEventCatalogue.MemberDeleted,
            $"{AdminEventCatalogue.MemberDeleted}:{userId:N}",
            payload,
            $"Member deleted — {payload.SubjectName}",
            "/admin/monitoring/changes")
        {
            ActorUserId = actorId,
            SubjectUserId = userId,
        };
    }

    /// <summary>
    /// A code a board accepted offline that the server cannot reproduce (member-code §7). One
    /// notice per event: the dedupe key is the board's boot and sequence, so a re-upload of the same
    /// batch raises nothing twice.
    /// </summary>
    public static AdminNotice CodeForgerySuspected(Device device, long bootId, long seq, string? memberName, Guid? memberId, string why)
    {
        var detail = why switch
        {
            "on_mismatch" => "the offline half verified and the online half did not — the board's day keys may have been copied",
            "reused" => "the same code was acted on twice for the same kind of thing",
            "malformed" => "the board reported a code that is not a member code at all",
            _ => "the board accepted a code the club cannot reproduce — a firmware fault or tampering",
        };
        return new AdminNotice(
            AdminEventCatalogue.CodeForgerySuspected,
            $"{AdminEventCatalogue.CodeForgerySuspected}:{device.Id:N}:{bootId.ToString(CultureInfo.InvariantCulture)}:{seq.ToString(CultureInfo.InvariantCulture)}",
            new ForgeryPayload(device.DeviceCode, memberName, detail),
            $"Suspected forged code at {device.DeviceCode}",
            "/admin/devices")
        {
            SubjectUserId = memberId,
            CooldownScope = device.Id.ToString("N"),
        };
    }

    /// <summary>A board that reported without <c>codes:m1</c> after the cut-over (member-code §8). Once per board per firmware version.</summary>
    public static AdminNotice CodesCapabilityLost(Device device, string phase)
    {
        return new AdminNotice(
            AdminEventCatalogue.CodesCapabilityLost,
            $"{AdminEventCatalogue.CodesCapabilityLost}:{device.Id:N}:{device.RunningVersion ?? "unknown"}",
            new CodesCapabilityLostPayload(device.Id, device.Name, device.DeviceCode, device.RunningVersion, phase),
            $"{device.DeviceCode} is running firmware without member codes",
            "/admin/devices")
        {
            CooldownScope = device.Id.ToString("N"),
        };
    }

    /// <summary>
    /// MCV1-09: the rollout moved on by itself (member-code §8). Once per move — the dedupe key is the
    /// move and its instant — so a club is told the day its codes changed, never by surprise later.
    /// </summary>
    public static AdminNotice CodesPhaseMoved(string from, string to, DateTimeOffset at, string? cutoffDueLocal, int cutoffDays)
    {
        var headline = to == MemberCodeSettings.V1Only
            ? "Old member codes stopped working: the club is on new codes only"
            : $"The club moved to new member codes; old codes stop {(cutoffDueLocal is null ? $"in {cutoffDays} days" : $"on {cutoffDueLocal}")}";
        return new AdminNotice(
            AdminEventCatalogue.CodesPhaseMoved,
            $"{AdminEventCatalogue.CodesPhaseMoved}:{from}:{to}:{at.UtcTicks}",
            new CodesPhaseMovedPayload(from, to, cutoffDueLocal, cutoffDays),
            headline,
            "/admin/monitoring/devices");
    }

    private static string Iso(DateOnly d) => d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    /// <summary>A reason code as words for a headline: <c>amount_mismatch</c> → "amount mismatch".</summary>
    private static string Words(string code) => code.Replace('_', ' ');

    private static string Clip(string value, int max) => value.Length <= max ? value : value[..max];
}
