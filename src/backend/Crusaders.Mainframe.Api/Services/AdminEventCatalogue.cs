using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// One kind of thing the club's administrators are told about.
/// </summary>
/// <param name="Kind">The dotted identifier stored on the row and in an admin's opt-out list.</param>
/// <param name="Title">What a settings toggle calls it.</param>
/// <param name="Description">One sentence under the toggle saying when it fires.</param>
/// <param name="Security">
/// True for the kinds nobody may opt out of — the ones that decide who can see and undo
/// everything else, or that say the system itself may be compromised. An opt-out naming one is
/// refused at the preferences PUT, and ignored at delivery if one got into a row anyway.
/// </param>
/// <param name="NotifiesSubject">
/// True when the person the notice is about is mailed too, with a message of their own — today
/// only an admin-rights change, whose subject may no longer be an admin by the time it is sent.
/// </param>
public sealed record AdminEventKind(string Kind, string Title, string Description, bool Security = false, bool NotifiesSubject = false)
{
    /// <summary>Whether an admin may switch this kind's email off for themselves.</summary>
    public bool OptOutable => !Security;
}

// ---- The facts each kind freezes onto its row. Snake_case in the jsonb, like every other document here. ----

public sealed record RegistrationPayload(Guid UserId, string FullName, string Email, string MembershipNumber);

public sealed record ApplicationsPendingPayload(int Count, string OldestName, int OldestHours);

public sealed record DeviceOutagePayload(
    Guid DeviceId, bool IsGate, string DeviceName, string DeviceCode, string? GateKey, int[] CourtNumbers, int Minutes);

public sealed record FaultSpikePayload(int Faults, int Minutes, string[] Boards);

public sealed record RefusalSpikePayload(Guid DeviceId, string DoorName, string DeviceCode, string? GateKey, int Refusals, int Minutes);

public sealed record TopUpFailedPayload(string Reason, decimal? AmountZar, string? MemberName, string? Reference);

public sealed record WebhookDisabledPayload(Guid EndpointId, string Destination, string? Description, int Failures, bool Blocked);

public sealed record ScheduleConflictPayload(Guid ScheduleId, string ScheduleName, string FirstDate, int Collisions, string[] Dates);

/// <remarks>
/// <see cref="HeldCredits"/> is additive (review round 3, A-8) and null on a notice queued before
/// it: the part of the balance held for partners' shares, so the mail can state what the member
/// may SPEND after the booking — the figure the overdraft was decided on.
/// </remarks>
public sealed record OverdraftPayload(
    Guid BookingId, string ActorName, string MemberName, bool Self, string CourtName, string StartsAtLocal,
    decimal AmountCredits, decimal BalanceAfterCredits, decimal? HeldCredits = null);

public sealed record AdminRolePayload(string SubjectName, string ActorName, bool Granted, string? Reason);

public sealed record ForgeryPayload(string DeviceCode, string? MemberName, string Detail);

public sealed record CodesCapabilityLostPayload(Guid DeviceId, string DeviceName, string DeviceCode, string? FirmwareVersion, string Phase);

/// <summary>
/// Everything one message needs: whose club, to whom, which row, and whether the reader is the
/// row's subject rather than one of its administrators.
/// </summary>
public sealed record AdminMailContext(
    ClubIdentity Club, string To, AdminNotification Row, bool ToSubject, string BaseUrl, TenantSettingsView Settings)
{
    /// <summary>The row's own console link, absolute.</summary>
    public string ConsoleUrl => BaseUrl + (Row.Link ?? "/admin");

    public T Payload<T>() => JsonSerializer.Deserialize<T>(Row.PayloadJson, AdminEventCatalogue.Json)
        ?? throw new InvalidOperationException($"admin notice {Row.Id} ({Row.Kind}) carries no payload");
}

/// <summary>
/// Every kind of admin notice the product raises, what it is called, whether it may be switched
/// off, and which message it becomes (R23).
///
/// <para>
/// <b>The single place a kind is defined.</b> The outbox rows name a kind, an admin's opt-outs
/// name kinds, the settings toggles are rendered from <see cref="All"/>, and the dispatcher
/// composes mail through <see cref="Compose"/>. A kind that exists in one of those and not here
/// is a row the dispatcher refuses (logged, marked failed) rather than a mail it guesses at.
/// </para>
///
/// <para>
/// <b>Cooldowns are not here.</b> A cooldown is a number and every configurable number is a
/// tenant setting, so the kinds that have one read it at delivery — see
/// <see cref="AdminNotificationDispatcher.Cooldown"/> and <see cref="AdminNotificationSettings"/>:
/// the spikes reuse <c>device_alert_cooldown_minutes</c>, a top-up failure reads
/// <c>topup_failure_cooldown_minutes</c> and an overdraft <c>overdraft_cooldown_minutes</c>.
/// </para>
/// </summary>
public static class AdminEventCatalogue
{
    public const string MemberRegistered = "member.registered";
    public const string ApplicationsPending = "member.application_pending";
    public const string DeviceOffline = "device.offline";
    public const string DeviceRecovered = "device.recovered";
    public const string FaultSpike = "device.fault_spike";
    public const string RefusalSpike = "door.refusal_spike";
    public const string TopUpFailed = "topup.failed";
    public const string WebhookAutoDisabled = "webhook.auto_disabled";
    public const string ScheduleConflict = "schedule.conflict";
    public const string OverdraftAuthorised = "booking.overdraft_authorised";
    public const string AdminRoleChanged = "admin.role_changed";
    public const string CodeForgerySuspected = "code.forgery_suspected";
    public const string CodesCapabilityLost = "device.codes_capability_lost";

    /// <summary>How the payloads are written and read. Snake_case, invariant, no indentation.</summary>
    public static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
    };

    /// <summary>Every kind, in the order a settings screen lists them.</summary>
    public static readonly IReadOnlyList<AdminEventKind> All =
    [
        new(MemberRegistered, "New membership applications",
            "Somebody has applied to join and is waiting for approval."),
        new(ApplicationsPending, "Applications still waiting",
            "A daily reminder while any application has waited longer than the club's reminder threshold."),
        new(DeviceOffline, "Court box or door stopped reporting",
            "A board the club has acknowledged has gone silent."),
        new(DeviceRecovered, "Court box or door back online",
            "A board you were told about is reporting again."),
        new(FaultSpike, "Many device faults at once",
            "Several different faults opened across the club's boards inside the club's window."),
        new(RefusalSpike, "A door turning people away",
            "One door refused more scans than the club's threshold inside its window."),
        new(TopUpFailed, "Top-ups that need looking at",
            "A card payment failed for a reason the club has to deal with — not a decline or a cancellation."),
        new(WebhookAutoDisabled, "Webhook switched off",
            "A club webhook failed too many times, or points somewhere it may not, and has been switched off.",
            Security: true),
        new(ScheduleConflict, "Repeating booking clashes",
            "A repeating booking could not take a court-time because a member already holds it."),
        new(OverdraftAuthorised, "Bookings below zero",
            "Another administrator booked a court that took a balance below zero."),
        new(AdminRoleChanged, "Administrator changes",
            "Somebody was made an administrator, or stopped being one.",
            Security: true, NotifiesSubject: true),
        new(CodeForgerySuspected, "Suspected forged codes",
            "A board accepted a code this club could not have issued.",
            Security: true),
        new(CodesCapabilityLost, "A board stopped reading member codes",
            "After the club switched to member codes, a board reported firmware that does not check them offline."),
    ];

    private static readonly Dictionary<string, AdminEventKind> ByKind =
        All.ToDictionary(k => k.Kind, StringComparer.Ordinal);

    /// <summary>The catalogue entry for a stored kind, or null for one this build does not know.</summary>
    public static AdminEventKind? Find(string kind) => ByKind.GetValueOrDefault(kind);

    /// <summary>True when <paramref name="kind"/> is in the catalogue and may not be opted out of.</summary>
    public static bool IsSecurity(string kind)
    {
        // Block body: lizard reads a property pattern's brace in an expression body as the end
        // of the function (memory/gotchas-build.md).
        return Find(kind) is { Security: true };
    }

    /// <summary>
    /// The message one reader gets for one row. A table of composers rather than a switch, so
    /// adding a kind is one line and the method's branch count does not grow with the catalogue.
    /// </summary>
    public static EmailMessage Compose(AdminMailContext c)
    {
        if (!Composers.TryGetValue(c.Row.Kind, out var compose))
        {
            throw new InvalidOperationException($"no message for admin notice kind '{c.Row.Kind}'");
        }
        return compose(c);
    }

    private static readonly Dictionary<string, Func<AdminMailContext, EmailMessage>> Composers = new(StringComparer.Ordinal)
    {
        [MemberRegistered] = ComposeRegistration,
        [ApplicationsPending] = ComposeApplicationsPending,
        [DeviceOffline] = c => ComposeOutage(c, recovered: false),
        [DeviceRecovered] = c => ComposeOutage(c, recovered: true),
        [FaultSpike] = ComposeFaultSpike,
        [RefusalSpike] = ComposeRefusalSpike,
        [TopUpFailed] = ComposeTopUpFailed,
        [WebhookAutoDisabled] = ComposeWebhookDisabled,
        [ScheduleConflict] = ComposeScheduleConflict,
        [OverdraftAuthorised] = ComposeOverdraft,
        [AdminRoleChanged] = ComposeAdminRole,
        [CodeForgerySuspected] = ComposeForgery,
        [CodesCapabilityLost] = ComposeCodesCapabilityLost,
    };

    /// <summary>The baseline wording, unchanged: this is the registration notice that used to be sent directly.</summary>
    private static EmailMessage ComposeRegistration(AdminMailContext c)
    {
        var p = c.Payload<RegistrationPayload>();
        return EmailTemplates.AdminNewRegistration(c.Club, c.To, p.FullName, p.Email, p.MembershipNumber, c.ConsoleUrl);
    }

    private static EmailMessage ComposeApplicationsPending(AdminMailContext c)
    {
        var p = c.Payload<ApplicationsPendingPayload>();
        return EmailTemplates.AdminApplicationsWaiting(c.Club, c.To, new ApplicationsWaiting(p.Count, p.OldestName, p.OldestHours, c.ConsoleUrl));
    }

    /// <summary>The four outage templates the peripheral sweep used to send directly, chosen exactly as it chose them.</summary>
    private static EmailMessage ComposeOutage(AdminMailContext c, bool recovered)
    {
        var p = c.Payload<DeviceOutagePayload>();
        if (p.IsGate)
        {
            var gate = new GateAlert(p.DeviceName, p.DeviceCode, p.GateKey, p.Minutes, c.ConsoleUrl);
            return recovered
                ? EmailTemplates.AdminGateRecovered(c.Club, c.To, gate)
                : EmailTemplates.AdminGateUnhealthy(c.Club, c.To, gate);
        }

        var box = new PeripheralAlert(p.DeviceName, p.DeviceCode, p.CourtNumbers, p.Minutes, c.ConsoleUrl);
        return recovered
            ? EmailTemplates.AdminPeripheralRecovered(c.Club, c.To, box)
            : EmailTemplates.AdminPeripheralUnhealthy(c.Club, c.To, box);
    }

    private static EmailMessage ComposeFaultSpike(AdminMailContext c)
    {
        var p = c.Payload<FaultSpikePayload>();
        return EmailTemplates.AdminFaultSpike(c.Club, c.To, new Email.FaultSpike(p.Faults, p.Minutes, p.Boards, c.ConsoleUrl));
    }

    private static EmailMessage ComposeRefusalSpike(AdminMailContext c)
    {
        var p = c.Payload<RefusalSpikePayload>();
        return EmailTemplates.AdminDoorRefusalSpike(
            c.Club, c.To, new DoorRefusalSpike(p.DoorName, p.DeviceCode, p.GateKey, p.Refusals, p.Minutes, c.ConsoleUrl));
    }

    /// <summary>The club's money symbol is resolved at delivery from the club's own settings, never frozen on the row.</summary>
    private static EmailMessage ComposeTopUpFailed(AdminMailContext c)
    {
        var p = c.Payload<TopUpFailedPayload>();
        return EmailTemplates.AdminTopUpFailed(c.Club, c.To, new TopUpFailure(
            p.Reason, p.AmountZar, p.MemberName, p.Reference, CurrencySymbol.For(c.Settings), c.ConsoleUrl));
    }

    private static EmailMessage ComposeWebhookDisabled(AdminMailContext c)
    {
        var p = c.Payload<WebhookDisabledPayload>();
        return EmailTemplates.AdminWebhookDisabled(
            c.Club, c.To, new WebhookDisabled(p.Destination, p.Description, p.Failures, p.Blocked, c.ConsoleUrl));
    }

    private static EmailMessage ComposeScheduleConflict(AdminMailContext c)
    {
        var p = c.Payload<ScheduleConflictPayload>();
        return EmailTemplates.AdminScheduleConflict(
            c.Club, c.To, new ScheduleConflictNotice(p.ScheduleName, p.FirstDate, p.Collisions, p.Dates, c.ConsoleUrl));
    }

    private static EmailMessage ComposeOverdraft(AdminMailContext c)
    {
        var p = c.Payload<OverdraftPayload>();
        return EmailTemplates.AdminOverdraftAuthorised(c.Club, c.To, new OverdraftNotice(
            p.ActorName, p.MemberName, p.Self, p.CourtName, p.StartsAtLocal, p.AmountCredits, p.BalanceAfterCredits, c.ConsoleUrl)
        {
            HeldCredits = p.HeldCredits,
        });
    }

    /// <summary>
    /// The three admin-rights messages the P2 notifier used to send directly: the subject's own,
    /// granted or revoked, and every other administrator's notice.
    /// </summary>
    private static EmailMessage ComposeAdminRole(AdminMailContext c)
    {
        var p = c.Payload<AdminRolePayload>();
        var change = new AdminRoleChange
        {
            SubjectName = p.SubjectName,
            ActorName = p.ActorName,
            Granted = p.Granted,
            Reason = p.Reason,
            ConsoleUrl = c.ToSubject ? $"{c.BaseUrl}/admin/members" : c.ConsoleUrl,
        };

        if (!c.ToSubject) return EmailTemplates.AdminRoleChangedNotice(c.Club, c.To, change);
        return p.Granted
            ? EmailTemplates.AdminRoleGranted(c.Club, c.To, change)
            : EmailTemplates.AdminRoleRevoked(c.Club, c.To, change);
    }

    private static EmailMessage ComposeForgery(AdminMailContext c)
    {
        var p = c.Payload<ForgeryPayload>();
        return EmailTemplates.AdminCodeForgerySuspected(c.Club, c.To, new ForgeryNotice(p.DeviceCode, p.MemberName, p.Detail, c.ConsoleUrl));
    }

    private static EmailMessage ComposeCodesCapabilityLost(AdminMailContext c)
    {
        var p = c.Payload<CodesCapabilityLostPayload>();
        return EmailTemplates.AdminBoardLostMemberCodes(
            c.Club, c.To, new BoardLostMemberCodes(p.DeviceName, p.DeviceCode, p.FirmwareVersion, c.ConsoleUrl));
    }
}
